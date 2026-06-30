# Campaign 3 — Progress Tracker

Living status board for the **weather "far far better" + parity sweep** (25
batches). This is the dashboard — read it first to see what's done and what's
next.

- **Why + arc overview:** [QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md)
- **Execution-ready per-batch specs (exact files, byte-locked offsets, probes):**
  [QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md)
- **Rendering-technique strategy + research synthesis (3D-noise-texture core, quality
  tiers):** [CLOUD_RENDERING_STRATEGY.md](CLOUD_RENDERING_STRATEGY.md)
- **▶ Re-scoped execution plan (28 batches V0–V28, supersedes the cloud arc below):**
  [QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md](QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md)
- **Resume state in memory:** `memory/project_campaign3_execution.md`

> **2026-06-25 — Campaign 3 RE-SCOPED** to the v2 tiered plan (V0–V28).
>
> **2026-06-30 — RECONCILED: Campaign 3 v2 (Tiered Clouds, V0–V16) is FUNCTIONALLY
> COMPLETE.** The tiered-cloud features all shipped — but under the **improvement-plan
> naming** (the atmosphere/cloud arc, batches 437–452), NOT the V0–V18 numbering, so
> this tracker drifted. Verified against live code (2026-06-30): the baked 3D-noise
> core keystone (`CloudNoiseBake.wgsl` + `WebGPUCloudNoiseResources.ts`, `cloudDensity`
> samples `cloudShapeTex`/`cloudDetailTex` with the live `fbmNoise` else-branch fallback),
> the `qualityFlags@74` tier lane, half-res (CLOUD-HALFRES), temporal (CLOUD-TEMPORAL),
> IGN jitter, curl (439), MS-octave geometric decay (`msDecayA/B/C`), per-genus profiles +
> `profileExtinction` (452), multi-deck (443), shadows (437), god-rays, precip (444), the
> transmittance early-out + adaptive coarse→fine march, and the `cloudVolumetricQuality`
> dial (`Globe.js`) all exist. `CloudUniforms` is at **128 floats**. **Only V17
> (baked-impostor far-field) remains — deferred as speculative Ultra-only research.**
> The campaign is CLOSED; next major work pivots to the **DP-H46 metadata epic**.

## Status at a glance

| | |
|---|---|
| **Tiered-cloud features (V0–V16)** | **COMPLETE** (shipped under improvement-plan naming, batches 437–452) |
| **Deferred** | V17 baked-impostor far-field (speculative Ultra-only research) |
| **Latest cloud commit** | Batch 452 (profileExtinction — per-genus optical density) |
| **`CloudUniforms` size** | **128 floats** (started at 80) |
| **Public dial** | `globe.cloudVolumetricQuality` (`low/medium/high/auto`) + `cloudQuality` escape hatch |
| **Branch** | `main` (trunk-only, clean) |

**Per-batch protocol** (each batch = one atomic commit): implement all bundled
work → `npx gulp build` → Playwright probe (Edge, dev server `:8080`) → **READ the
PNGs** → commit + push as `kurtyoung-dev`. Cloud probes are WebGPU-only; filter the
known `/Atmosphere ?LUT|SkyAtmosphere/i` device error (until P1 fixes it).

## Pre-campaign completions (same session)

