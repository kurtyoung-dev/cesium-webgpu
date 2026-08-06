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

Publication update: the 2026-07-23 HTTP-403 attempt below is historical. As of
the 2026-07-31 audit, local `main` and `origin/main` are equal at Batch 771
(`fe990ab335`) [that audit's changeset landed as Batches 772-781 on 2026-08-01,
`origin/main` = `3900608bb9`]. No runtime gate may be bypassed merely because
later work is present in the tree, landed or not.

Campaign 13 supersedes **only** Campaign 11's `clouds-weather` execution cluster. It does not close
Campaign 11's unrelated open work. Campaign 12 launched on 2026-07-23 and is
executing independently; Campaign 13 does not close or renumber it.

Operating model: **ORCHESTRATOR**. One worker implements a bounded slice and returns a verified dirty
tree; an independent reviewer checks the actual diff and evidence; only the orchestrator lands it and
updates this ledger.

**EXECUTOR RULING (maintainer, 2026-07-24, recorded Batch 758): the orchestrator (Claude Fable/Opus
workers) owns ALL Campaign 13 execution — Option B.** Sol 5.6's dispatch lane is closed; the
maintainer will handle any future re-partitioning. If Sol returns and leaves uncommitted work in the
tree, it is taken over, independently verified, and landed under orchestrator review (the Batch
743/754 takeover protocol). The C13 dispatch freeze is LIFTED. The mechanics in
`campaign11_planning/guides/G10-charter-mechanics.md` remain the process reference.

### 2026-08-02 Codex audit + rendered-tail overlay

`C13-08` and `C13-GATE-B` remain **IN PROGRESS / NO-GO FOR COMPLETE
PROMOTION**. The Batch-806 WebGPU regional-placement pixel lane remains green,
as does the retained regional-tail evidence described below. The current
worktree adds the CoverageJSON antimeridian parser correction (7/7 focused
mutation lane; 38/38 with the expanded bounds suite), the persistent
rendered-tail probe, and the independent promotion audit's regional
cell-registration correction: non-wrapped continuous source coordinates now
clamp before their interpolation fractions are derived, preventing west/north
extrapolation and a diagonal observation leaking into a no-data corner. The
focused bounds suite is 31/31, including mutation-sensitive W/E/N/S and no-data
edge cases. The retained rebuilt Edge run of
`probe-weather-regional-tails.mjs` passed every WebGPU cyclic-seam and WebGL
regression arm: both ±180° sides observed, seam halves continuous with no
centre wall or duplicate band, far view byte-identical to procedural fill,
non-vacuous regional pack statistics, unchanged WebGL billboard pixels,
zero WebGL volumetric publication, and zero device/console/page errors. All ten
PNGs were visually reviewed; the 100%-coverage regional fixture is intentionally
overcast on both seam sides, has no seam wall, and the far and WebGL control
pairs are byte-identical. That evidence is retained rather than erased, but it
does not replace the seven browser regressions still required by the checklist:
the five global ingest/source/channel/time probes, the seam/pole probe, and the
intended-behaviour METAR probe have no post-Batch-797 evidence. Canonical
COMPLETE promotion requires those seven green reruns after the packer change,
followed by orchestrator/maintainer review and landing.

Do not mint a duplicate task ID. The parser defect belongs to `C13-08` and is
fixed in the current worktree:
`CoverageJsonParser` derives longitude bounds with ordinary numeric min/max, so
a cyclic axis such as `170, 175, 180, -175, -170` becomes an almost-global span
instead of a wrapped 20-degree region even though `WeatherTexPacker` correctly
handles explicitly supplied wrapped bounds. It now unwraps the source axis
before deriving both orientation and bounds; forward/reverse seam encodings
canonicalize to the same interval while ordinary/global bytes are preserved.
A manually supplied `170°E → 170°W` packer fixture still cannot close the owed
rendered parser lane.

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
| `C13-38` | Suppress cloud-IBL environment refreshes while full cloud IBL is irrelevant | P0 | perf/correctness | S | W2 | `C13-37` |
| `C13-39` | Hoist density LOD/domain transforms out of per-sample view, light, shadow, and IBL loops | P0 | perf/architecture | L | W2 | `C13-02`, `C13-37` |
| `C13-40` | Async cloud-noise prewarm plus generation-keyed reconstruction resources and retirement | P1 | perf/architecture | M | W2 | `C13-02`, `C13-37` |
| `C13-41` | C12-29 S3 rider: eclipse-driven cloud lighting, cloud shadow, and IBL dimming/refresh | P1 | correctness/quality | M | W2 | `C13-GATE-B`, `C13-06`, `C13-38`; informed by `C13-39` |
| `C13-GATE-A` | Launch and evidence-truth gate | R0 | gate | S | W0 | `C13-01`, `C13-02`, `C13-35` |
| `C13-GATE-B` | Planetary correctness gate | R0 | gate | M | W1 | `C13-03..08` |
| `C13-GATE-C` | Temporal reconstruction and measured-performance gate | R0 | gate | M | W2 | `C13-09..13`, `C13-36..41` |
| `C13-GATE-D` | Regional weather realism gate | R0 | gate | M | W3 | `C13-14..20` |
| `C13-EXIT` | Feature-preserving cloud certification | R0 | gate | L | EXIT | Gates A-D, selected W4/W5 owners |

---

## 2. Confirmed current-state findings

These findings are the frozen launch premise, not the live completion ledger. Every implementation
brief must re-grep the named symbols and reproduce its premise at execution HEAD before changing
code. Section 9 and the dated evidence subsections are the current execution authority when later
Campaign 13 work supersedes a launch-time finding.

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

`C13-12` builds on `C13-05`'s coarse history-compatibility contract and owns attachment-aware
motion/depth rejection, variance clipping, reactive history, wind advection in reprojection,
disocclusion, and weather/density changes that require the reconstruction attachments from
`C13-09/10`. Coarse frame-gap, teleport, scene/projection, morph, temporal re-entry, deck, and
multi-deck topology resets are already owned by `C13-05`.

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

`C13-38` closes the post-`C13-37` cloud-IBL invalidation leak. A cloud appearance revision must not
launch the full environment-cube fill, prefilter, and SH projection while neither the current nor the
previous environment state used the full cloud march. The prior-full-march case remains relevant so
an ON-to-OFF transition still performs its one teardown refresh, and revisions accumulated while
opted out must be consumed when the user later opts in. This is an execution suppression only: it
does not weaken visible clouds, reflection quality, coverage-only IBL, or any public feature.

`C13-39` owns the steady-state ALU regression risk exposed by the post-`C13-37` hot-path review.
`cloudDensityMipLevels()` currently repeats texture-dimension queries and three `log2` evaluations
inside density taps, while cone lighting, shadow, and IBL paths also repeat the same seeded-domain
matrix transforms per sample. Capture the current shader as the baseline, then precompute the common
footprint logarithm, per-domain bias/clamp bundle, and affine rotated ray/basis coordinates at the
widest safe scope. Defer fine/detail work until a sample is actually occupied. Do not change the LOD
curve, sample thresholds, shadow/cascade count, IBL content, LIVE escape route, or morphology to win
timing. Acceptance requires GPU-timestamp lanes for baked, LIVE, single/cascaded shadow, and IBL,
plus visual/morphology equivalence.

