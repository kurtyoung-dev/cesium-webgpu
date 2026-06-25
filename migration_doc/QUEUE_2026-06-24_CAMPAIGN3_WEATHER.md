# Campaign 3 — Weather "far far better" + parity sweep (25 batches)

> **Live progress / what's next:** see
> **[CAMPAIGN3_PROGRESS.md](CAMPAIGN3_PROGRESS.md)** (the dashboard — shipped
> batches, commits, up-next).
>
> **Execution-ready detail:** see the companion
> **[QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md)**
> — each batch packed with all its bundled work (exact files, byte-locked
> `CloudUniforms`/`EffectsUniforms` offsets, BGL bindings, probe thresholds,
> dependencies), grounded in the real code by a 5-architect design workflow.
> This file is the why + arc overview.

Authored 2026-06-24 (git Batches 391+). Sequenced for a workflow to execute one
batch at a time: **implement → `npx gulp build` → Playwright probe (Edge, dev
server :8080) → READ the PNGs → commit + push as kurtyoung-dev**. Each batch is a
discrete, independently-verifiable unit. Subagents/Workflows do READ-ONLY
investigation only (they cannot build/probe/read-PNG) — the main loop ships.

## Why this campaign

The WebGPU procedural cloud raymarcher (`ProceduralClouds.wgsl` +
`WebGPUProceduralCloudRenderer.ts`) already has: Worley erosion, a normalized
multi-scatter light-march, the lat/lon **weather-map seam** (Phase 1 keystone),
11 WMO genera + `CloudTypeProfile`, and a clock-bound time lane. It looks
*procedural*. The gap to "far far better" is **lighting model fidelity**,
**shape detail**, **perf headroom for more samples**, and **scene integration**
(cloud shadows, atmosphere blend, god rays, precipitation). Techniques below are
drawn from Guerrilla's **Nubis** (Decima/Horizon Zero Dawn), Frostbite's
volumetric-cloud thesis, and current WebGPU cloud renderers (half-res + temporal
reprojection, blue-noise dither, dual-lobe Henyey-Greenstein, powder, energy-
conserving multiple scattering). See "Research notes" at the bottom.

Order rationale: **lighting wins first** (biggest visual bang on the current
full-res path, no dependencies) → **perf** (headroom) → **shape detail** (spends
the headroom) → **scene integration** → **parity/fixes**.

---

## Arc A — Cloud lighting fidelity (the biggest visual wins)

### W1 — Dual-lobe (two-term) Henyey-Greenstein phase — M

**What:** Replace the single phase term with a two-term HG: a forward lobe
(g₁≈0.8, sun-side forward glow) + a back lobe (g₂≈−0.2..−0.5) blended by a weight,
multiplied into the sun in-scatter. Gives the **silver-lining rim** when looking
toward the sun and a softer back-glow — the single most recognizable "real cloud"
cue. **Files:** `ProceduralClouds.wgsl` (add `dualLobeHG(cosTheta, g1, g2, w)`,
apply at the sun in-scatter; expose g1/g2/w in `CloudUniforms`),
`WebGPUProceduralCloudRenderer.ts` (pack the 3 params). **Verify:** new
`probe-cloud-phase.mjs` — camera looking toward the sun vs away; assert a bright
rim band appears on the sun side (sun-side mean luminance ≫ anti-sun side) and
READ the PNGs.

### W2 — Sky-ambient gradient + ground bounce — M

**What:** Add an ambient term so cloud tops are lit by blue sky and bottoms are
darker (height-fraction lerp of a sky-zenith color → ground-albedo color), added
to the sun in-scatter. Currently only the sun light-march contributes → clouds
read flat/dark on the shadow side. **Files:** `ProceduralClouds.wgsl` (ambient
gradient by `heightFraction`, sky/ground colors from `CloudUniforms`),
renderer pack. **Verify:** `probe-cloud-ambient.mjs` — shadow side is no longer
near-black (mean luminance of anti-sun face rises into a plausible band); READ.

