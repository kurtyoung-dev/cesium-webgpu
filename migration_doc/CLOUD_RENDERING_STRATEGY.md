# Cloud Rendering Strategy — where we are + the open architectural question

Companion to [CAMPAIGN3_PROGRESS.md](CAMPAIGN3_PROGRESS.md) (batch tracker) and
[WEATHER_RECREATION_ROADMAP.md](WEATHER_RECREATION_ROADMAP.md) (the weather-*data*
axis). This doc owns the cloud-*rendering-technique* axis: quality tiers, the
noise representation, and the "match-baseline-by-default, opt-in-better" model.

**Status: 2026-06-25 — research in flight (3 background agents).** Campaign 3 is
paused at the architectural fork below; the agnostic perf batch (W6) continues in
the main loop while research returns.

---

## Architectural principle (user directive, 2026-06-25)

> By default we want to **match WebGL**. But we want to provide **better options
> that can be enabled**. If there is a better-looking, better-performing option,
> research it and plan to implement it.

Applied to clouds:

- **Default = cheap baseline.** WebGL has only billboard/2D clouds (`CloudCollection`).
  The WebGPU volumetric raymarcher is already **opt-in / default-off**
  (`globe.showProceduralClouds` / `atmosphericConditions.clouds.enableVolumetric`),
  so the default already "matches WebGL" (nothing volumetric until asked).
- **Opt-in = tiered fidelity.** We want a clean **quality-tier model** (e.g.
  low / medium / high / ultra) so users dial fidelity↔cost, instead of one
  monolithic raymarcher. This is what the research below is scoping.

This is consistent with CLAUDE.md Principle 1 (preserve WebGL) + Principle 2
(backend-agnostic scene, options behind the renderer) + Principle 5 (parity:
volumetric is WebGPU-only by construction, documented WebGL degradation).

---

## What we've TRIED (Campaign 3, shipped)

The current raymarcher is `ProceduralClouds.wgsl` + `WebGPUProceduralCloudRenderer.ts`:
single 1500–4000 m shell, **live** value-noise FBM base + 27-tap Worley F1 erosion
evaluated per sample, HG dual-lobe phase + Beer-Powder + cheap multi-scatter, 2D
weather map for spatial coverage.

| Batch | What | Outcome (probe-verified) |
|---|---|---|
| W1 (391) | dual-lobe HG phase + **Reinhard HDR tone-map** | clouds clipping to flat white → shaded form + silver lining |
| W2 (392) | sky-ambient gradient + ground bounce | shadow side lifts off black |
| W3 (393) | time-of-day sun color | warm dawn/dusk → neutral noon |
| W4 (394) | aerial-perspective blend + `globe.cloudAerialStrength` | distant clouds recede into horizon haze (distance-graded) |
| W5 (395) | **adaptive coarse→fine empty-space skip** | **0.00% image mismatch vs baseline, ×1.39 faster** |

**W5's two rejected attempts are the cautionary data** (not the shipped result):
a full-density skip oracle truncated clouds on erosion pockets and over-leapt
puffs on grazing rays (3× density loss, *slower*); an eager snap-back with an
unbounded back-up stalled the march (93% empty output). The fix — a cheap, smooth,
**conservative** low-detail skip oracle (`base ≥ full`) + monotonic `tProcessed`
back-up — preserved the image exactly while skipping only genuinely-empty space.
**Lesson that motivates this research:** incremental patches on a *live-noise*
raymarcher are subtle and fragile; the bigger lever may be the representation
itself.

## The documented strategy (already investigated — it IS well-defined)

From [QUEUE §Research notes](QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md): we adopted the
canonical pipeline —

- **Guerrilla Nubis** (Decima / Horizon Zero Dawn, SIGGRAPH 2015/2017; arXiv
  1609.05344): weather-map coverage/type/height + **Perlin-Worley base / Worley
  detail**.
- **Frostbite** thesis: Beer-Lambert + powder + energy-conserving multiple
  scattering + two-term HG.
- **WebGPU impls** (jeantimex, weBIGeo, Maxime Heckel, bitsquid): half-res +
  temporal reprojection + blue-noise dither.

The W1–W14 plan is this strategy applied incrementally. **So the strategy exists
and is sound.** W1–W5 landed the lighting + a perf-skip slice of it.

## The GAP the W-plan doesn't yet pull (the architectural fork)

The real Nubis architecture **precomputes 3D noise textures** (low-freq
Perlin-Worley ~128³ + high-freq Worley ~32³) and **samples** them with one cheap
`textureSampleLevel`. Our raymarcher instead evaluates **value-noise FBM + Worley
live, ~30 noise evals per sample, per ray, per frame** — which is simultaneously:

- the **perf bottleneck** (W5's adaptive skip only trims the *count* of these
  expensive evals; it can't make each eval cheap), and
- a **quality ceiling** (hand-rolled value-noise FBM ≠ true Perlin-Worley; this is
  why our clouds read "lumpy" and why high coverage saturates).

**Switching to precomputed 3D Perlin-Worley textures is the one change that is
both better-LOOKING and better-PERFORMING** — exactly the kind of opt-in upgrade
the directive asks for. It is the highest-leverage item and is currently buried in
the roadmap's Phase 6. The research below validates this and scopes the tier model
around it.

## Open research questions (3 background agents, 2026-06-25)

1. **Noise + quality SOTA** — confirm precomputed 3D Perlin-Worley textures
   (channels, resolutions, formats, compute-bake) vs live eval; density/remap
   pipeline; multiple-scattering + powder. → highest-leverage change, ranked.
2. **Perf + reconstruction SOTA** — half-res + bilateral upscale; temporal
   reprojection / Bayer-pattern accumulation + blue-noise; froxel integration;
   distance LOD / impostors; how engines structure quality presets.
3. **Tiered architecture + alternatives** — UE5 `r.VolumetricCloud.*` and Unity
   HDRP quality models; the preset data model; non-raymarch approaches
   (impostors, Gaussian splats, neural) — confirm/deny raymarch-with-3D-textures
   as the core; planet-scale LOD (flight-sim / globe engines).

## Research synthesis (all 3 agents in, 2026-06-25 — convergent)

1. **No architectural pivot.** Raymarch-with-3D-textures on a spherical shell is
   still the correct core (2024–2026). Gaussian-splat / NeRF / neural are **not**
   viable for animated, dynamically-lit participating media (no multiple-scatter
   model). Our shell march is already planet-scale-correct.
2. **The one change that wins BOTH axes: precomputed 3D noise textures.** Bake a
   low-freq **128³ RGBA8** Perlin-Worley + Worley "shape" texture and a high-freq
   **32³ RGBA8** Worley "detail" texture once at init (WGSL compute → `texture_storage_3d`);
   replace our ~30 live FBM+Worley evals/sample with **one trilinear fetch + a curl
   offset**. ~8 MB + 0.1 MB. Simultaneously the biggest **perf** win (1 fetch vs N
   evals) and the biggest **quality** win (true Perlin-Worley vs lumpy value-noise).
   *This is the headline.*
3. **Lighting wins (per cost):** energy-conserving analytic in-scatter integration
   `S_int=(S−S·exp(−σₑds))/σₑ`; **multiple-scattering octaves** (N≈3, geometric
   a/b/c decay, reuses one light march) — the biggest *visual* realism jump;
   sun-side-only powder + isotropic floor + ambient sky term.
4. **Perf/reconstruction (per cost):** half-res + **depth-aware joint-bilateral**
   upscale (log-space transmittance blend) ~4× (weBIGeo: ~2.25 ms in WebGPU);
   animated **IGN** ray-start jitter → halve steps; **temporal reprojection**
   (Schneider 1/16 over 16 frames) with absorption-position motion vectors + wind +
   neighborhood-clip + ghosting toggle. **Skip froxels**; defer 2D impostors to Ultra.
5. **Tier model = exactly the directive.** One `quality` enum → preset struct;
   **Tier 0 = cheap WebGL-parity default**, Tiers 1–3 opt-in volumetric.

## Decisions (resolved by research)

- ✅ **Adopt the precomputed 3D Perlin-Worley texture core** — unanimous #1, wins
  quality + perf. Keep the live-noise march as the Tier-0/low fallback so the
  default is preserved and W5's `cloudBaseDensity` skip-oracle still has a base.
- ✅ **Tier model: 4 tiers** (Baseline/Low/High/Cinematic), one enum → preset
  struct, mapped onto the existing `globe.cloudVolumetricQuality`. Knobs:
  `primarySteps, lightSteps (exponential — keep small low), renderResScale,
  temporal{updateFraction}, noiseTexRes, light/shadow/reflectionSampleScale,
  farRepresentation`.
- ✅ **3D-texture core is a NEW opt-in tier**, not a forced replacement — the
  live-noise path stays as the cheap tier (zero-regression to W1–W5).
- ✅ **Re-scoped sequence:** noise-texture core + tier scaffold FIRST (everything
  gates on them) → reconstruction (half-res/IGN/temporal — W6–W8 survive, refined)
  → lighting/density (MS octaves, energy-conserving integration, anvil/curl) →
  far-field/impostor → parity (P) batches. **W9–W11 shape/detail rebase onto the
  baked textures.**

## Plan (research complete → execution re-plan in flight)

- A **code-grounded planning workflow** (`campaign3v2-cloud-replan`, run
  `wf_825ad58f-3e8`) is generating the execution-ready packed plan: 5 architects
  design each workstream grounded in the actual `ProceduralClouds.wgsl` /
  `WebGPUProceduralCloudRenderer.ts` / `WebGPUVolumetricFogRenderer.ts` / `Globe.js`,
  a synthesizer orders them by dependency, and an adversarial reviewer checks
  default-preservation, W1–W5 non-regression, byte-locking, probe-verifiability,
  and VRAM budget. Output → `QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md`.
- **W6 (half-res + bilateral) is confirmed** as the first reconstruction batch and
  survives the rearchitecture intact — with two research refinements baked in
  (depth-weighted upscale taps, log-space transmittance blend).
