# Research — Celestial & Atmosphere Visual Fidelity (Takram `three-geospatial`)

**Date:** 2026-06-14 · **Status:** research / roadmap input (NOT yet scheduled). To be folded into `CAMPAIGN_ROADMAP_2026-06.md` as a new track during the next post-workflow review.

**Source:** Shota Matsuda (Takram) — "Visualizing Rocket Telemetry and Cityscapes with Cesium and Three.js" (Cesium talk) + the open-source monorepo <https://github.com/takram-design-engineering/three-geospatial>.
**License:** **MIT** (permissive — we may adapt with attribution). The underlying atmosphere model is **Eric Bruneton's Precomputed Atmospheric Scattering** (public technique, BSD reference impl) — we implement the *technique*, not copy GPL'd code. Attribute Bruneton + Takram in any ported shader.

**Why:** the talk's renders (photoreal Earth limb + aerial perspective, volumetric cloud layers at sunset, ISS lit consistently with the scene) are a visible step above stock CesiumJS sky/clouds. The techniques map onto subsystems we already have a foundation for, so most of this is *upgrade*, not greenfield.

---

## 1. Technique inventory (what Takram does)

### Atmosphere (`@takram/three-atmosphere`)
- **Full Bruneton precomputed scattering** — 4 LUTs: **transmittance** (2D), **scattering** (4D packed 3D, Rayleigh + single-Mie + **multiple-scattering**), **irradiance** (2D, indirect sky irradiance), optional single-Mie/higher-order.
- **`AerialPerspectiveEffect`** — a **post-process** pass that, per pixel by depth, multiplies scene color by atmospheric **transmittance** and adds **inscattered** light → correct aerial-perspective haze + a single consistent atmospheric look across terrain/tiles/sky. Optionally applies sun/sky irradiance as post-process lighting when a normal buffer is present (Lambertian only, but scales to planet size).
- **Light-source path** — `SunDirectionalLight` (sun radiance read from the transmittance LUT) + `SkyLightProbe` (sky-irradiance spherical harmonics) → light arbitrary-BRDF materials + shadows, consistent with the atmosphere.
- **Mixed lighting** — `LightingMaskPass` layer-masks per object: **post-process Lambertian for terrain**, **light-source PBR for discrete models (the ISS)**. (Exactly the talk's "post-process lighting for the terrain / light-source lighting for the ISS.")
- **`SkyMaterial`** (screen-quad sky) + **`StarsMaterial`** (real **Yale Bright Star Catalog** — positions, magnitudes, colors).

### Volumetric clouds (`@takram/three-clouds`)
- **Raymarched cloud layers** (up to 4 `CloudLayer`s) — perspective-scaled adaptive steps (50–1000 m, ×1.01 growth).
- **Density model**: 3D tileable **shape** (Perlin-Worley) + high-freq **shape-detail** noise + 2D **weather/coverage** map (per-channel per-layer) + **turbulence** domain-distortion at cloud base; vertical profile `a·e^(bη)+c·η+d`.
- **Lighting**: Beer's law + **Beer-Powder** term + **8-octave multiple-scattering** approximation + **dual-lobe Henyey-Greenstein** (g = 0.7 / −0.2) or Mie approx; sky/ground irradiance from the atmosphere LUTs.
- **Beer Shadow Maps (BSM)** — sun-space orthographic raymarch storing optical depth → cloud self-shadowing; **temporally filtered (TAA)** + PCF near the horizon. (The talk's "temporal filtering to mitigate the huge aliasing in the BSM.")
- **Temporal reprojection / TAAU** — primary march at **1/16 pixel count** + temporal upscale with **spatiotemporal blue noise**; quality presets (Low→Ultra) tune march precision + 512² BSM. Optional, perf-recommended.

### Effects (`@takram/three-geospatial-effects`)
Crepuscular rays / light shafts / **volumetric shadows on scene objects**, geometry-based **lens glare**, **transmission** materials, **TAA + screen-space shadows**.

---

## 2. Our current state (the gap)

| Subsystem | We have today | Takram technique | Gap |
|---|---|---|---|
| Atmosphere LUTs | `WebGPUAtmosphereLUT` — **transmittance + single inscatter** (Bruneton/Hillaire conventions), HG Mie; + a moon transmittance variant | transmittance + **multiple-scattering** + **irradiance** (4 LUTs) | Add multiple-scattering + irradiance LUTs |
| Atmosphere application | per-tile **ground atmosphere** in `GlobeTerrain.wgsl` + `WebGPUSkyAtmosphereRenderer` | unified **`AerialPerspectiveEffect`** post-process over ALL geometry | New post-process aerial-perspective pass (terrain + tiles + models share one atmosphere) |
| Scene/model lighting | IBL + direct PBR; no atmosphere-derived light | `SunDirectionalLight` + `SkyLightProbe` (atmosphere-derived) + **mixed** post/light-source | Atmosphere-derived sun/sky light + the mixed-lighting mask pattern |
| Clouds | `CloudCollection` (billboard cumulus) + `WebGPUProceduralCloudRenderer` + `WebGPUVolumetricFogRenderer` (height/sun fog raymarch) | **volumetric raymarched cloud LAYERS** (Perlin-Worley + weather map + Beer-powder + multi-scatter + BSM + TAAU) | The big one — true volumetric cloud layers + BSM + temporal upsampling |
| Sun | glow billboard (`Sun.js`) | sun radiance from transmittance LUT + lens glare | Physical sun disc/limb + atmosphere-coupled glow + lens glare |
| Moon | textured sphere (`Moon.js`) | (airless body) | Phase-correct PBR regolith + earthshine; couple to the atmosphere LUT moon variant we already compute |
| Stars | static cubemap (`SkyBox.js`) | **Yale Bright Star Catalog** point stars (magnitude/color) | Real star catalog starfield (HDR, twinkle-free, magnitude-accurate) |
| Mars / other bodies | none (custom ellipsoid only) | parameterized atmosphere | Mars = a Rayleigh/Mie/ozone + ground-albedo parameter set on the same LUT pipeline |
| Temporal infra | **TAA active** (Batch 244) + motion vectors | TAA + TAAU + blue noise | Reuse TAA for cloud BSM filtering + TAAU cloud upscale |

**Bottom line:** we already have the compute-LUT pipeline, a single-scattering atmosphere, a volumetric-fog raymarcher, active TAA, and motion vectors — the foundations. This is an *upgrade track*, mostly extending existing WebGPU compute + post-process infrastructure.

---

## 3. Proposed roadmap track — "Celestial & Atmosphere Visual Fidelity"

Slot as a new high-value track (the user is explicitly prioritizing visual impressiveness). Ordered foundation→payoff; each is WebGPU-first with a WebGL2 fallback decision per item.

1. **NEW-ATMO-BRUNETON-FULL-LUTS** (M) — extend `WebGPUAtmosphereLUT` to the full 4-LUT set (add multiple-scattering + irradiance). Foundation for everything below. *Have: transmittance + single inscatter.*
2. **NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS** (M/L) — a post-process `AerialPerspective` pass (transmittance×color + inscatter, by depth) applied to the whole scene via the variant factory / post-process collection, replacing/unifying the per-tile ground atmosphere. The single biggest "looks like the talk" win for terrain/tiles. Gate: WebGL-vs-WebGPU + sunset-limb visual probe.
3. **NEW-ATMO-DERIVED-LIGHTING + MIXED-MASK** (M) — `SunDirectionalLight` (radiance from transmittance LUT) + sky-irradiance SH probe; a lighting-mask so terrain uses post-process Lambertian and models use light-source PBR (the ISS pattern). Ties into Phase-7 model PBR.
4. **NEW-VOLUMETRIC-CLOUD-LAYERS** (L — headline) — raymarched `CloudLayer`s: Perlin-Worley shape + detail + weather/coverage map + turbulence; Beer-powder + dual-lobe HG + multi-scatter; vertical profile. Build on the `WebGPUVolumetricFog` raymarch + procedural-texture infra. Quality presets.
5. **NEW-CLOUD-BSM-TEMPORAL** (M/L) — Beer Shadow Map (sun-space optical-depth raymarch) + temporal filtering (reuse TAA) + PCF; cloud self-shadowing + shadows cast on terrain.
6. **NEW-CLOUD-TAAU** (M) — render clouds at 1/16 pixel count + temporal upscale (TAAU) with spatiotemporal blue noise (reuse the active TAA history). The perf enabler that makes (4)+(5) shippable.
7. **NEW-STARS-BRIGHT-CATALOG** (S/M) — replace the cubemap with a Yale Bright Star Catalog point starfield (magnitude→intensity, B-V→color), HDR-correct, fed through bloom. Cheap, high perceived-quality.
8. **NEW-SUN-MOON-FIDELITY** (M) — physical sun disc + limb darkening + atmosphere-coupled glow + geometry lens-glare; moon phase-correct PBR regolith + earthshine, coupled to the moon atmosphere-LUT variant we already compute.
9. **NEW-EFFECTS-LIGHTSHAFTS-LENSGLARE** (M) — crepuscular rays / volumetric light shafts (god-rays we partly have via `WebGPUGodRayEffect` — extend to atmosphere/cloud-aware) + geometry lens glare.
10. **NEW-MULTIBODY-ATMOSPHERE** (M) — parameterize the atmosphere LUT pipeline for Mars (thin CO₂/dust: different Rayleigh/Mie/ozone + ground albedo) and airless bodies (Moon skip-atmosphere); a `CelestialBodyAtmosphere` config. Leverages the already-parameterized LUT compute.

**Suggested grouping into campaign phases:** a "Phase A — Atmosphere fidelity" (items 1–3, 7, 8), then "Phase B — Volumetric clouds" (items 4–6, the headline), then "Phase C — Effects + multi-body" (9–10). Items 1, 4, 7 are independently shippable wins.

---

## 4. Notes / risks
- **License/attribution:** Apache-2.0 repo (corrected `R-2026-08-21-23` — the earlier "MIT repo" framing was wrong) + BSD Bruneton reference → implement the technique, credit Bruneton + Takram in shader headers. Do not vendor GPL code (none here — it's MIT).
- **Cost:** volumetric clouds + BSM are expensive; TAAU (item 6) is the gating perf enabler — and our TAA is already live (Batch 244), so the history/reprojection plumbing exists to build on.
- **WebGL2:** the post-process atmosphere + clouds are fragment-shader raymarches (no compute *required*), so a WebGL2 path is feasible (the LUT precompute is the part that prefers compute — can fall back to render-to-texture). Decide per item.
- **Parity discipline unchanged:** every item gets a WebGL-vs-WebGPU visual-diff probe; none regress the active-TAA / log-depth / bind-group-cache gates.
- **Foundations we already own:** `WebGPUAtmosphereLUT`, `AtmosphereLUT.wgsl` (HG Mie, Beer-Lambert), `WebGPUVolumetricFogRenderer` (raymarch), `WebGPUProceduralCloudRenderer` (noise), `WebGPUGodRayEffect`, active TAA + motion vectors, the post-process collection + variant factory. This track extends them.