### W3 — Time-of-day cloud color from the atmosphere LUT — M

**What:** Drive the cloud sun-light color (and ambient sky color) from the sun
direction + the existing `AtmosphereLUT` transmittance (warm/orange at low sun,
neutral at noon). Sample the transmittance LUT by sun-zenith for the direct
light color; sky-ambient from inscatter. **Files:** `ProceduralClouds.wgsl`
(bind the atmosphere transmittance/inscatter LUTs or pass sampled colors as
uniforms), `WebGPUProceduralCloudRenderer.ts`. **Verify:** `probe-cloud-tod.mjs`
— render at dawn/noon/dusk sun angles; assert the dawn/dusk clouds shift warm
(R>B) and noon stays neutral; READ all three.

### W4 — Aerial-perspective blend on distant clouds — M

**What:** Blend distant cloud color toward the atmosphere inscatter by view
distance so far clouds desaturate into the horizon haze and match the sky (they
currently "pop" against the atmosphere). Reuse the `AtmosphereLUT` inscatter (the
primitive flat shaders already do this — FEAT-GAP-09 pattern). **Files:**
`ProceduralClouds.wgsl` (distance-based inscatter lerp at composite),
renderer. **Verify:** `probe-cloud-aerial.mjs` — near vs far cloud band; far band
trends toward the horizon color; READ.

---

## Arc B — Performance headroom (enables more samples → more quality)

### W5 — Adaptive coarse→fine raymarch (empty-space skipping) — M

**What:** Two-phase march: large steps through empty air (density≈0) until a hit,
then back up one step and switch to small integration steps only inside cloud;
resume coarse on exit. Big step-count reduction at equal quality — the headroom
Arc C spends. **Files:** `ProceduralClouds.wgsl` (restructure the march loop).
**Verify:** `probe-cloud-perf.mjs` — assert frame time drops (or step budget
halves) with mismatch vs the pre-batch image ≤ 2% (quality preserved); READ.

### W6 — Half-resolution cloud pass + depth-aware bilateral upscale — L

**What:** Render the raymarch into a half-res cloud target, then upscale with a
joint-bilateral filter keyed on scene depth (so cloud/sky edges stay crisp).
~4× the per-pixel ray budget for the same cost. **Files:**
`WebGPUProceduralCloudRenderer.ts` (half-res target + an upscale pass shader),
new `CloudUpscale.wgsl`. **Verify:** `probe-cloud-halfres.mjs` — edges stay sharp
(no haloing at the cloud/sky boundary), mismatch vs full-res ≤ 3%; READ.

### W7 — Temporal reprojection + accumulation — L

**What:** Reproject the prior half-res cloud buffer by camera motion (reuse the
`previousViewProjection` already in `CameraUniforms`) and accumulate, reconstructing
full quality over N frames; per-frame update a 1/N subset of pixels. Clamp/reject
on disocclusion to avoid ghosting. **Files:**
`WebGPUProceduralCloudRenderer.ts` (history buffer + reprojection),
`CloudUpscale.wgsl`/new `CloudReproject.wgsl`. **Verify:** `probe-cloud-temporal.mjs`
— static camera converges to the full-res reference (mismatch ≤ 2% after N
frames); a panning camera shows no persistent ghost trail; READ.

### W8 — Blue-noise / interleaved-gradient ray-start jitter + dither — S

**What:** Offset each pixel's ray start by an IGN + golden-ratio (R1) sequence so
successive frames accumulate non-redundant sub-pixel samples, and dither the
final density with blue noise — kills the banding that low step counts produce.
Pairs with W7 (the jitter is what temporal accumulation resolves). **Files:**
`ProceduralClouds.wgsl` (jitter the start `t`, blue-noise dither). **Verify:**
`probe-cloud-banding.mjs` — assert banding (count of hard luminance steps along a
vertical scan) drops sharply; READ.