| Item | Batch / commit | Result |
|---|---|---|
| **C2-21** Hi-Z occlusion cull | 389 / `5cf0492a5b` | ✅ Root-caused (pyramid read the context's unwritten default depth, not the scene-FB MSAA-resolved depth) + MSAA-aware mip-0 pipeline; default ON; verified cull-works + no-false-cull |
| **C2-23** depthFailAppearance | 390 / `c0205eb6ea` | ✅ Color-appearance slice; WebGPU pixel-parity with WebGL (red 40176 == 40176). Material path = Campaign-3 P2 |
| Campaign-3 queue + packed specs | `3958a8eac9`, `3e41204d86` | ✅ 25-batch plan + 5-architect code-grounded packed specs |

## Batch progress

Legend: ✅ shipped · ▶ next · ⬜ pending

### Arc A — Cloud lighting fidelity

| ID | Title | Status | Commit / note |
|---|---|---|---|
| W1 | Dual-lobe HG phase **+ HDR tone-map** | ✅ | 391 / `08d9dbd5f9` — phase alone was invisible (clipped to white); tone-map was the real unblock → clouds got form + silver lining |
| W2 | Sky-ambient gradient + ground bounce | ✅ | 392 / `3cc1c9d51e` — shadow side lifted off black, form preserved |
| W3 | Time-of-day sun color | ✅ | 393 / `b9c8f8f7bc` — warm dawn/dusk, neutral noon (local-elevation keyed) |
| W4 | Aerial-perspective blend on distant clouds | ✅ | 394 — `aerialColor@92-94` (struct 92→96); new `globe.cloudAerialStrength` (0–1, def 1.0); distance-graded (two-layer A/B: deck 1.5→28 km away, haze 0.41→0.57) |

### Arc B — Performance headroom

| ID | Title | Status | Note |
|---|---|---|---|
| W5 | Adaptive coarse→fine raymarch (empty-space skip) | ✅ | 395 — new `cloudBaseDensity` skip oracle (conservative base≥full, smooth); `tProcessed` monotonic progress. **0.00% image mismatch vs fixed, ×1.39 faster** (sparse sky). No CloudUniforms change |
| W6 | Half-res cloud pass + bilateral upscale | ▶ | new `CloudUpscale.wgsl` + half-res target |
| W7 | Temporal reprojection + accumulation | ⬜ | reuse `previousViewProjection`; history buffer |
| W8 | Blue-noise / IGN ray-start jitter + dither | ⬜ | `frameCounter@76` (reserved in layout) |

### Arc C — Shape & detail

| ID | Title | Status | Note |
|---|---|---|---|
| W9 | Curl-noise wispy edges | ⬜ | `curlAmplitude@74`, `curlFrequency@75` (reserved) |
| W10 | Per-genus vertical density profiles | ⬜ | from `CloudTypeProfile`; profile floats @96-99 |
| W11 | Multi-deck cirrus/stratus + ice/water phase | ⬜ | `texture_2d_array` depth>1; deck floats @100-107 |

### Arc D — Scene integration

| ID | Title | Status | Note |
|---|---|---|---|
| W12 | Cloud shadows on ground/terrain | ⬜ | new `CloudShadowMap.wgsl`; `EffectsUniforms` 480→512, bindings 23/24 |
| W13 | God-ray / crepuscular integration | ⬜ | feed cloud transmittance into `WebGPUGodRayEffect` |
| W14 | Precipitation gated by coverage/type | ⬜ | new `Precipitation.wgsl` |

### Arc E — Parity & backlog fixes

| ID | Title | Status | Note |
|---|---|---|---|
| P1 | Fix the SkyAtmosphere-LUT device error | ⬜ | the error every probe currently filters |
| P2 | depthFail material path (C2-23 follow-up) | ⬜ | mirror twin into `createWebGPUMaterialCommands` |
| P3 | Hi-Z dense-tiles moving-camera A/B (C2-21 follow-up) | ⬜ | 1-frame-latency shimmer bound |
| P4 | Ground-atmosphere drape limb-width parity | ⬜ | `GlobeTerrain.wgsl` |
| P5 | High-exaggeration water-streak parity | ⬜ | `GlobeTerrain.wgsl` water/ocean tint |
| P6 | Collections 2D/CV morph (billboards/points/labels) | ⬜ | renderer-level |
| P7 | WeatherSystem API skeleton | ⬜ | backend-neutral `WeatherField`/`WeatherProvider` |
| P8 | glTF model accurate-2D WGSL path | ⬜ | `ModelPBRComplete.wgsl` |
| P9 | WGSL preprocessor `@private`→`@internal` | ⬜ | TS-debt |
| P10 | Feature-renderer onboarding doc | ⬜ | new `FEATURE_RENDERER_ONBOARDING.md` |
| P11 | Weather baselines + inventory/roadmap reconcile | ⬜ | capture baselines, move shipped to §B |

## ▶ Up next — W6 (half-res cloud pass + bilateral upscale)

Render the raymarch into a half-resolution `rgba16float` cloud target, then
composite onto the canvas with a depth-aware joint-bilateral upscale so cloud/sky
and cloud/terrain edges stay crisp at ~4× fewer rays. New `CloudUpscale.wgsl` +
a half-res render target + the bilateral composite. Combined with W5's per-ray
savings, this is the big Arc-B headroom for W7 (temporal reprojection). Full spec:
packed-doc **W6**.

**W5 verification note (reusable technique):** the rigorous perf+quality proof was
a **true A/B vs the pre-W5 build** — since W5 was uncommitted, `git stash` of just
`ProceduralClouds.wgsl` reverts to the W4-committed fixed march; build + capture a
reference, pop, build + capture adaptive, diff image + GPU-synced frame time (via
`s.context.device.queue.onSubmittedWorkDone()`). Result: 0.00% mismatch, ×1.39
faster. The key design lesson: drive empty-space skipping off a CHEAP, SMOOTH,
CONSERVATIVE low-detail density (`base ≥ full`), never the eroded full density —
and floor the edge back-up at `tProcessed` so the march can't stall. See
`probe-cloud-perf.mjs`.

**W4 verification note (reusable technique):** in-frame near/far cloud bands are
unreliable for distance tests — the **hard diagonal frustum-edge artifact** + the
**Y-flipped canvas** + grazing-ray dominance all confound them. The robust proof
was a **two-layer-altitude A/B**: fix the camera, move the deck (1.5 km → 28 km up)
to change cloud distance, A/B `cloudAerialStrength` 0/1 per layer, compare the
whole-frame aerial coefficient. Artifact- and flip-immune. See
`probe-cloud-aerial.mjs`.

## Resume essentials

**Master `CloudUniforms` layout (current = 92 floats).** Single source of truth =
the packed-doc header table. Filled so far: `phaseG2@66`, `phaseBlend@67`,
`phaseG1@72`, `ambientIntensity@73`, `_padA@76-79` (W8 `frameCounter@76`),
`skyAmbientColor@80-82`, `groundAmbientColor@84-86`, `sunLightColor@88-90`,
`aerialStrength@91`. **WGSL `vec3` is 16-byte-aligned** — keep vec3 fields on
float indices divisible by 4; fill gaps with scalar pads (not vec3) or the offset
jumps. Packer (`WebGPUProceduralCloudRenderer.ts`) + WGSL struct
(`ProceduralClouds.wgsl`) must move byte-identically.

**Cloud-probe sun control (W3 discovery).** The RAF render path ignores
`viewer.clock` (manual `scene.render()` uses wall-clock). To drive the sun by
time: `viewer.useDefaultRenderLoop=false` then `scene.render(jd)` with an explicit
`JulianDate`.

**Known pre-existing cloud issues (candidate future batches, not yet filed):** a
hard diagonal edge at the cloud-layer/frustum boundary; coverage > ~0.6 still
trends white even with the tone-map (thick-deck saturation). W1's tone-map +
exposure (`CLOUD_EXPOSURE` const) may later become a uniform.
