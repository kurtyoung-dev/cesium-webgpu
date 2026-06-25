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

## Decisions pending (after research returns)

- [ ] Adopt precomputed 3D Perlin-Worley textures as the core density source?
      (expected: yes — both faster + better-looking)
- [ ] The tier model: how many tiers, what each changes (step count, render-res
      scale, temporal on/off, 3D-tex res, light steps). Map to the existing
      `globe.cloudVolumetricQuality` (`low|medium|high|auto`) dial.
- [ ] Re-order / re-scope Campaign 3 W6–W14 around the new core (W6 half-res, W7
      temporal, W8 blue-noise are reconstruction wins that survive the rearchitecture;
      W9–W11 shape/detail change if the noise moves to textures).
- [ ] Whether the 3D-texture core is a NEW opt-in "high/ultra" tier alongside the
      current live-noise march (kept as "low/medium"), or a replacement.

## Plan while research runs

- **Background:** 3 research agents (above).
- **Main loop (workflow keeps running):** continue **W6 (half-res cloud pass +
  bilateral upscale)** — it is a reconstruction win **orthogonal** to the noise
  representation, so it is valid regardless of the noise-texture decision and is
  not wasted work.
- **On research return:** synthesize → update this doc's "Decisions pending" →
  re-plan the remainder of Campaign 3 around the chosen tier model.