---

## Arc C — Shape & detail (spends the headroom)

### W9 — Curl-noise wispy edges — M

**What:** Advect the high-frequency erosion sample position by a curl-noise vector
field so cloud edges turn turbulent/wispy instead of uniformly eroded (the Nubis
"detail" trick). **Files:** `ProceduralClouds.wgsl` (add `curlNoise(p)`, offset
the erosion `samplePos`). **Verify:** `probe-cloud-detail.mjs` — edge fractal
dimension / high-frequency energy at cloud boundaries rises vs the pre-batch
image; READ (edges should look feathered, not melted).

### W10 — Cloud-type vertical density profiles from `CloudTypeProfile` — M

**What:** Wire the per-genus `CloudTypeProfile` (deck / height-gradient shape /
base density / extinction) into the density function so stratus reads flat-low,
cumulus billowy-mid, cumulonimbus tall-with-anvil — instead of one global shape.
Drive the active profile from the weather-map type channel. **Files:**
`ProceduralClouds.wgsl` (height-gradient functions per shape; profile params in
`CloudUniforms`), `WebGPUProceduralCloudRenderer.ts` (pack the active profile),
possibly `CloudTypeProfile.js`. **Verify:** `probe-cloud-types.mjs` — render 3
genera; assert distinct vertical silhouettes (height-extent + top-shape differ);
READ.

### W11 — Multi-deck clouds: high cirrus + low stratus — L

**What:** Add a thin high **cirrus** deck (ice, wispy, high altitude) and a low
**stratus** deck above/below the cumulus mid-deck, sampling the
`texture_2d_array` the weather map was pre-declared as (depth>1, Phase-1
foresight). Each deck = its own coverage layer + height band. **Plus ice-vs-water
phase:** cirrus (ice) uses a sharper forward phase + lower extinction + bluer
tint; cumulus (water) keeps the rounder phase, driven from `CloudTypeProfile`.
**Files:** `ProceduralClouds.wgsl` (per-deck density + composite + per-deck
phase/tint), `WebGPUProceduralCloudRenderer.ts` (fill array layers), weather-map
builder. **Verify:** `probe-cloud-multideck.mjs` — two separated cloud bands at
different altitudes, the cirrus band wispier/cooler than the cumulus band; READ.

---

## Arc D — Scene integration (clouds affect the world)

### W12 — Cloud shadows on the ground/terrain — L

**What:** March cloud density along the sun ray to build a cloud-shadow factor;
sample it in the globe/terrain FS so clouds darken the ground beneath them (a
coarse cloud-shadow map keyed by world lon/lat, reusing `worldToWeatherUV`).
Scene-level realism — the single biggest "weather is real" cue after lighting.
**Files:** new `CloudShadowMap.wgsl` (compute), `GlobeTerrain.wgsl` (sample +
darken), `WebGPUProceduralCloudRenderer.ts` (produce the shadow texture).
**Verify:** `probe-cloud-shadow.mjs` — assert the lit ground darkens under cloud
coverage and stays lit in gaps; READ (moving shadow patches under the clouds).

### W13 — God-ray / crepuscular integration with clouds — M

**What:** Feed cloud transmittance into the existing `WebGPUGodRayEffect`
occlusion input so light shafts emanate from gaps between clouds (not just the
hard sun disk). **Files:** `WebGPUGodRayEffect.ts` (occlusion source = cloud
transmittance), `ProceduralClouds.wgsl` (export transmittance to the buffer god
rays read). **Verify:** `probe-cloud-godrays.mjs` — backlit broken cloud cover
produces visible shafts through the gaps; READ.

### W14 — Precipitation (rain/snow) gated by coverage/type — M

