# Campaign 3 — Progress Tracker

Living status board for the **weather "far far better" + parity sweep** (25
batches). This is the dashboard — read it first to see what's done and what's
next.

- **Why + arc overview:** [QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md)
- **Execution-ready per-batch specs (exact files, byte-locked offsets, probes):**
  [QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md](QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md)
- **Resume state in memory:** `memory/project_campaign3_execution.md`

## Status at a glance

| | |
|---|---|
| **Batches shipped** | **3 / 25** (Arc A lighting: 3 / 4) |
| **Latest commit** | `b9c8f8f7bc` (Batch 393, W3) |
| **▶ Up next** | **W4 — aerial-perspective blend** |
| **`CloudUniforms` size** | 92 floats (started at 80) |
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
| W4 | Aerial-perspective blend on distant clouds | ▶ | `aerialStrength@91` already reserved/packed=1.0; add `aerialColor@92-94` (92→96 floats) |

### Arc B — Performance headroom

| ID | Title | Status | Note |
|---|---|---|---|
| W5 | Adaptive coarse→fine raymarch (empty-space skip) | ⬜ | no CloudUniforms change |
| W6 | Half-res cloud pass + bilateral upscale | ⬜ | new `CloudUpscale.wgsl` + half-res target |
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

## ▶ Up next — W4 (aerial-perspective blend)

Blend distant cloud color toward an atmosphere-haze color by view distance so far
clouds desaturate into the horizon instead of popping. **Half-ready:**
`aerialStrength@91` is already declared in the struct + packed `1.0` (W3 reserved
it). This batch: add `aerialColor` (vec3) @92-94 (`CLOUD_UNIFORM_FLOATS` 92→96),
lerp the composite toward `aerialColor` by a march-distance factor × `aerialStrength`.
Full spec + the `tStart`-near-nadir gotcha: packed-doc **W4**. Reuse the
sun-control technique below for the probe.

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
