# Reference Visuals Catalog — License-Vetted External Projects (2026-08-09)

**Provenance:** maintainer ask 2026-08-09 ("similar to Takram's work... projects or research, with
usable licenses, for cesium, threejs, babylon, or playcanvas that have great looking planet, space,
weather, celestial, environmental, water, or bathymetry visuals... to help guide our fork
improvements"). Executed by a 21-agent web workflow (`wf_a3f36607-939`): 6 domain sweeps, 14
license verifications fetching actual LICENSE files (the L-24 Takram lesson: never trust a
paraphrase), 1 synthesis. **Legend:** ✔ = license file read verbatim this pass; △ = repo-declared
only — MUST be re-read verbatim (the L-xx step) before any file-level reuse. STUDY-ONLY = never
copy code, clean-room techniques only.

---

# Reference Projects with Usable Licenses — Maintainer Packet
*Takram-style external-reference guide for visual improvements. Licenses: **USABLE** (permissive), **FILE-COPYLEFT** (MPL — file-level obligations), **STUDY-ONLY** (AGPL/GPL/CC-NC — techniques only, never copy code), **UNKNOWN** (no reuse until cleared). Verification: ✔ = license file read verbatim; △ = repo-declared, not fetched this pass — re-read before any file-level reuse.*

## 1. HEADLINE

1. **JolifantoBambla/webgpu-sky-atmosphere** (MIT ✔, Lukas Herzberger) — complete Hillaire-2020 LUT family already in WGSL compute; the single most directly reusable asset for **C17 Track D (CLT-D6/D7/D8)**.
2. **sebh/UnrealEngineSkyAtmosphere** (MIT ✔, Hillaire/Epic) + **ebruneton/precomputed_atmospheric_scattering** (BSD-3 ✔) — the two paper-author ground truths to certify Track D acceptance probes against, incl. a path-tracer reference.
3. **Popov72/OceanDemo** (MIT △) + **BarthPaleologue/WebTide** (MIT △) — WebGPU-compute multi-cascade FFT + the only spherical planet-ocean wrap found; structural templates for **C14 W3**.
4. **2Retr0/GodotOceanWaves** (MIT △) — TMA spectrum + Hasselmann directional spreading + foam accumulation: the exact spectrum stack C14 W3 specifies, in WGSL-portable GLSL compute.
5. **byrd-polar/fluid-earth** (MIT △) — the only fully-open nullschool-class stack *including* the GRIB2/NetCDF→fp16-tile backend; maps straight onto the **weather-ingest roadmap (C2-16 seam)** and **C14 W4/W5**.
6. **mapbox/webgl-wind** (ISC △) — all-GPU particle-state-in-textures wind advection; cleanest porting target for **C14 W4** flow-field lanes.
7. **olawlor/AuroraRendererUnity** (Unlicense △) — the GPU aurora volume-rendering paper implemented by its own authors, public domain, live WebGL demo; the licensed anchor for **C15-02/03**.
8. **cosinekitty/astronomy** (MIT ✔, Don Cross) — ±1-arcmin ephemeris, eclipse circumstances, lunar libration, twilight times; the data authority behind **C17 Track C** and C12-adjacent celestial placement.

## 2. CATALOG BY DOMAIN

### Atmosphere & celestial light → C17 Tracks A–D

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| webgpu-sky-atmosphere | WebGPU/WGSL lib | **USABLE** MIT ✔ | Lukas Herzberger | All 4 Hillaire LUTs in WGSL compute incl. aerial-perspective froxels | CLT-D6 (MS series), CLT-D7 (sky-view bake), CLT-D8 (froxel certification) |
| UnrealEngineSkyAtmosphere | D3D11/HLSL ref | **USABLE** MIT ✔ | S. Hillaire (© Epic) | Paper-author LUT parameterization + volumetric path tracer as ground truth | Track D acceptance probes (D6–D8) |
| Bruneton precomputed scattering | C++/WebGL2 | **USABLE** BSD-3 ✔ | Eric Bruneton | Documented radiometry, ozone layer, unit-tested LUT precompute | CLT-D3/D5 (ozone), D6 validation |
| MinimalAtmosphere | Unity HLSL (engine-agnostic) | **USABLE** MIT ✔ | Felix Westin | Transmittance-attenuated *directional sun light* (terminator-red sun) | CLT-D1 (cloud direct-sun extinction), CLT-D9 (cross-limb gradient) |
| glsl-atmosphere | GLSL module | **USABLE** Unlicense ✔ | Rye Terrell | Minimal single-scatter march; cheap-tier fallback | CLT-D4 GLSL-twin work, low tiers |
| three.js Sky | three | **USABLE** MIT ✔ | three.js authors (Preetham lineage) | Analytic-sky uniform surface + tone-mapped exposure pairing | Track A exposure chain, analytic tier |
| Babylon Sky Material | babylon | **USABLE** Apache-2.0 ✔ | BabylonJS | Sky as scene-level API; same repo: HDR auto-exposure pipeline | Track A (CLT-A eye adaptation) API shape |
| Astronomy Engine | JS/TS lib | **USABLE** MIT ✔ | Don Cross | Eclipse circumstances, libration, twilight times, moon phase | Track C (CLT-C eclipse visuals), Track B twilight boundaries, C12 data |
| AuroraRendererUnity | Unity+WebGL | **USABLE** Unlicense △ | Lawlor & Genetti (UAF) | Physically-derived vertical emission profile (557.7 nm green / red tops), curtain footprints | C15-02 (synthetic oval), C15-03 (layered emission kernel) |
| Stellarium Web Engine | C→WASM/WebGL | **STUDY-ONLY** AGPL-3.0 △ — techniques only, never copy code | Chereau / Noctua / Stellarium | The night-sky quality bar: mag→PSF photometry, extinction, zodiacal light, airglow | CLT-A9 (Schaefer NELM) concepts, night-sky targets |

### Planet & space → C15, C17, starfield/C12-adjacent

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| satvis | cesium | **USABLE** MIT ✔ | Florian Mauracher | SGP4-in-workers → SampledPositionProperty, coverage cones, pass prediction | C15-05/06 data-driven-viz pattern; future orbit-fleet lane (no current row) |
| satellite.js | JS lib | **USABLE** MIT ✔ (LICENSE.md, not LICENSE) | Shashwat Kandadai / UCSC | Standard SGP4/SDP4 propagation | Same as satvis (foundation) |
| d3-celestial | d3/canvas | **USABLE** BSD-3 ✔ | Olaf Frohn | Permissive star/constellation/Milky Way *catalog data* (GeoJSON) | Starfield data for Track A star work, C12 starfield |
| webgpu-galaxy | three WebGPU/TSL | **USABLE** MIT ✔ | Dan Greenheck | 750k-particle compute+render, dust, bloom | Milky Way / deep-sky dressing (no current row) |
| Spacekit | three | **USABLE** MIT ✔ | Ian Webster | Keplerian orbits, rings, catalog skybox | Solar-system context scenes |
| threejs-procedural-planets | three | **USABLE** MIT ✔ | Daniel Greenheck | Shader-side fBm planet surfaces, rim glow | Minor-body/planet dressing |
| Gaia Sky | desktop OpenGL | **FILE-COPYLEFT** MPL-2.0 △ | T. Sagristà / ZAH Heidelberg | Octree LOD streaming for 1B+ stars, HDR star sprites | Technique study for deep starfield scaling |
| KeepTrack.space | WebGL2/TS | **STUDY-ONLY** AGPL-3.0 △ — techniques only, never copy code | Theodore Kruczek | Fleet-scale point-sprite rendering + picking | Scaling study only |

### Weather & clouds → C13 tail, weather-ingest roadmap, C14 W4/W5

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| Fluid Earth | WebGL/Svelte | **USABLE** MIT △ | Byrd Polar Center, OSU | Entire open data pipeline: GRIB2/NetCDF → fp16 tiles → GPU particles/rasters | Weather-ingest roadmap (C2-16 seam, source-swap architecture); C14 W5 |
| webgl-wind | WebGL | **USABLE** ISC △ | Agafonkin / Mapbox | 1M particles via RGBA-texture state ping-pong, trail fading | C14 W4 (flow-field lanes, WGSL port) |
| earth (nullschool) | D3/Canvas | **USABLE** MIT △ | Cameron Beccario | Canonical particle wind map; grib2json format; projection-aware velocity | C14 W4 presets; ingest format reference |
| Weacast | Node platform | **USABLE** MIT △ | Kalisio | GFS/ARPEGE GRIB2 downloaders, tiling, probe API | Weather-ingest roadmap backend phases |
| procedural-clouds | WebGPU/WGSL | **USABLE** MIT △ | jeantimex (Yi Wang) | Compute density-cache 3D texture + raymarch w/ light march — closest stack match | C13 tail diffing (C13-10 march emission, C13-16 cirrus) |
| three.js webgpu_volume_cloud + webgl_lightningstrike | three | **USABLE** MIT △ | three.js (sunag; yomboprime) | Minimal jittered volume march; the best open lightning reference | C13 tail; future storm effects |
| volsample | Unity + PlayCanvas port | **USABLE** MIT △ | Huw Bowles, D. Zimmermann | Structured Volume Sampling (pinned world-space sample planes vs banding) | C13-11 STBN complement (anti-banding) |
| WeatherLayers GL | deck.gl | **FILE-COPYLEFT** MPL-2.0 dual-commercial △ | Petr Sloup | Particle/raster/contour/barb layer suite, client GeoTIFF | Technique study for C14 W4 grid/barbs — no wholesale copy |
| leaflet-velocity | Canvas | **UNKNOWN** (CSIRO variant license, SPDX NOASSERTION) — no reuse until cleared | Dan Wild / CSIRO | grib2json interpolation conventions | Format reference only |
| Shadertoy "Clouds" (iq) | GLSL | **STUDY-ONLY** CC BY-NC-SA △ — techniques only, never copy code | Inigo Quilez | fbm-LOD octave dropoff, two-sample sun-gradient lighting | C13 concept vocabulary only |

### Water & ocean → C14 W0–W5

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| Popov72/OceanDemo | babylon WebGPU | **USABLE** MIT △ (port of gasgiant/FFT-Ocean — verify upstream + dual attribution before file reuse) | Evgeni Popov; algorithm I. Pensionerov | 3-cascade compute FFT, Jacobian foam, buoyancy, tweak GUI | C14 W3 (structural template) |
| WebTide | babylon WebGPU | **USABLE** MIT △ | Barthélemy Paléologue | Phillips+JONSWAP selectable; **spherical planet-ocean w/ triplanar wrap** | C14 W3 globe-wrap (most Cesium-relevant find) |
| GodotOceanWaves | godot GLSL compute | **USABLE** MIT △ | 2Retr0 | TMA spectrum + Hasselmann spreading + foam accumulate/decay — matches W3's two-layer spec | C14 W3 spectrum stack |
| dli/waves | WebGL | **USABLE** MIT △ | David Li | Minimal fragment-shader Stockham FFT chain | C14 W3 reference baseline |
| jbouny/fft-ocean | three | **USABLE** MIT △ | Jérémy Bouny | Screen-space projected grid (infinite horizon, no giant mesh) | C14 W3 clipmap-alternative study |
| three.js Water / Water2 | three | **USABLE** MIT △ | three.js (Bouny lineage) | Flow-map rivers/lakes: dual scrolling normals + cycle cross-fade | C14 W2 (water-mask wind modulation, inland water) |
| evanw/webgl-water | WebGL | **USABLE** MIT △ (declared only in index.html header — no LICENSE file) | Evan Wallace | Light-front caustics, raytraced refraction | Underwater/caustics (W3 follow-on) |
| threejs-caustics | three | **USABLE** BSD-3 △ | Martin Renou | Caustics onto arbitrary meshes, documented method | Underwater/caustics (W3 follow-on) |
| WebGPU-Ocean | WebGPU | **USABLE** MIT △ | matsuoka-601 | MLS-MPM/SPH particles + screen-space fluid shading | Shoreline/interactive water (future, no current row) |
| Toon Water tutorial | playcanvas | **UNKNOWN** — technique study only until cleared | Omar Shehata (ex-Cesium) | Depth-intersection shoreline foam line | C14 shoreline foam concept |

### Bathymetry & terrain → C14 underwater legibility + data tooling (no dedicated campaign row yet)

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| CesiumJS World Bathymetry stack | cesium (upstream) | **USABLE** Apache-2.0 △ — same license as fork, directly mergeable | Cesium GS | verticalExaggeration + ElevationRamp/Contour Fabric materials (ion DATA not open; GEBCO/ETOPO grids are) | C14 underwater context; fork already inherits the code |
| CTOD | cesium server | **USABLE** MIT △ | Sogelink Research | COG → quantized-mesh on demand (GEBCO/ETOPO → fork-consumable terrain) | Bathymetry data path |
| rio-rgbify / tilezen-joerd | pipelines | **USABLE** MIT △ | Mapbox / Tilezen | DEM→Terrain-RGB encoding; ETOPO1-inclusive AWS Terrain Tiles (still free) | Bathymetry data path |
| MapLibre hillshade + maplibre-contour | WebGL | **USABLE** BSD-3 △ | MapLibre; M. Barry | Two-pass DEM relief shading w/ neighbor stitch; browser marching-squares contours | Relief/contour techniques |
| deck.gl TerrainLayer | WebGL | **USABLE** MIT △ | vis.gl / OpenJS | martini/delatin RTIN tile meshing from height tiles | Terrain-mesh study |
| Three.js-Ocean-Scene | three | **USABLE** MIT △ | Nugget8 | Water surface over procedural sea floor, chunked culling | Surface-over-seafloor integration |

### Environment effects → C17 Track A–C seams, C13/weather dressing

| Reference | Ecosystem | License | Author | Learn | Guides |
|---|---|---|---|---|---|
| three.js webgpu_volume_lighting | three WebGPU/TSL | **USABLE** MIT △ | three.js (sunag et al.) | Raymarched volumetrics integrated with native lights/shadows | CLT-C5a/b (crepuscular rays), volumetric fog PP |
| three-good-godrays | three | **USABLE** MIT △ | Ameobea (from n8python) | Shadow-map-sampled raymarch god rays (not radial blur) | CLT-C5a/b |
| pmndrs/postprocessing | three | **USABLE** Zlib △ — permissive but notice-bearing | Poimandres / vanruesc | Effect-merging pass-fusion architecture; mipmap bloom | Track A exposure/PP chain architecture |
| R3F-Ultimate-Lens-Flare | three | **USABLE** CC0 △ | Anderson Mancini | Ghost/halo/starburst flare w/ raycast occlusion incl. transmissives | Sun flare polish (C12-adjacent; corona itself = CLT-C3) |
| Cesium Particle System Weather | cesium (in-tree) | **USABLE** Apache-2.0 △ | Cesium GS | Camera-attached rain/snow emitters + fog/atmosphere scene dressing | Weather dressing tail |
| CIS565 CesiumSnow | cesium fork | **USABLE** Apache-2.0 △ (repo-inherited; authors added no statement — note ambiguity) | Bai, Khabbaz, Hu (UPenn) | Slope+Perlin snow-line globe material, ocean masking | Seasonal ground cover (future) |
| threejs-earth | three | **USABLE** MIT △ | bobbyroe | Night-lights layer revealed on dark hemisphere + Fresnel rim | **C17 Track B (CLT-B day/night imagery interpolation)** |
| rain-puddle demo | three | **STUDY-ONLY** GPL-3.0 △ — techniques only, never copy code | Faraz Shaikh | Puddle mask, procedural ripple normals, splash particles | Rain surface response concepts |

## 3. GAPS (honest)

- **Gaussian splats (C15-G1..G8):** zero candidates in this sweep. The gsplat ecosystem (antimatter15/splat, mkkellogg/GaussianSplats3D, PlayCanvas supersplat, etc.) needs its own dedicated license-verification pass before C15-G3/G5 derive from anything external.
- **Moon rendering** (libration + earthshine shader): no quality permissive web reference exists — the fork's C12 work is ahead of open peers. Astronomy Engine covers the math only.
- **Photometric night sky** (mag→PSF, zodiacal light, airglow): only Stellarium (AGPL) does it seriously — strictly clean-room for CLT-A9-class work.
- **Cesium-native FFT ocean:** none exists anywhere; C14 W3 is genuinely greenfield (only upstream wiki design notes).
- **Aurora:** both licensed references are dormant (2016–2019); no modern WebGPU aurora exists — C15-03/04 will be first-of-kind.
- **Underwater god-rays / volumetric absorption** with a clear license: not found.
- **Light-pollution sky-glow dome** and **seasonal foliage on globes:** no good open reference; nearest path is imagery/material ramps.
- **Verification debt:** most weather/water/terrain rows above are △ repo-declared only — each needs its LICENSE file read verbatim (the L-xx step) before any code moves.

## 4. PROCESS

The fork already has a working protocol, established when Takram's three-geospatial informed the atmosphere work: study code is cited in `Reference:` blocks at the derivation site, every derived-from project gets a verbatim entry in root `LICENSE.md` plus the `packages/engine` mirror, each gets a numbered L-xx license determination (all 23 existing determinations were re-verified at C16 launch), and authors are credited by name in the README — with C16's comment standard keeping in-source attribution seamless (no tracker IDs; provenance lives in LICENSE.md and `migration_doc/**`). The one addition this packet recommends: **pre-register references in the campaign plan doc before any implementation batch derives from them**, exactly as `OCEAN_DYNAMICS_PLAN_2026-07-24.md` §4 already does with its verbatim-from-primary-source licence table — C15's aurora rows, C15-G, C17 Tracks A–D, and the weather-ingest phases should each carry an equivalent table (seeded from this packet, △ rows upgraded to ✔ at intake) so license verification is a plan-time gate, not a landing-time scramble.