**What:** A screen-space precipitation pass (or lightweight particle field) whose
intensity is gated by the local weather-map coverage + genus (cumulonimbus →
rain, nimbostratus → steady rain, cold + high → snow). Tie to the clock lane for
falling motion. **Files:** new `Precipitation.wgsl` + a small renderer or fold
into the cloud renderer; weather-map type read. **Verify:** `probe-precip.mjs` —
rain appears only under raining genera, none under clear sky; READ.

---

## Arc E — Parity & backlog fixes

### P1 — NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT — M

**What:** Fix the real "SkyAtmosphere LUT dispatch" device error (an invalid
command buffer from a BGL mismatch at init) that every WebGPU probe currently
filters. A genuine device error, not cosmetic. **Files:** the SkyAtmosphere LUT
compute dispatch + its BGL (`WebGPU*Atmosphere*`/`SkyAtmosphere*`). **Verify:**
re-run any probe WITHOUT the `Atmosphere ?LUT` filter and assert zero device
errors; READ a sky frame for no regression.

### P2 — NEW-WEBGPU-DEPTHFAIL-MATERIAL — M

**What:** Mirror the C2-23 depth-fail twin into `createWebGPUMaterialCommands`
so material-based `depthFailMaterial` (Entity polyline/polygon, GroundPrimitive)
is covered, not just `PerInstanceColorAppearance`. **Files:**
`WebGPUPrimitiveCommands.js` (`createWebGPUMaterialCommands`), possibly a
material-aware depth-fail shader variant. **Verify:** extend
`probe-depthfail-appearance.mjs` with a material primitive; WebGPU red ≈ WebGL.

### P3 — HiZ dense-tiles moving-camera A/B (C2-21 follow-up) — M

**What:** Verify the now-default Hi-Z occlusion cull on a dense real **3D-tiles**
scene with a **moving** camera (the 1-frame-latency shimmer bound). If shimmer
exceeds budget, add a silhouette-dilation guard band to the occlusion test.
**Files:** new `probe-hiz-tiles-moving.mjs`; `OcclusionTest.wgsl` only if a guard
band is needed. **Verify:** consume-on vs never, panning camera, mismatch ≤
budget across the pan; READ.

### P4 — NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH — M

**What:** Match the WGSL ground-atmosphere drape falloff/limb-width to WebGL's
`GlobeFS.glsl` + `AtmosphereCommon.glsl`. **Files:** `GlobeTerrain.wgsl`
(`groundAtmosphereControl`/fade). **Verify:** `probe-limb-halo-width.mjs` — limb
band width within tolerance of WebGL; READ.

### P5 — NEW-WEBGPU-EXAG-WATER-STREAKS — M

**What:** Fix the bright-blue water/lake streaks WebGPU renders under high
vertical exaggeration where WebGL is muted (ocean/water-tint parity in the globe
FS). **Files:** `GlobeTerrain.wgsl` (water-mask/ocean tint). **Verify:**
`probe-exaggeration-3d.mjs` — streaks gone; READ.

### P6 — Collections 2D/CV morph (billboards/points/labels) — L

**What:** The high-priority renderer-level fix: billboard/point/label collections
render wrong in 2D/CV (and partly 3D) morph. **Files:** the collection renderers
+ their WGSL. **Verify:** `probe-collections-2dcv-morph.mjs` /
`probe-collections-entity.mjs`; READ.

### P7 — WeatherSystem API skeleton (Roadmap Phase 3) — L

**What:** Backend-neutral `WeatherField` + `WeatherProvider` interface so the
cloud renderer reads weather from a provider (procedural now, data later), plus
honest WebGL degradation messaging (the raymarcher is WebGPU-only —
`showProceduralClouds` is a documented no-op on WebGL). **Files:** new
`Scene/WeatherSystem.js` + `WeatherField`, `WebGPUProceduralCloudRenderer.ts`
hook. **Verify:** unit-style probe that swaps providers and the weather map
updates; READ.

### P8 — MORPH-MODEL-PROJECT2D — M