`C13-40` owns first-use and lifetime costs. Noise/mipmap construction currently performs synchronous
module/pipeline creation and all bake/downsample passes from the first visible render; reconstruction
passes also need generation-keyed bind-group retention and post-submit retirement. Prewarm
asynchronously after exact formats/topology are known, publish readiness explicitly, and retain the
existing fallback until the new generation is ready. `C13-05` may remove its independently proven
per-frame temporal bind-group allocation now; that bounded hot-path correction does not close this
broader task.

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
| `C13-00` | **COMPLETE — Batch 732 (`f4a934e606`)** | Explicit 2026-07-23 maintainer launch authority; C11 transfer map and confirmed findings recorded here; TypeScript, Markdown lint, and Prettier passed. Local `main` contains the launch commit. The original HTTP-403 publication note is historical; `origin/main` now reaches Batch 771. |
| `C13-01` | **IN PROGRESS — Batches 733–735 evidence follow-up (2026-07-23)** | Batch 733 repaired unified API/config truth, deterministic offline/fixed-time capture, raw-frame metrics, backend-aware workload selection, and the moving WebGPU route. Batch 734 requires an actual procedural execute plus initialized cache/pipeline instead of trusting a loaded lazy handle or fixed warm-up count; the procedural tour now uses same-camera OFF/ON contribution for colored pole/dusk fixtures. The stale `cloudQuality=128` blank claim is superseded by 128/8 full-resolution work with 7,584 cloud cells; Batch 735 supersedes the pre-fix north-pole blank with green WGS84 evidence. Climate/region/type/same-type fixtures, wind/time and temporal-reset sequences, complete per-sequence metrics, and GPU timing remain. **2026-08-01: the Batch-790 fixture/sequence tour EXECUTED (calibration + confirmation runs, both lanes): 12/12 fixtures and 6/6 sequences GREEN. Calibration resolved four first-run reds: a discarded warm-up now precedes the fixture loop (the async prewarm cold-start rendered fixture 1 stable-black at meanLum 3.3 vs 50-145 warmed); the open-cell floor recalibrated 0.03->0.012 against measured 0.017; the clouds-on reset expectation corrected to FRAME_GAP (a full toggle records no deactivation frame; REACTIVATED is reserved for a temporal-tier toggle - open follow-up phase). TWO REAL GAPS pinned by knownGapId ceiling gates that fail loudly when closed: CIRRUS renders ~nothing (C13-16 per-genus unbuilt) and CLOUD-LOW-COVERAGE-CUTOFF (coverage <=0.40 renders zero cloud - isolated single-variable sweep; every fair-weather sky renders clear; DEFERRED_WORK entry with acceptance).** |
| `C13-02` | **PARTIAL** | `C13-39` landed byte-inert GPU timestamp wiring for all seven cloud render passes plus environment Sky Fill. Broader cloud CPU/GPU counters and the repaired-tour measurement surface remain open; pass timing alone does not close this row. |
| `C13-03` | **COMPLETE — Batch 735** | The active WGS84/RTE coordinate contract, f32-faithful source/math suite, and provenance-bearing moving planetary OFF/ON oracle are landed. The default route is green at 21/21 antimeridian, pole, deck/altitude, regional, and orbit checkpoints with clean WebGPU gates. |
| `C13-04` | **COMPLETE — Batch 735 (primary visible shell only)** | Both one-part and high/low branches intersect WGS84 expanded ellipsoids; production precision defaults on, CPU-f64 cartographic height drives interval/deck ordering, and view/light/midpoint height fractions share the oblate boundaries without growing the then-current 148-float uniform. The density-domain work that remained open at this landing later closed under `C13-37`, and temporal RTE/coarse reset later closed under `C13-05`; shadow/mask/capture/atmosphere and regional-weather consumers remain explicitly open under `C13-06..08`. |
| `C13-05` | **COMPLETE — Batch 754 (bounded W1 RTE/reset slice)** | Perspective temporal reprojection now uses inverse-current and previous view-projection-relative-to-eye transforms, CPU-`f64` camera delta, encoded camera origin, and WGS84 configured-deck intersection without rebuilding raw ECEF `f32`. Allocation-free history classification resets on incompatible frame continuity, teleport, scene/projection mode, morph, temporal re-entry, resource resize, deck topology, and observed cull/re-entry; two temporal parity bind groups are retained across frames. The inverse current RTE transform composes the existing inverse projection with translation-free inverse view, while orthographic/morph frames preserve the live current march and remain current-only until reconstruction carries a per-pixel ray origin. Invalid reprojections return before the 3×3 clamp fetch. `cloud-temporal-rte.spec.mjs` passes `11/11`; the complete cloud spec lane passes `64/64`; `probe-cloud-temporal-rte.mjs` is GREEN with 26 finite 60-float uploads, maximum high/low reconstruction error `0.002723 m`, exact/stable source-build provenance, observed cull/re-entry, and clean WebGPU/device/console gates. This does not close color/depth/velocity/moment attachments, true 1/16 current work, or attachment-aware wind/depth/disocclusion rejection; `C13-09/10/12` remain open. |
| `C13-06` | **IMPLEMENTED + PROBE-VERIFIED (2026-08-01)** | One frame owner (`WebGPUCloudShadowFrame.ts`) now supplies the cloud beer-shadow projection in CPU `f64`: the footprint centre is a WGS84 geodetic surface projection (was a `6378137` m sphere — up to `21,385 m` off radially at the poles, more than eight deck thicknesses), and both the forward and inverse sun-view matrices are emitted RELATIVE TO A CALLER-SUPPLIED EYE. `cloudShadowMain` reconstructs a camera-relative column, intersects the SAME `cloudShellAxes` expanded-WGS84 boundaries the visible march uses on BOTH its high-precision and explicit-`cloudHighPrecision=false` branches, resolves the height fraction with `ellipsoidShellHeightFractionRTE`, and samples density through the new `cloudDensityRelativeWithFootprint` — which reads the C13-37 CPU-`f64` origin phases, retiring the raw-ECEF `cloudDensityCoordinatesAtWorld` route from the live shadow path and making the previously-scaffolded `cloudDensityCoordinatesAtRelative` / `cloudMorphologyCoordinateAtRelative` live. All three shadow consumers (globe terrain, aerial-perspective inscatter, volumetric-fog hi-fi) now project a camera-relative operand — `v_positionRTE`, `rayDir * eyeDistance`, `froxelOffsetFromCamera(gid)` — instead of `vp * vec4(fullEcefPosition, 1.0)`. `CloudShadowUniforms` stays 20 floats and the cascade stride stays 64 floats: only the matrix SEMANTICS changed. Measured f32 projection error over the footprint: `0.0019 m` at ground / `0.0053 m` at 20 km / `0.029 m` at 800 km / `0.54 m` at 18,000 km, versus a flat `0.259 m` for the retired absolute form — better at every altitude sampled. `cloud-shadow-rte.spec.mjs` passes `17/17` (including a cross-validation of the owner's geodetic projection against `Ellipsoid.WGS84.scaleToGeodeticSurface` to `2.1e-9 m` over 280 lat/lon/altitude samples); the full cloud spec lane is `81/81`; `npx tsc --noEmit` is clean; naga validates all four touched shaders. Feature preservation: no cloud feature removed or default-disabled; the `cloudHighPrecision=false` A/B route and the planar-scene-mode absolute matrix are both retained (a new `cloudShadowCascadeParams.y` flag selects the operand, so 2D/CV/morph are byte-identical). Already-compliant consumers were verified and pinned, not rewritten: the god-ray mask inherits the primary frame through `marchDeck` + the shared per-frame bind group, and environment capture already reads the shared origin phases at a geodetic capture radius. **Not closed here:** the god-ray mask's duplicate full-resolution `marchDeck` (audit 2.9 — needs the `C13-09` reusable-transmittance attachment), and the volumetric fog's DEFAULT local-fbm cloud approximation, which is a different density field with its own sphere and remains `C13-22`/`C13-09` work. Orchestrator probe run 2026-08-01: `probe-cloud-shadows-flagon/cascades/parity` green (cascades PASS explicit, 0 console errors), and the NEW `probe-cloud-shadows-polar.mjs` at 82N shows ground-band delta 37.2 (ON 23.6 / OFF 60.8) with PNGs read — the polar cast shadow the spherical footprint erased is present. Rollback boundary: `WebGPUCloudShadowFrame.ts`, the `cloudShadowMain` body, `cloudDensityRelativeWithFootprint`, the four consumer projection sites, and `cloud-shadow-rte.spec.mjs`. |
| `C13-07` | **IMPLEMENTED + PROBE-VERIFIED (2026-08-01)** | Bounded global-map seam/pole correction; does **not** replace `C13-14`. Convicted defect, measured on the shipped 256×128 default map: the procedural producer's fBM was aperiodic in `u`, so the two texels that `addressModeU: "repeat"` filters together across ±180° held unrelated values — antimeridian coverage step **max 1.000, mean 0.585** against an interior neighbour step of max 0.336 / mean 0.029, i.e. a full-contrast wall of cloud at the dateline; and both polar rows carried the full 0..1 coverage spread across longitude even though all of those longitudes collapse to one point, so the value at the pole depended on the azimuth of approach. Fix: one shared convention module (`Scene/Weather/WeatherMapSeam.ts`) carrying the texel-centre to lon/lat contract, a lattice-wrapping periodic value-noise fBM, and a wrap-aware latitude-dependent longitudinal low-pass; the default producer moved out of the renderer into `Scene/Weather/ProceduralWeatherMap.ts` so it and `WeatherTexPacker` cannot drift apart; the packer now resamples at texel centres and runs the same polar filter; `worldToWeatherUV` gained an `atan2(0,0)` spin-axis guard. Post-fix antimeridian step **max 0.067, mean 0.010** — below the interior *mean* — both polar rows single-valued, and the low-pass is an exact byte identity below 59° latitude so mid-latitude content and every existing weather probe are unchanged. `Tools/visual-regression/weather-map-seam.spec.mjs` 17/17; engine `tsc --noEmit` adds no error; ESLint and Prettier clean. Orchestrator pixel gate `probe-weather-seam-poles.mjs` green 2026-08-01: on-seam view at 0.7N (both seam sides cloudy in the twin) shows hemisphere halves 52.3/52.9 with the meridian column step (0.6) BELOW the frame's own p95 (1.9); pole sector means show no pinwheel (maxDev 9.4 N / 65.0 S vs means 162.8/115.4) and no atan2 garbage cluster; PNGs read. Probe authoring surfaced three instrument lessons now recorded in DEBUGGING_GUIDE (camera-local cloud patch at orbit altitudes, per-view local-noon clock, async-prewarm warmup discard). Residual, explicitly `C13-14`: equirectangular is still the parameterization, so 59–90° keeps a roughly 4× steeper ground-space gradient than the equator, the polar cap is a hard row mean rather than a real cap tile, and there are still no gutters, bounds, no-data, or LOD. |
| `C13-08` | **IN PROGRESS / NO-GO FOR COMPLETE PROMOTION — REGIONAL PACKING, CYCLIC PARSING, AND RETAINED REGIONAL TAILS GREEN; SEVEN BROWSER REGRESSIONS OWED** | Bounds / no-data / regional packer contract; the LAST Gate B row. Focused cyclic parser/mutation lane 7/7 and parser+bounds lane 38/38. The retained rebuilt Edge regional-tail acceptance is green: both seam sides render continuously with no centre wall or duplicate band, the far view is byte-identical to procedural fill, WebGL billboard pixels are unchanged with zero volumetric publication, error arrays are empty, and all ten PNGs were reviewed. The independent audit also fixed a regional CELL edge-clamp defect with W/E/N/S and diagonal no-data guards. Canonical COMPLETE remains blocked until the five global ingest/source/channel/time probes, seam/poles, and METAR are rerun after that packer change; landing review alone is insufficient. **Premise (confirmed, audit 2.5):** `WeatherTexPacker` assumed every field spanned the texture, so a regional EDR/WCS/METAR field was stretched over the whole planet; `CoverageJsonParser` turned a `null` range value into `0` and `MetarWeatherSource` turned "no station within the influence radius" into `0`, i.e. both fabricated an OBSERVED CLEAR SKY out of an absence of data; and C13-07 explicitly deferred the source-grid coordinate reference to this row. **Contract (one home — `Scene/Weather/WeatherFieldGrid.ts`):** (1) a `WeatherField` grid is NODE-CENTRED (gridline-registered) by default — `bounds.west/north` are the coordinates OF column 0 / row 0 — with a declarable `"cell"` (pixel-registered) alternative; chosen because it is what the shipped packer already did (so the global path stays byte-identical), because CoverageJSON `domain.axes` carry sample COORDINATES and the GFS/GDPS model output behind them is gridline-registered, and because only a node-centred global grid actually has a sample AT the pole, which C13-07's polar low-pass assumes. The TEXTURE stays cell-centred (C13-07); the packer converts between the two registrations explicitly instead of conflating them. (2) A texel is NO-DATA when it falls outside `bounds` or when every contributing cell is no-data (`NaN` always, plus an optional declared `noDataValue`); coverage carries the validity for the whole cell. (3) No-data texels are written from a typed `WeatherNoDataFill` — `"procedural"` by DEFAULT (the same bytes the renderer already shows with no provider, the only fill that is continuous with the no-provider case and cannot be read as an observation) or an explicit `"constant"` quad; precedence packer-option > field > default. (4) Wrap-awareness engages exactly where it is REACHABLE — a cell-registered full-circle field — which is the case C13-07 correctly said did not exist under node registration. **Files:** `Scene/Weather/WeatherFieldGrid.ts` (new, the contract), `WeatherTexPacker.ts` (bounds placement + validity-weighted resample + fill + `packWeatherFieldDetailed` stats), `WeatherTypes.ts` (`registration` / `noDataValue` / `noDataFill` / `priority`, the last DECLARED for `C13-20` and explicitly not yet consumed), `WeatherProvider.ts` (`setNoDataFill` / `getNoDataFill` / `getPackStats`), `CoverageJsonParser.ts` (bounds derived from `domain.axes` with the requested bbox as fallback; `null` → no-data), `MetarWeatherSource.ts` (out-of-radius → no-data), `SyntheticWeatherSource.ts` (honours a regional `request.bounds`), `WeatherMapSeam.ts` (defers to the new module), `scripts/build.js` (public surface). **Evidence:** new `Tools/visual-regression/weather-field-bounds.spec.mjs` 31/31, which carries the pre-C13-08 packer inline as BOTH a byte-identity oracle and a defect oracle — a global field packs byte-for-byte identically to the old code across ramp/rich/uniform/coarse fixtures, while the SAME oracle is shown anchoring a CONUS ramp at lon −180 and reading its midpoint at lon 0 (the stretch), against which the fixed packer changes >50% of texels and fills lon 0 from the procedural map. Antimeridian-straddling bounds (170°E→170°W) pack identically whether east is written `-170°` or `190°`. `weather-map-seam.spec.mjs` still 17/17; the complete cloud spec lane is 132/132 and the cloud+weather lane 176/176; the full pure-Node spec suite is 691/691. Root `npx tsc --noEmit` clean; `tsc --project packages/engine/tsconfig.json` adds no error (its 134 pre-existing `TS2307`s are all missing generated `Shaders/**/*.js` in an unbuilt worktree, none in `Scene/Weather`); Prettier and ESLint clean on every touched file. **Functionality preservation:** the default global node-registered path is byte-identical by test; only the previously incorrect cell-registered outer half-cells change, the procedural producer is untouched, `weatherTexBounds` stays global, and the committed `/mock-edr` + `/mock-wcs` fixtures are asserted to still derive EXACTLY the global rectangle so those probes are unchanged. Two INTENDED behaviour changes, both the point of the row: a CoverageJSON `null` and a METAR out-of-radius cell now render as the procedural fill instead of a fabricated clear hole. **Not closed here:** the observed/fill boundary is a hard one-texel edge (feathering + multi-source priority composition is `C13-20`, which is why `priority` is declared but unread), and there are still no per-tile bounds, gutters, atlas, or LOD (`C13-14`). **Rollback boundary:** `Scene/Weather/WeatherFieldGrid.ts`, the `WeatherTexPacker` body, the four source/provider edits above, and `weather-field-bounds.spec.mjs`. **Orchestrator probe checklist is in the C13-08 section below.** |
| `C13-09` | NOT STARTED | Reconstruction attachment topology. |
| `C13-10` | NOT STARTED | True 1/16 current work and full-resolution history. |
| `C13-11` | **BLOCKED** | Needs a provenance-approved, license-clean STBN generation/import plan and notices. NVIDIA STBN assets are prohibited. Does not block W1. |
| `C13-12` | NOT STARTED | Opens after reconstruction topology and current-work layout. `C13-05` now supplies the coarse compatibility/reset generation; this task retains attachment-aware wind/weather/depth rejection, disocclusion, variance clipping, and reactive history. |
| `C13-13` | NOT STARTED | Lighting/spatial-tier separation still follows reconstruction topology. The old 128-step blank was command-empty scheduling/readiness, not a raymarch-tier failure; fresh visible evidence is clean but has no comparable adaptive/fixed companion and therefore proves no speedup. |
| `C13-14` | NOT STARTED | Promoted C11 planet-scale tiling seed; core W3 architecture. |
| `C13-15` | NOT STARTED | Climate prior; distinguish climatology from current observations. |
| `C13-16` | **PARTIAL — per-genus MORPHOLOGY slice IMPLEMENTED and LANDED Batch 826 (2026-08-06), Edge acceptance owed. Regional MIXTURES remain NOT STARTED (blocked on `C13-14`/`C13-15`, both NOT STARTED).** | **Premise (confirmed):** `Scene/CloudTypeProfile.js` has carried five axes per WMO genus since Weather Phase 0, and TWO of them reached no renderer at all — the FIBROUS/PUFFY `erosion` style and the Henyey-Greenstein `phaseG`. A genus therefore differed only in deck, height-gradient shape (`profileShape`@101), density scale (`profileDensityScale`@102), and extinction (`profileExtinction`@103), so CIRRUS rendered as a faint SCALED-DOWN CUMULUS. That is exactly what the C13-01 tour recorded: after `CLOUD-LOW-COVERAGE-CUTOFF` restored cirrus VISIBILITY on 2026-08-01, `northatlantic-cirrus-fibratus`'s gate note still read "Genus MORPHOLOGY (fibrous streaks vs generic puffs) remains C13-16". **Morphology model:** cirriform cloud is ice precipitating from small generating cells near the tropopause; crystals fall at ~0.3-1 m/s through a layer whose horizontal wind changes strongly with height (jet-stream shear of order 5-20 m/s per km), so each crystal is advected downstream as it descends and the deck is drawn into long streaks trailing beneath and downwind of the head. Three consequences are now modelled: (1) ANISOTROPY — `genusFibreFactor` divides ONLY the along-wind axis of its Worley domain by the genus aspect ratio, so isotropic cells read as filaments that many times longer along the wind than across (observed cirrus runs 5:1 to 20:1); (2) FALLSTREAK TILT — the along-wind coordinate is displaced by `(1 - h) * shear`, so the streak's lower end lags its generating head at the deck top; (3) PHASE — `genusForwardG` offsets the HG forward lobe by `profile.phaseG - CUMULUS.phaseG`, because hexagonal ice plates/columns scatter far more forward-peaked (g ~ 0.88-0.9) than liquid droplets (~0.76-0.78), clamped at 0.95 so the HG denominator never approaches its singularity. A fourth lever, `genusErosionHeightWeight`, blends the subtractive detail erosion's `1 - h` base weighting toward uniform: cumuliform base-weighting models a convective water cloud's ragged bottom and crisp top, and ice has no such buoyant asymmetry. **Architecture:** the fibre factor is a FOURTH link in the existing `mammatus × species × feature` `[0,1]` chain, not a second chain — those three are OPT-IN user selections of a supplementary feature/species on top of a genus, this one is the genus's own baseline character read from the profile table, and the WMO hierarchy (genus → species) is exactly that composition. It is applied IDENTICALLY in `legacyCloudDensity`, `legacyCloudBaseDensity`, and `cloudMacroSampleAt`'s shared `factor`, so the W5 `base >= full` empty-space-skip invariant holds structurally and the beer-shadow producer (which reads `cloudDensityRelativeWithFootprint` → `cloudMacroSampleAt`) tracks the visible march. A domain WARP was rejected as the lever: the C13-37 shape/warp/detail coordinates are seeded-SO(3)-rotated and `fract`-wrapped, so an anisotropic map on them would break both the wrap and the frozen domain contract — which is precisely why every existing morphology feature is a mask. **Files:** `Scene/CloudTypeProfile.js` (+`FIBRE_MORPHOLOGY` table + `getFibreMorphology`; `.d.ts` updated), `Shaders/WebGPU/Environment/ProceduralClouds.wgsl` (`genusFibreFactor` / `genusErosionHeightWeight` / `genusForwardG` + 4 uniform slots + 6 call sites), `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` (`CLOUD_GENUS_MORPHOLOGY_FLOATS = 4`, `CloudUniforms` 168→**172** ADD-ONLY with every earlier offset frozen). **No new public dial:** `cloudType` remains the single selector and the values live in the JS-authoritative table. **Evidence:** new `Tools/visual-regression/cloud-genus-morphology.spec.mjs` 21/21 with a CPU twin (`lib/cloud-genus-morphology-model.mjs`) that imports the shipped table rather than restating it. Metrics are STRUCTURAL, never band means (the campaign's recorded trap): correlation length along wind ÷ across wind recovers the authored aspect (cirrus 8.10 vs authored 9, cirrostratus 4.65 vs 5, cirrocumulus 1.95 vs 2) and a top-vs-base cross-correlation recovers the authored shear (0.900/0.360/0.140 vs 0.9/0.35/0.15). Falsifiability confirmed by running the suite against deliberately broken trees: flattening the shipped cirrus row's anisotropy/shear to `(0.6, 1.0, 0.0)` turns 5 tests RED, and deleting `/ aspect` from the WGSL turns the wiring test RED. Byte-neutrality is asserted with `assert.equal` and no tolerances at every level (identity row exactly `0/1/0`, phase delta exactly `0`, factor exactly `1`, erosion weight exactly `fround(1 - h)`, `genusForwardG(g, 0) === g`) and each WGSL guard is an explicit early return, mutation-checked. Full pure-Node lane **1357 pass / 4 fail**, where all four failures are the pre-existing bare-worktree `ERR_MODULE_NOT_FOUND` on generated `Shaders/**/*.js` (`model-native-pipeline-stage-tax`, `moon-normal-strength-policy`, `moon-webgl-mip-policy`, `webgpu-snap-framebuffer-lifecycle`) and are unrelated. Naga validates the combined `CloudDensityDomain + ProceduralClouds` source. `tsc --project packages/engine` adds no error (134 pre-existing `TS2307`, non-`TS2307` = 0); root `npx tsc --noEmit` clean; Prettier and ESLint clean per file. `cloud-density-domain.spec.mjs`'s frozen legacy hashes were re-frozen with the reason recorded, and `legacyBakedBase` deliberately keeps its original hash, which is what proves the re-freeze was scoped to the morphology chain. **Functionality preservation:** no feature removed or default-disabled; WebGL is untouched (`ProceduralClouds.wgsl` is fork-only per `SHADER_PAIRS_LOCKSTEP.md`, and the billboard `CloudCollection` renders genus-agnostic puffs by documented design, so no lockstep row is owed). **NOT closed here:** the row's canonical scope — converting region and synoptic signals into per-REGION mixtures of types and vertical decks — needs the `C13-14` weather quadtree and the `C13-15` climate prior, both NOT STARTED; today the genus is still one collection-level value for the whole planet, which is the failure the wave prose names. Also open: a per-genus SPECIES default (cirrus still needs an explicit `cloudSpecies: "fibratus"` for the finer filament tier), and `C13-21`'s multi-layer morphology. **Do NOT self-promote:** Edge acceptance owed, checklist below. **Rollback boundary:** the `FIBRE_MORPHOLOGY` table, the three WGSL functions and their six call sites, the 168-171 uniform row, and `cloud-genus-morphology.spec.mjs`. |
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
| `C13-36` | **COMPLETE — Batch 736** | The existing tier-owned `jitterEnabled` contract now drives a license-clean analytic IGN phase once per fragment. T1/T2 animate only with realized temporal history; full-resolution T3 holds a deterministic spatial phase; the power-user escape path remains exact midpoint. Six source/math/Naga checks, low/high browser artifacts, the moving altitude route, temporal smoke, and WebGL billboard parity are green. This did not close periodic baked density (`C13-37`), mask/history alignment (`C13-06`/`C13-22`), or advanced attachment-aware rejection (`C13-12`); coarse temporal RTE/reset subsequently closed under `C13-05`. |
| `C13-37` | **COMPLETE — Batch 743 (gate GREEN, confirmed twice bit-identically)** | Landed: Slice A (planet-stable density domain: `WebGPUCloudDensityDomain.ts` + `CloudDensityDomain.wgsl` + `ProceduralClouds.wgsl` integration, 148→168-float add-only uniform tail) + Slice B (3D noise mip chains `CloudNoiseMipmap.wgsl`/`WebGPUCloudNoiseResources.ts` + footprint-aware LOD in both consumers) + the IBL-parity leg (`WebGPUDynamicEnvironmentMapManager` capture parity + revision/scene-clock invalidation, now quantization-debounced at the publish side so animated `cloudCoverage` cannot refill every frame). **RED→GREEN root cause:** the three "independent" SO(3) domain rotations shared m22≈−0.427 (Shoemake m22=2·u1−1; adjacent xorshift32 seeds → correlated first draws); the correlated WARP draw aligned the ~1 km warp-texel lattice 3.0° from screen-horizontal at the near-horizon camera — the audit's visible lattice artifact. Fix: warp-only re-draw, penalty-optimized seed 45296 (constants + provenance docs only; shape/detail draws unchanged, layout unchanged, frozen legacy path SHA-intact, RTE untouched). Final gate: near-horizon 0.0918 vs legacy 0.0953 (ratio 0.963, PASS — thin margin, oracle deterministic), above-deck 0.0858 vs envelope 0.0994 (PASS; legacy-ratio 0.496), morphology 4/4 both phases, 52/52 Node specs, PNGs reviewed by worker AND orchestrator. Residual honesty: warp screened against the two acceptance cameras (other geometries have their own projections); shape/detail m22 correlation remains, documented in the module docstring. **Single-batch justification (review defect 4):** the acceptance oracle certified the COMBINED tree; splitting the renderer's interleaved domain/LOD/IBL hunks would create untested intermediate commits (renderer publishing IBL fields no consumer reads). Also lands: watchdogs on all six cloud probes (machine-safety defect 1), `sharp` pinned as a root devDependency + README exception (defect 5), and the review's small-fix list (defects 4a-f). Follow-ups spun out: limb-view `marchDeck` interval gap → the march-redesign tasks; the temporal helper is now consumed by `C13-05`, while shadow/mask/capture integration remains under `C13-06`; WGSL/renderer decomposition is queued under Gate C. |
| `C13-38` | **COMPLETE — Batch 754** | Cloud revisions now request the full environment rebuild only while the current or previous environment state uses the full cloud march: `(wantMarch || lastUsedCloudMarch) && revisionChanged`. Animated visible-only clouds therefore cannot trigger the 256²×6 fill, prefilter, and SH projection while full cloud IBL is opted out. First opt-in, active full-march updates, and ON-to-OFF teardown remain refresh-capable. `cloud-ibl-revision.spec.mjs` passes `4/4`, including 100 inert opted-out revisions; `probe-cloud-ibl-optout-revision.mjs` proves both opt-in cycles and teardown with clean WebGPU/device/console gates. This is eliminated irrelevant work, not a measured FPS claim. |
| `C13-39` | **CLOSED - NEGATIVE RESULT, Batch 762 (2026-07-24).** Instrumentation + baseline LANDED; the optimization itself is REJECTED with the mechanism on record. Two independently-implemented drafts (full hoist set; then a register-light rescope) were each rejected by a drift-controlled interleaved A/B (bundle-swap within one session, reversed-order rounds, byte-identical occupancy fingerprints): the primary straight-route view march regressed +36-54% in BOTH orderings on both drafts, and even the hash-frozen LIVE legacy density route regressed - because WGSL register allocation is STATIC: code compiled into the module inflates every pipeline's register footprint regardless of runtime branches (`lightConeEnabled()` gates execution, not allocation), and the pass is occupancy-bound, not ALU-bound. What LANDED (762): per-pass GPU timestamp wiring for all 7 cloud render passes + the env Sky Fill (`timedCloudPass`/`withComputePassTimestamps`, byte-inert unarmed), `probe-cloud-lod-hoist-perf.mjs` with six workload-verified lanes (bake-readiness render-measure-check, env-map OWNER model - the manager has NO scene-level owner, only Model/Tileset call it - fill attribution, fixed frame-budget clocks) and the MANDATORY interleaved-A/B protocol in its header, plus the banked pre-change baseline manifests. Any future attempt goes through `C13-39B-CLOUD-SHADER-VARIANT-SPLIT` (DEFERRED_WORK): compile cone/straight/shadow/IBL as separate shader variants via the C11-149 hi-word registry so per-route code stops taxing every pipeline - the only vector the evidence supports. |
| `C13-40` | NOT STARTED | First-use bake/prewarm and broader generation/retirement work; the C13-05 temporal parity bind-group cache is a separately bounded partial. |
| `C13-41` | **BLOCKED ON GATE B.** Canonical owner for the C12-29 S3 cloud/IBL rider. Feed the backend-neutral eclipse factor into cloud direct lighting, cloud-shadow response, and a quantized environment-refresh input without latching a stale-dark IBL. Preserve one owner with `C13-06`/`C13-38`; do not fold this into `C13-34`, which concerns cloud shadows contributing to environment maps. `C13-39` proved that runtime-gated extra WGSL can still increase static register pressure, so variant/occupancy measurement is mandatory. |
| `C13-GATE-A` | NOT STARTED | Follows `C13-01/02`. |
| `C13-GATE-B` | **IN PROGRESS / NO-GO FOR PROMOTION — C13-08 BROWSER REGRESSION FLOOR OWED** | `C13-03`, `C13-04`, and `C13-05` are complete. `C13-06` and `C13-07` are implemented and probe-verified. `C13-08` now has a 31/31 CPU twin, the cyclic-axis parser/mutation lane (7/7; 38/38 combined), the regional CELL edge-clamp correction, and the Batch-806 regional-placement pixel pass. The final persistent Edge tail now passes: WebGPU east/west/seam/far cyclic CoverageJSON lanes satisfy continuity, no-wall/no-duplicate, procedural-fill, regional-stat, and clean-device gates; WebGL preserves a non-vacuous billboard control byte-for-byte while issuing zero volumetric publications. Companion tail contracts are 10/10 and all ten PNGs were reviewed. Evidence: `output/weather-regional-tails/manifest.json`. The retained tail evidence remains valid for its node-registered fixture, but promotion to COMPLETE and the formal `C13-41` unblock require post-change green reruns of the five global ingest/source/channel/time probes, seam/poles, and METAR, followed by review and landing. |
| `C13-GATE-C` | NOT STARTED | Follows `C13-09..13` and `C13-36..41`; STBN may remain an explicit blocker if its provenance is unresolved. |
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

### C13-03/04 Batch 735 WGS84 primary-shell evidence

- Root cause: the old equatorial-radius sphere placed the modeled surface about `21.4 km` above
  WGS84 at the poles. A camera authored at geodetic `20,000 m` was classified below ordinary cloud
  decks, selected a far-side interval, and could be entirely erased by terrain depth. Weather was
  disabled and explicit high/low alone did not fix the wrong surface.
- Cloud deck boundaries now use axes `(a+h, a+h, b+h)` for WGS84 `a=6,378,137 m` and
  `b=6,356,752.314245179 m`. The high/low branch intersects those axes camera-relatively; explicit
  `cloudHighPrecision=false` retains a one-part f32 precision A/B while still using correct WGS84
  geometry. Production/default precision is on.
- The renderer reuses uniform slots `62–63` for the polar radius and CPU-f64 cartographic camera
  height; the layout remains exactly `148` floats. Camera/deck classification and multi-deck sorting
  no longer reconstruct altitude from a large f32 ECEF magnitude. View, light, and aerial-midpoint
  height fractions share precomputed oblate inverse axes, keeping division out of density/light
  inner loops.
- Nine source/math tests cover the old polar misclassification, equator, antimeridian, both poles,
  below/inside/above deck, both WGS84 boundaries, defaults/layout, and WGSL source ownership. The
  orbit oracle rounds every modeled operation to f32: worst root errors are `0.596 m` nadir,
  `38.547 m` near horizon, and `212.424 m` in a bounded near-grazing case; exact tangency is
  deliberately not claimed.
- The provenance-bearing default Node/Edge route is green at `21/21` checkpoints with 12
  deterministic transition frames per segment, minimum same-camera OFF/ON delta `135,330` pixels,
  default high precision `true`, and no page/GPU/device errors. It spans the antimeridian, both
  poles, `800 m` below-deck, inside/above deck, `200 km`, and `18,000 km`. The fixed-view explicit
  false/true precision A/B differs at `154/786,432` pixels (`0.020%`).
- The post-change moving cloud route remains clean at 1,117 frames over `20.004 s`: diagnostic
  `55.84 FPS`, CPU p50 `2.9 ms`, p95 `6.4 ms`, p99 `9.1 ms`, all eight altitude segments, and no
  device/page failures. An alternating steady-state explicit false/true queue-drain check measured
  `12.42–12.53 ms/frame` versus `12.45–12.52 ms/frame`; this is noise-level parity, not a claim
  comparing the new WGS84 shader with the removed sphere.
- Functionality preservation: WebGL billboard behavior and inert volumetric configuration remain
  intact; no cloud feature or renderer path was removed. This landing closed only the primary
  visible-shell geometry/height owner. Its then-open density-domain and temporal consumers later
  closed under `C13-37` and `C13-05`; standalone shadows/masks/capture/atmosphere and regional
  weather remain under `C13-06..08`. Gate B remains open.
- Rollback boundary: WGS84 uniform packing/default selection, the primary WGSL shell/height helpers,
  and their contract/probes/tests form one removable slice. No temporal attachment, weather
  resource, shadow topology, or WebGL shader is changed.

### C13-05 Batch 754 temporal RTE/coarse-reset evidence

- Premise/root cause: the half-resolution temporal resolver reconstructed a full-ECEF `f32` anchor,
  projected it through the absolute previous view-projection matrix, approximated the deck with an
  equatorial midpoint sphere, retained color history across incompatible frame gaps/tier/cull/deck
  transitions, and allocated a temporal bind group every frame.
- The current frame now unprojects with the inverse current VP-relative-to-eye transform and
  intersects configured WGS84 deck shells in camera-relative space. CPU `f64` computes
  `currentCameraWC - previousCameraWC`; the shader adds that delta to the current eye-relative
  anchor and projects through `previousViewProjectionRelativeToEye`. Encoded camera high/low data is
  reused from the primary march, so no full-ECEF `vec3<f32>` is reconstructed.
- `WebGPUCloudTemporalHistory.ts` owns an allocation-free coarse classifier/commit contract.
  Initial history, missing transforms, frame gaps, teleports over 50 km, scene/projection changes,
  morph, temporal re-entry, primary-deck changes, multi-deck topology changes, resize, and observed
  cull/re-entry all reject incompatible history. A persistent missing transform or morph remains
  current-only for safety, while the diagnostic generation/count advances only once per newly
  observed cause until the reset episode clears. Ordinary bounded camera, clock, and wind evolution
  retain history. Two parity bind groups are created with the history resources and selected
  without a hot-path allocation.
- `cloud-temporal-rte.spec.mjs` passes `11/11`, including WGS84 equator/dateline/both-pole/orbit
  f64 oracles, a RED legacy-polar fixture, reset truth, layout/allocation guards, source ownership,
  and Naga. `probe-cloud-temporal-rte.mjs` passes `22/22` in Edge/WebGPU with 26 finite 60-float
  temporal uploads, observed look-away cull/re-entry, tier/deck/multi-deck/resize transitions,
  maximum camera high/low reconstruction error `0.002723 m`, exact/stable source/build
  fingerprints, and no validation, device-loss, console, or page errors.
- Independent final review moved the 3×3 neighborhood clamp after shell/behind-camera/offscreen
  rejection, replaced general perspective VP inversion with inverse-view/projection composition,
  made orthographic/morph history explicitly current-only pending per-pixel ray-origin support, gave
  resize an explicit reset bit/generation, distinguished adjacent new reset causes from persistent
  causes, and made the never-active temporal-off path skip redundant bookkeeping. The complete cloud
  spec lane is `64/64` GREEN after those corrections.
- Functionality preservation: the primary march, high direct tier, medium temporal tier, public
  cloud controls, WebGL billboard path, and graceful WebGL volumetric no-op remain present. The
  repaired U8 preservation probe is byte-identical for billboard mode on both renderers.
- Scope/rollback: this closes planetary temporal coordinates, representative configured-deck
  reprojection, coarse compatibility resets, and parity bind-group retention only. Color-only
  half-resolution history remains; `C13-09/10/12` still own attachments, true 1/16 current work,
  wind/depth/disocclusion/variance/reactive rejection. The helper, temporal uniform packing/WGSL,
  retained bind groups, and focused tests/probe form the rollback boundary.

### C13-38 Batch 754 irrelevant cloud-IBL refresh suppression

- Premise/root cause: after `C13-37`, every published cloud appearance revision was a dynamic
  environment refresh reason even while the full reflected-cloud march was opted out. Visible-only
  animation could therefore schedule an irrelevant 256²×6 cube fill, IBL prefilter, and SH-L2
  projection.
- The revision gate is now
  `(wantMarch || cache.lastUsedCloudMarch) && liveCloudRevision !== cache.lastCloudRevision`.
  Current full-march animation still refreshes; revisions published while opted out remain
  unconsumed for the next opt-in; and a previous full-march environment still receives its one
  ON-to-OFF teardown refresh.
- `cloud-ibl-revision.spec.mjs` passes `4/4`, including 100 consecutive opted-out revisions.
  `probe-cloud-ibl-optout-revision.mjs` passes `12/12` in Edge/WebGPU: two off-animation/opt-in
  cycles, the teardown edge, exact/stable source/build provenance, and clean validation,
  device-loss, console, and page gates.
- Functionality preservation/rollback: no reflection, cloud, coverage-only IBL, public option,
  WebGL path, or quality setting was removed or weakened. This is proven irrelevant-work
  suppression, not a quantitative FPS claim. The one relevance predicate, table-driven test, and
  runtime scheduling probe are the rollback boundary.

### C13-36 Batch 736 ray-sample phase evidence

- The pre-existing tier contract is now real: `jitterEnabled` contributes `QF_JITTER` to uniform
  slot 74. The low/medium temporal tiers use a per-pixel Jimenez-2014 analytic
  interleaved-gradient-noise phase with a 64-frame sequence. Full-resolution T3 uses the same
  spatial field at frame zero because it has no temporal filter. The explicit numeric
  `cloudQuality` escape route retains `jitterEnabled=false` and the exact old midpoint expression.
- IGN is evaluated once per fragment outside the ray loop and requires no texture, sampler, bind
  group, upload, or external asset. It is blue-noise-like screen noise, not an STBN claim. The
  frame counter widened from 16 to 64 exact integer phases; Bayer UV jitter and cone-light jitter
  continue to mask the low four bits, preserving their existing 16-phase cycles.
- Only `t + phase * curStep` changes. `t`, `tProcessed`, conservative base-density testing, coarse
  backtracking, interval bounds, and loop progression are unchanged; base and full density sample
  the same position. The cloud-aware god-ray mask deliberately remains at midpoint because it has
  no temporal filter. Replacing that duplicate march with resolved/upscaled cloud alpha or a
  suitable MRT is retained under `C13-06`/`C13-22` rather than accepting mask shimmer here.
- `cloud-ray-jitter.spec.mjs` passes `6/6`: f32 spatial/temporal distribution, tier/flag wiring,
  midpoint fallback, 64/16 counter behavior, f32 interval containment from near range through
  orbit-scale distances, shared density position, and full-shader Naga validation. The engine
  build and TypeScript check are green.
- `probe-cloud-banding.mjs` produced valid provenance-bearing low and high artifacts with clean
  WebGPU/device gates. Low realized `24` primary steps at `512x384` with matching temporal history
  and `QF_JITTER`; high realized `96` steps on the direct full-resolution path with no temporal
  allocation. Its fixed-camera single and frame-32 high-tier PNGs are exactly identical
  (`0/786,432` changed pixels), proving this bounded temporal-off route does not sparkle.
- The low characterization records `547,928` single-frame and `556,378` settled interior cloud
  pixels. Its coherent-jump densities are `0.002843` and `0.010453`; without a separately built
  provenance-compatible pre-change companion these values do not establish an improvement.
  Manual inspection still shows the large-scale ordered baked-density lattice, which keeps
  `C13-37` open and next.
- The post-change moving altitude route covered all eight segments and 1,117 active frames over
  `20.016 s` with no page, device, or route failures. Diagnostic pacing was `55.80 FPS`; CPU was
  p50 `2.9 ms`, p95 `5.7 ms`, p99 `7.6 ms`. Compared with Batch 735's single-run
  `55.84 FPS` / `2.9` / `6.4` / `9.1 ms`, this is a no-regression characterization, not a promoted
  speedup. The medium temporal static/pan/settle smoke also completed without new errors.
- Functionality preservation: no cloud feature, quality tier, atmospheric consumer, or renderer
  path was disabled. WebGPU and WebGL billboard smoke remained visible (`59,911` and `36,504`
  neutral-cloud evidence pixels). Coarse temporal coordinate/reset handling later closed under
  `C13-05`; attachment-aware wind/weather/depth/disocclusion/variance/reactive rejection remains
  owned by `C13-12`.
- Rollback boundary: the tier flag packing, 64-phase counter, per-fragment IGN helper/phase
  parameter, and their two focused tools form one removable slice. Baked density resources,
  weather, shell geometry, reconstruction attachments, WebGL shaders, and public APIs are
  unchanged.

### C13-16 orchestrator Edge-acceptance checklist (per-genus morphology slice)

`cloud-genus-morphology.spec.mjs` (20/20) proves the coordinate transform and the identity guards on
the CPU. It cannot prove the GPU samples the new uniform row, that the pipeline compiles the added
functions, or that a viewer READS cirrus as ice. These browser checks are the slice's acceptance and
the row must not be promoted without them.

1. **Default byte-neutrality — the first gate, and a hard equality.** Capture the DEFAULT scene
   (no `cloudType`, i.e. CUMULUS) before and after this change at a pinned `JulianDate` and camera
   and require **exactly 0 changed pixels**, not a small diff. The whole design rests on three
   explicit early returns; a nonzero diff means one of them is not being taken and the finding is
   more important than the feature. Use the existing off-identity vehicle
   (`probe-cloud-u8-offident.mjs`) plus one cloud-bearing view.
2. **Cirrus-vs-cumulus DISCRIMINATION, structurally — not by brightness.** The recorded trap is that
   a faint wide-band cloud change is invisible to a band mean, and the inverse trap is that a mean
   difference proves nothing about SHAPE. Capture the same camera/clock/coverage twice, once with
   `cloudType: CloudType.CUMULUS` and once with `CloudType.CIRRUS`, and compute a DIRECTIONAL
   statistic on the cloud pixels: the ratio of luminance autocorrelation length along the projected
   wind azimuth to the length across it. Cirrus must be markedly anisotropic and cumulus must be
   near-isotropic. A whole-frame or band mean is NOT acceptable evidence here.
3. **The wind vector actually steers the streaks.** Re-run the cirrus lane with the wind rotated 90°
   and require the measured elongation axis to rotate with it. This is the check that separates a
   real wind-aligned domain from a fixed diagonal texture artifact, and it is cheap.
4. **Fallstreak tilt is visible.** From a near-horizontal view of a cirrus deck, the filament's lower
   edge must sit downwind of its upper edge. Read the PNGs; a scalar cannot settle this one.
5. **Cirrostratus stays a SHEET and cirrocumulus stays GRANULAR.** The table deliberately gives the
   veil a shallower carve (it is the halo genus) and the mackerel field a near-round aspect. Capture
   all three ice genera at one camera and confirm the grain ordering
   cirrus > cirrostratus > cirrocumulus, matching the spec's measured 8.10 / 4.65 / 1.95.
6. **The tour fixture that filed this row — and the one place this can regress.** Re-run
   `northatlantic-cirrus-fibratus` in `probe-cloud-tour.mjs`. Its floor gate
   (`minChangedFraction` 0.002) is the risk: the recorded post-CLOUD-LOW-COVERAGE-CUTOFF values are
   ground **0.0028** and above-deck **0.0148**, and the fibre carve retains roughly **0.59** of the
   deck's mean mass, so the ground station lands near **0.0017** in the worst (purely multiplicative)
   case. That is the whole reason the carve depths were kept conservative — elongation is provably
   independent of carve depth (asserted in the spec), so depth buys morphology nothing. If ground
   comes in under the floor, the correct response is to lower `FIBRE_MORPHOLOGY[CIRRUS].strength`,
   NOT to lower the fixture floor, and NOT to raise the anisotropy. Report the measured number.
   Its `gate.why` note — "Genus MORPHOLOGY (fibrous streaks vs generic puffs) remains C13-16" —
   should be rewritten in the same landing once the pixels support it. Do NOT rewrite it before the
   capture.
7. **Shadow/visible agreement.** The fibre factor rides in `cloudMacroSampleAt`'s shared factor, so
   the beer-shadow map sees the same filaments. With `cloudCastShadows` on, the cast ground shadow
   under a cirrus deck must be streaked, not blobby — `probe-cloud-shadows-flagon.mjs` is the vehicle.
8. **Phase sanity — the most likely tuning casualty.** `genusForwardG` clamps the cirrus forward lobe
   to 0.95 against the default 0.85, roughly a 10x forward peak. Capture a near-sun cirrus view and
   confirm the forward glow reads as a bright gradient rather than a clipped white disc. If it blows
   out, the fix is `GENUS_PHASE_G_LIMIT`, and the number should be reported rather than quietly
   retuned.
9. **Gate.** `scene.context.rendererType === "webgpu"` on every lane, zero new device/console errors,
   canvas-element PNGs captured same-task, per-view local-noon clock, and a discarded warm-up render
   before the fixture loop (the async-prewarm cold start renders fixture 1 stable-black).
10. **Occupancy note.** `C13-39` closed NEGATIVE on the finding that WGSL register allocation is
    STATIC — code compiled into the module taxes every pipeline regardless of runtime branches, and
    this pass is occupancy-bound. This slice adds three small functions to that module. If a timing
    lane is run at all it must use the mandatory interleaved-A/B protocol in
    `probe-cloud-lod-hoist-perf.mjs`'s header; a single-ordering comparison is not evidence.

### C13-08 orchestrator probe checklist

The CPU twin (`weather-field-bounds.spec.mjs`, 31/31) proves the packer's bytes. It cannot prove the
GPU consumes them, so these browser checks remain OPEN and are the row's acceptance:

1. **Regression floor.** Re-run `probe-weather-ingest.mjs`, `probe-weather-edr-mock.mjs`,
   `probe-weather-wcs.mjs`, `probe-weather-channels.mjs`, `probe-weather-time.mjs`, and
   `probe-weather-seam-poles.mjs`. All six drive GLOBAL fields and the spec asserts their bytes are
   unchanged, so any red here is a real regression, not a threshold artifact.
2. **`probe-weather-metar.mjs` — the intended behaviour change.** Its far-field is now the procedural
   map instead of a fabricated clear hole. The clear-station (`-120°`) and cloudy-station (`0°`)
   views are both inside the 40° influence radius and must still separate; if the separation shrank,
   report the numbers rather than re-tuning the source.
3. **NEW probe — regional placement (the row's own pixel gate).** Drive a REGIONAL field
   (`provider.setRequest({ bounds })` with `SyntheticWeatherSource("uniform", 1.0)` over a CONUS-ish
   rectangle) and capture two nadir views at a pinned clock: one INSIDE the rectangle and one far
   OUTSIDE it (e.g. mid-Indian-Ocean). Inside must be overcast; outside must match the SAME view with
   NO provider attached (the procedural fallback), because that is exactly what the fill writes.
   Pre-fix, the stretched field made both views overcast. Read the PNGs; a diff number alone is not
   the claim. Follow the C13-07 probe lessons: per-view local-noon clock, a discarded warm-up capture
   before the fixture loop, camera-local altitude (~250 km, not orbit), canvas-element PNGs.
4. **Antimeridian parser + rendered region — COMPLETE IN THE CURRENT WORKTREE;
   LANDING REVIEW OWED.** Ingest CoverageJSON whose longitude
   axis crosses `+180/-180`; the 7/7 focused lane now asserts the parser derives
   the same wrapped ~20° `WeatherField.bounds` and bytes for forward/reverse
   encodings. Still render cameras on both sides of the seam.
   The observed band must be continuous, must not duplicate, and far-away
   views must remain procedural fill. A manually supplied `170°E → 170°W`
   bounds lane remains only the packer control. The rebuilt Edge lane satisfies
   both-side continuity, no-duplicate/no-wall, far-fill, same-evaluation stats,
   and clean-error gates; all PNGs were reviewed.
5. **Pixel-free cross-check.** `provider.getPackStats()` must report `global: false` with both
   `observedTexels > 0` and `filledTexels > 0` for every regional lane, and `filledTexels === 0` for
   every global lane. Assert it in the same page evaluation as the capture (same-task capture rule).
6. **Gate.** `scene.context.rendererType === "webgpu"` on every lane, zero new device/console errors.

**2026-08-02 Codex rendered-tail acceptance + promotion-audit update:**
`probe-weather-regional-tails.mjs` now persists the two previously one-off/open
tails. Its WebGPU arm intercepts a real cyclic-axis CoverageJSON EDR response,
hard-gates the parser-derived `170..190°` field, captures both sides of the seam
plus a seam-centred and far-away control, and couples every capture to regional
`getPackStats()`. Its WebGL arm explicitly packs and attaches the same provider
to a volumetric-mode billboard collection, then requires unchanged billboard
pixels and zero volumetric publications. The companion fixture/policy/capture
contract has 10/10 pure-Node tests, including mutations for a duplicated band,
a missing seam side, a centre wall, changed WebGL pixels, and WebGL volumetric
publication. **Rebuilt Edge acceptance is GREEN:** every listed arm passed,
device/console/page errors were empty, and all ten PNGs were visually reviewed.
The WebGPU regional east/west/seam images show the intended continuous 100%
overcast fixture; the far pair and WebGL billboard pair are byte-identical.
An independent promotion audit retained that evidence but found the regional
cell-registration edge extrapolation described in the dated overlay; it is now
fixed and pinned by the 31/31 bounds suite. The same audit confirmed that the
seven checklist probes in items 1-2 have no post-Batch-797 evidence. The row and
Gate B therefore remain IN PROGRESS / NO-GO until those browser regressions are
rerun after this packer change; landing review alone cannot promote them.

---

## 10. Source pointers

### Current implementation

- `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudTemporalHistory.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudShadowFrame.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`
- `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl`
- `packages/engine/Source/Scene/CloudVolumetrics.js`
- `packages/engine/Source/Scene/CloudCollection.js`
- `packages/engine/Source/Scene/Weather/WeatherProvider.ts`
- `packages/engine/Source/Scene/Weather/WeatherTexPacker.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnvironmentDemand.ts`
- `Tools/visual-regression/cloud-primary-shell.spec.mjs`
- `Tools/visual-regression/cloud-ray-jitter.spec.mjs`
- `Tools/visual-regression/cloud-temporal-rte.spec.mjs`
- `Tools/visual-regression/cloud-shadow-rte.spec.mjs`
- `Tools/visual-regression/cloud-ibl-revision.spec.mjs`
- `Tools/visual-regression/probe-cloud-banding.mjs`
- `Tools/visual-regression/probe-cloud-temporal-rte.mjs`
- `Tools/visual-regression/probe-cloud-ibl-optout-revision.mjs`
- `Tools/visual-regression/probe-cloud-empty-frustum.mjs`
- `Tools/visual-regression/probe-cloud-planetary.mjs`
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
- `CLOUD_COORDINATE_CONTRACT_2026-07-23.md`

Line numbers in older reports are hints. Re-grep symbols at the start of every brief.