**What:** glTF Model accurate-2D (`projectTo2D:true`) WGSL path (position2D +
`u_modelView2D` + USE_2D). **Files:** `ModelPBRComplete.wgsl`, model renderer.
**Verify:** `probe-model-2d.mjs` both backends; READ.

### P9 — WGSL-PREPROCESSOR-PRIVATE-TO-INTERNAL (TS-debt) — S

**What:** Change the 5 cross-module `@private` JSDoc tags on
`WGSLShaderPreprocessor.ts` to `@internal` and drop the now-unneeded `as`-casts at
call sites. **Files:** `WGSLShaderPreprocessor.ts` + call sites. **Verify:**
`npx tsc --noEmit` clean; build green.

### P10 — FEATURE-RENDERER-ONBOARDING-DOC — S

**What:** Write the missing ~200–300-line
`migration_doc/FEATURE_RENDERER_ONBOARDING.md` (contract / template /
registration site / scene integration / backend-parity checklist) for adding a
feature renderer. **Files:** new doc. **Verify:** doc lints clean; cross-linked
from `migration_doc/README.md`.

### P11 — Weather-visual baselines + inventory/roadmap reconciliation — S

**What:** Capture/refresh `probe-cloud-tour.mjs` baselines for the new lighting +
shape + integration so Arc A–D are regression-locked, add a one-line entry per new
probe to `DEBUGGING_GUIDE.md`, move shipped weather items (W1–W14) from
FEATURE_INVENTORY §C/§D to §B, advance the WEATHER_RECREATION_ROADMAP phase
markers, and prune closed DEFERRED entries. Keep the load-bearing docs honest.
**Files:** baselines under `Tools/visual-regression/`,
`migration_doc/DEBUGGING_GUIDE.md`, `FEATURE_INVENTORY.md`,
`WEATHER_RECREATION_ROADMAP.md`, `DEFERRED_WORK.md`. **Verify:** the tour runs
green against the freshly-captured baselines; docs lint clean.

---

## Research notes (techniques adopted, with sources)

- **Coverage/type/height weather map + ray-march + Perlin-Worley base / Worley
  detail** — Guerrilla **Nubis** (Decima, Horizon Zero Dawn), SIGGRAPH 2015/2017;
  "Optimisations for Real-Time Volumetric Cloudscapes" (arXiv 1609.05344). We have
  the weather-map seam; W9/W10/W11 extend the shape side.
- **Lighting: Beer-Lambert + powder + energy-conserving multiple scattering,
  Henyey-Greenstein (single → two-term/dual-lobe)** — Frostbite volumetric-cloud
  thesis; Unreal Engine TTHG. W1/W2 are the highest-impact visual wins.
- **Half-res + temporal reprojection + Bayer/blue-noise/IGN dither, amortized
  coarse→fine march** — current WebGPU cloud renderers (jeantimex, weBIGeo,
  Maxime Heckel's cloudscapes), bitsquid "Volumetric Clouds". W5–W8.
- **Cloud shadows on ground, god rays through gaps, aerial-perspective blend,
  precipitation tied to coverage** — open-world weather practice (storm shadows,
  crepuscular rays). W4/W12/W13/W14 integrate clouds with the existing
  `AtmosphereLUT` / `WebGPUGodRayEffect` / globe FS.

Sources: Guerrilla "Nubis"
(<https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine>),
arXiv 1609.05344 (<https://arxiv.org/pdf/1609.05344>), Frostbite/HZD cloud
references (<https://github.com/adrianderstroff/realtime-clouds>), WebGPU cloud
renderers (<https://github.com/jeantimex/procedural-clouds>,
<https://www.webindex.page/project/webigeo-clouds>), Maxime Heckel cloudscapes
(<https://blog.maximeheckel.com/posts/real-time-cloudscapes-with-volumetric-raymarching/>),
bitsquid Volumetric Clouds (<http://bitsquid.blogspot.com/2016/07/volumetric-clouds.html>).
