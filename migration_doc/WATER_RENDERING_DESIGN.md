# Water Rendering — Design Document

**Status:** Draft v1 — Session 25
**Scope:** Dynamic water surfaces, underwater bathymetry, water classification,
type-specific behavior (ocean / sea / lake / river), color sampling from imagery,
semi-transparency, and integration with quantized-mesh terrain + 3D Tiles.
**Audience:** CesiumJS WebGPU fork maintainers
**Sibling doc:** [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md)
— water consumes the same Sun/Moon directions, atmospheric conditions, and
volumetric fog froxel grid defined there.

---

## 1. Goals & Non-Goals

### Goals

1. **Believable, semi-transparent water surfaces** driven by quantized-mesh
   terrain — not flat blue polygons. Wave normals, Fresnel reflections,
   subsurface tint, foam at coastlines, refractive distortion of the bed.
2. **Underwater bathymetry rendering** — when terrain elevation goes below
   the local water datum, show the seabed/lakebed through the water column
   with depth-based color attenuation (Beer–Lambert).
3. **Imagery-driven base color** — the dominant water tint at any tile is
   sampled from the imagery layers and/or 3D Tiles surface color, not a
   hard-coded RGB. Murky river → brown, tropical reef → cyan, glacial lake
   → milky teal, deep ocean → near-black, all driven by source data.
4. **Water type taxonomy** — ocean, sea / large lake, lake, river. Each
   type has its own wave amplitude / frequency / direction model, foam
   behavior, transparency depth, and flow profile.
5. **Quantized-mesh integration** — use the existing
   [quantized-mesh](https://github.com/CesiumGS/quantized-mesh) terrain
   tiles for both the water surface tessellation and the underwater
   bathymetry mesh. Reuse the existing water-mask extension (1 byte per
   vertex / per tile) where it exists, augment where it doesn't.
6. **Spatial activation control** — water effects can be enabled globally,
   disabled globally, or scoped to a specific region (bounding rectangle,
   polygon, or tileset). The user can say "ocean shader on, but only
   inside this AOI" without breaking other content.
7. **Per-feature togglability** — every subsystem (surface waves, foam,
   refraction, caustics, underwater fog, flow maps, imagery tinting,
   each water type) is independently toggleable from `Scene` properties.
8. **Backend-agnostic Scene API** — toggles work identically on WebGL and
   WebGPU. Renderer differences hidden behind feature renderers.
9. **Graceful degradation** — when classification data is missing, fall
   back to the existing water-mask path; when that's missing, fall back to
   "no water" (status quo). Never produce a worse render than today.

### Non-Goals (out of scope)

- Full SPH/FLIP fluid simulation. We render *surfaces*, not solve
  Navier–Stokes. Flow is procedural / advected, not simulated.
- Boat / object buoyancy physics. Wave height is queryable; physics is
  the application's job.
- Subsurface scattering accurate to oceanographic models (Jerlov water
  types are referenced as a guide, not an authority).
- Tide simulation. A tide *offset* can be plugged in, but we don't
  compute lunar tides ourselves (Sun/Moon positions are available from
  the celestial doc if an app wants to drive it).
- River network hydrology / flow rate from elevation. Flow direction is
  taken from data (vector field, OSM tags, manual hint), not derived.
- Underwater geometry beyond what bathymetry already provides (no
  procedural reefs, kelp, fauna).

---

## 2. Prior Art / Reference

| Title | Why we care |
|---|---|
| **Subnautica** (Unknown Worlds) | Best-in-class consumer ocean: depth-based fog with distinct shallow/mid/deep colors, surface caustics on bed, Fresnel + reflection probes, foam at intersections, view-from-below sky shimmer. Their water is a *volume* with separate "above" and "below" materials sharing one boundary. |
| **No Man's Sky** (Hello Games) | Planet-scale water with type variation per planet (toxic, frozen, normal). Uses a global ocean datum + biome-driven tint. Underwater god rays via raymarched in-scattering (similar to the celestial doc's froxel grid). |
| **Sea of Thieves** (Rare) — Acton/Gonzalez-Ochoa SIGGRAPH 2018 | Gerstner sum + FFT hybrid. Foam advected via flow map. Wake interaction. Their displacement-from-flow technique is the reference for rivers. |
| **Crysis / Ryse** Tiago Sousa SIGGRAPH talks | Practical Fresnel + screen-space refraction + planar reflection blends. Cheap and ships at 60fps. |
| **Frostbite — Wave Particles** (Jeschke) | Localized disturbance propagation (drops, splashes, boat wakes) on top of a base wave field. Out-of-scope v1 but worth noting for boat support. |
| **Tessendorf "Simulating Ocean Water"** | Canonical FFT ocean reference. We use a simplified Gerstner sum at v1, FFT is a Phase 4 upgrade. |
| **Cesium quantized-mesh ext** | Already gives us a water mask byte per tile vertex. We extend with a *type* byte and (optionally) a *flow* RG. |

---

## 3. Existing Water Code In The Engine

We are not starting from zero. The current state:

- `Source/Scene/Material.js` — `Water` material with ripple noise, normal
  map, blend factor. Used by 3D Tiles and Primitive paths.
- `Source/Shaders/Materials/Water.glsl` + WGSL twin
  (`PrimitiveMatWaterLit.wgsl`, `PrimitiveMatWaterFlat.wgsl`).
- `Source/Shaders/Materials/WaterMaskMaterial.glsl` — debug visualization
  of the per-tile water-mask texture.
- `Source/Scene/GlobeSurfaceTile.js` — `waterMaskTexture` +
  `waterMaskTranslationAndScale`. Populated from
  `terrainData.waterMask` when `terrainProvider.hasWaterMask`.
- `Source/Shaders/GlobeFS.glsl` + `GlobeTerrain.wgsl` — sample the water
  mask, branch into a "water material" path that adds wave normals and a
  hard-coded blue tint.

The v1 work in this doc is, at its core: **replace the hard-coded blue
tint with imagery-sampled color, replace the single-frequency ripple
with a multi-octave Gerstner sum, add a depth-based transparency term
driven by bathymetry, and split behavior by water type**. Most of the
plumbing already exists.

---

## 4. Architecture Overview

```
                         Scene flags + region masks
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │  WaterClassificationProvider    │  ← per-tile mask + type + flow
                    │  (water mask + type + flow)     │
                    └─────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │  WaterParameterStore            │  ← global tunables, type LUT
                    │  (per-type wave/optic params)   │
                    └─────────────────────────────────┘
                                    │
                       ┌────────────┴────────────┐
                       ▼                         ▼
              ┌────────────────┐        ┌────────────────┐
              │ Globe surface  │        │ 3D Tileset      │
              │ water shader   │        │ water shader    │
              │ (terrain tile) │        │ (model surface) │
              └────────────────┘        └────────────────┘
                       │                         │
                       └────────────┬────────────┘
                                    ▼
                    ┌─────────────────────────────────┐
                    │  Shared WGSL/GLSL water module  │
                    │  - Gerstner / FFT displacement  │
                    │  - Fresnel + reflection         │
                    │  - Beer-Lambert depth tint      │
                    │  - Foam / caustics              │
                    │  - Imagery base color sample    │
                    └─────────────────────────────────┘
                                    │
                                    ▼
                  Compose with celestial doc's froxel
                  grid for in-water god rays + fog
```

### 4.1 WaterClassificationProvider

The hardest problem in the entire doc: **what is water and what is land**.
Solved differently per scale:

| Scale | Source | Confidence |
|---|---|---|
| Global ocean | Quantized-mesh `waterMask` extension byte (already exists) + low-res bathymetry (e.g. GEBCO 2024 at 15 arcsec) for the "below sea level" check | High |
| Coastlines / shoreline detail | OSM `natural=coastline` vector tiles, optionally rasterized into a coastline distance field per tile | High |
| Large lakes / inland seas | OSM `natural=water` polygons + Natural Earth `lakes` shapefile, rasterized to the same per-tile mask | High |
| Rivers | **Hard problem.** See §4.1.1 below | Variable |
| Small lakes / ponds | OSM `natural=water` + JRC Global Surface Water dataset | Medium |
| Custom user AOIs | Application-supplied `WaterRegion` (rectangle, polygon, or tileset) overrides everything | Authoritative |

The provider returns, per terrain tile: a packed RGBA texture where
- **R** = water mask (0 = land, 255 = water)
- **G** = water type ID (0 = none, 1 = ocean, 2 = sea/large lake, 3 = lake, 4 = river)
- **B** = flow direction packed (atan2 → 0..255), or 128 (no flow)
- **A** = flow speed / wave amplitude scalar

This texture lives alongside the existing `waterMaskTexture` slot. The
existing `Globe.terrainProvider` water mask becomes one of many *inputs*
to the classification provider rather than the only source.

#### 4.1.1 Rivers — the hard problem

Rivers are hard because:
1. They are 1D features (centerlines) at low zoom but become 2D polygons
   at high zoom. Vector data has neither at the same time.
2. The width is rarely tagged. OSM has `width=*` on maybe 5% of rivers.
3. They flow, and flow direction matters for the shader.
4. They cross terrain tile boundaries arbitrarily.

**Suggested approach (v1 — pragmatic):**

- **Source:** OSM `waterway=river|stream|canal` lines + `natural=water`
  polygons (the latter covers large rivers that *do* have polygon data,
  Amazon, Mississippi, Rhine).
- **Width inference:** Strahler stream order from a global river network
  dataset (HydroRIVERS by HydroSHEDS is freely licensed and gives
  per-segment order + estimated discharge). Width = `f(strahler_order,
  discharge)`. Cached client-side from a vector tile service.
- **Rasterization:** At terrain tile load, the classification provider
  rasterizes river centerlines into the tile's mask using the inferred
  width as a stamp radius. Anti-aliased edges via signed-distance.
- **Flow direction:** The OSM line direction is the canonical flow
  direction (OSM convention is upstream → downstream). Flow speed is
  proportional to discharge / width.
- **Polygon overrides:** Where polygon data exists, it wins over the
  centerline raster — large rivers get accurate banks.
- **Manual override / hint API:** Apps can provide `WaterRegion` objects
  with explicit polygon + type + flow vector for any waterway the
  automatic pipeline gets wrong.

**Future upgrades (Phase 4+):**
- ML-based water segmentation from imagery (Sentinel-2 Water Index,
  NDWI). Run offline, bake into a 3D-Tiles overlay tileset.
- JRC GSW seasonal water dataset to catch ephemeral/seasonal rivers.
- User-provided GeoPackages for site-specific projects (dam reservoirs,
  flood inundation modeling).

### 4.2 Water type taxonomy

Each type has a row in a parameter LUT:

| Type | Wave amplitude | Wave freq | Direction model | Foam threshold | Beer-Lambert k | Notes |
|---|---|---|---|---|---|---|
| Ocean | 0.5 – 4.0 m | 0.05 – 0.3 Hz | Wind vector + dominant swell | Low (lots of whitecaps) | 0.05 / m (deep blue) | Big rolling waves, long wavelengths |
| Sea / large lake | 0.2 – 1.5 m | 0.1 – 0.5 Hz | Wind vector | Medium | 0.08 / m | Shorter chop, fetch-limited |
| Lake | 0.02 – 0.3 m | 0.3 – 1.5 Hz | Wind vector or flat | High (rare foam) | 0.10 – 0.40 / m (more turbid) | Tiny ripples, often glassy |
| River | 0.05 – 0.4 m | flow-locked | **Flow vector** | Around obstacles only | 0.30 – 0.80 / m (very turbid) | Direction = flow, foam at flow speed > threshold |

The Beer-Lambert `k` values are starting points; the imagery-tinting
pass (§4.5) modulates them per location.

### 4.3 Surface displacement

**v1:** Sum of N Gerstner waves (default N=4 ocean, N=2 sea, N=2 lake,
N=0 river — rivers use flow displacement only). Parameters from the
type LUT, modulated by `windSpeed` and `windDirection` from the
celestial doc's `AtmosphericConditions`.

**v1 river extension:** Additive flow displacement — `displace +=
flowDir * sin(time * freq + worldPos . flowDir * scale) * amplitude`.
This produces moving ripples that travel *with* the current rather than
omnidirectional waves. Around obstacles (banks), a curl-noise term
deflects the displacement.

**Phase 4 upgrade:** FFT-based ocean (Tessendorf/Mastin). Drop-in
replacement for the Gerstner sum, kept behind a toggle because it's
heavier.

### 4.4 Underwater bathymetry & depth attenuation

Quantized-mesh terrain already supports negative elevations (most ocean
basins, Dead Sea, etc.). The work is:

1. **Render the terrain bed** as it does today, no special handling.
2. **Render a separate water surface mesh** from the same terrain tile,
   clamped to the local water datum (sea level for ocean/sea, lake
   surface elevation for lakes, river surface from a river-surface
   model). This mesh is *only emitted* where the classification mask
   says "water".
3. **Compute water column depth** in the surface fragment shader as
   `depth = waterDatumHeight - sceneDepth`, by sampling the scene depth
   buffer (already available — see `WebGPUSceneFramebuffer`'s
   `depthSamplable`).
4. **Apply Beer-Lambert** color attenuation to whatever the depth buffer
   refraction picks up:
   `transmittance = exp(-k * (1 + 1/cosTheta) * depth)` with `k` from
   the type LUT, modulated per channel (R attenuates fastest, B
   slowest → that's why deep water is blue).
5. **Composite** the attenuated bed color with the surface reflection
   via Fresnel (Schlick).

**Crucial:** the depth-from-buffer sample must be the *opaque scene
depth*, before water itself was drawn. We render water in a dedicated
pass after opaque geometry, before transparent/OIT, with depth read but
not written for the wave tops (and depth written for the water datum
plane to keep underwater geometry behind it from re-occluding).

**Underwater god rays** come for free if the celestial doc's froxel grid
is enabled — the same in-scattering integration, fed a slightly
different phase function and absorption coefficient when the camera is
under water.

### 4.5 Imagery-driven base color

This is the user's headline ask: "the water should take on the color of
the water surface imagery from the terrain or 3DTiles."

**Approach:**

1. **Sample the imagery layers** the way the existing terrain shader
   does, at the surface UV. The terrain renderer already composites N
   imagery layers — we get the composited RGB for free.
2. **Where the classification mask is "water"**, treat that imagery RGB
   as the **base subsurface color** rather than as the surface albedo.
   It feeds the Beer-Lambert tint and the deep-water color asymptote.
3. **Convert to a tint, not an absolute color:** average a 3×3
   neighborhood, push toward saturation slightly, and clamp luminance
   so a too-bright Bing Maps tile doesn't make the ocean glow. The tint
   blends with the per-type default so totally absent imagery still
   produces a reasonable color.
4. **3D Tiles surface color contribution:** if a tileset is flagged as
   `containsWaterSurface = true`, sample its diffuse output the same
   way during the water pass. Useful for high-resolution photogrammetry
   tilesets where the water area has accurate aerial color.

The result: the same shader produces an opaque tropical lagoon over a
Maxar tile, a brown turbid Mississippi over a USGS tile, and a deep
indigo Pacific over Bing — without any per-region tuning.

### 4.6 Foam, caustics, refraction

- **Foam at coastlines:** sample the classification mask gradient. Where
  `length(grad(mask)) > 0` (mask edge) and the surface displacement is
  rising, deposit foam. Foam intensity decays over ~1 m of penetration
  inland into the water.
- **Foam from waves:** when local wave slope > type-dependent threshold,
  add whitecap foam. Driven by the same Gerstner sum used for normals.
- **Foam around obstacles (rivers):** screen-space — sample the depth
  buffer at neighboring fragments, where `abs(depthSelf - depthNeighbor)
  < ε` and the obstacle is upstream of the flow vector, add foam.
- **Caustics on the bed:** procedural — sum of two Worley noise octaves
  scaled by the surface wave normals, projected onto the bed via the
  view ray after refraction. Cheap, looks great, completely fake.
- **Refraction:** screen-space — perturb the UV used to sample the
  scene color buffer by `surfaceNormal.xy * refractionStrength /
  depth`. Falls back to no-refraction when the perturbed UV samples a
  non-water pixel (avoids the classic edge-bleed artifact).

### 4.7 Spatial activation control — `WaterRegion`

The user explicitly asked for "control when and where the water tech is
active". The `WaterRegion` system provides this:

```js
scene.waterRegions.add(new WaterRegion({
  geometry: rectangle,           // or polygon, or tileset bounding region
  enabled: true,
  type: WaterType.OCEAN,         // override classification for this AOI
  surfaceElevation: 0.0,         // local water datum
  flowDirection: undefined,      // for rivers
  effects: {                     // per-effect toggles for this region
    waves: true,
    foam: true,
    caustics: true,
    refraction: true,
    underwaterFog: true,
  },
}));
```

Regions are evaluated in declaration order; the last matching region
wins. A region with `enabled: false` *disables* water inside it, even
if classification says it's water — useful for "render this dam
reservoir as terrain, not water".

A global `scene.waterEffectsEnabled = false` disables everything
without removing regions (cheap kill switch for performance probes).

---

## 4.8 Performance & Scale Strategy

**Constraint:** Must work at planet scale (visible from orbit) AND look
good at ground level (camera 1m above a lake), at 60fps on mid-range
hardware (RTX 3060 / M2 / Steam Deck class). The solution can never
afford a per-fragment cost proportional to "all the world's water".

The performance plan is built around three principles: **distance-based
LOD on every cost axis**, **cull aggressively before any water-specific
work runs**, and **share compute with systems that already pay it**.

### 4.8.1 Distance LOD bands

| Band | Range from camera | Surface mesh | Wave model | Foam | Refraction | Caustics | Imagery tint |
|---|---|---|---|---|---|---|---|
| **Near** | 0 – 200 m | Per-vertex displacement on quantized-mesh terrain at full res | Gerstner N=4 + flow + curl noise | Full (mask gradient + wave slope + obstacle) | Screen-space refraction enabled | Procedural caustics on bed | Full 3×3 sample |
| **Mid** | 200 – 5 km | Quantized-mesh at one LOD coarser, displacement still per-vertex | Gerstner N=2 | Wave-slope only, no obstacle foam | Disabled (use Fresnel + flat refraction approximation) | Disabled | Single sample |
| **Far** | 5 – 50 km | Quantized-mesh at terrain LOD, displacement in normal map only | Sum of two scrolling normal maps (no vertex displacement) | Static foam from precomputed mask | Disabled | Disabled | Single sample, lower mip |
| **Horizon** | > 50 km | Terrain mesh, no separate water mesh | Pre-baked normal map mip | Baked into the normal map | None | None | Type-default tint, no imagery sample |
| **Orbital** | > ~200 km altitude | Water mask drives a flat color tint *only* — same shader path as the existing Globe water-mask, no displacement, no foam, no separate pass | — | — | — | — | Coarse imagery |

The band selection is per-tile, evaluated against tile center distance.
Tiles are stable LOD-band-wise across frames (no thrashing) because the
band thresholds carry hysteresis.

### 4.8.2 Culling order — water never costs more than terrain

Before *any* per-fragment water work runs, a tile must pass these gates,
in order, on the CPU side of the renderer:

1. **Master toggle.** `scene.waterEffectsEnabled === false` → skip.
2. **Frustum cull.** Same frustum cull terrain already does — water
   surface mesh inherits the terrain tile's bounding volume.
3. **Classification non-empty.** If the tile's classification mask is
   all-zero (no water in this tile), skip the entire water pass for
   the tile. The mask is sampled once at tile load and a "has water"
   bit is cached on the tile.
4. **Distance band.** If the tile is in the **Orbital** band, no
   separate water pass runs at all — the existing water-mask path
   handles it.
5. **Region exclude.** If a `WaterRegion` with `enabled: false` covers
   the tile, skip.
6. **Occlusion cull.** Reuse the terrain occlusion test (already
   computes per-tile horizon culling) — if the tile is occluded, skip.

Result: an Earth view from orbit pays *zero* incremental cost over the
existing water-mask render. A view of a lake at ground level pays the
full near-band cost only on the tiles actually containing the lake.

### 4.8.3 Shared compute with terrain & celestial

The water pass deliberately reuses work other passes already do:

- **Imagery sampling** is done once in the terrain shader and forwarded
  to the water shader as a varying / a small G-buffer slot — not
  re-sampled. (Open question §7 confirms this is feasible.)
- **Scene depth** sampling for refraction + Beer-Lambert reuses the
  already-existing `depthSamplable` aspect on `WebGPUSceneFramebuffer`
  (added for the Tier 2 depth-as-color debug overlay). No extra
  resolve.
- **Sun/Moon direction** comes from the celestial doc's
  `CelestialState` UBO — no per-water computation.
- **Volumetric fog froxel grid** (celestial §4.8) is sampled, not
  re-marched, when underwater. Underwater fog adds zero raymarch cost
  on top of the celestial system.
- **Sky cubemap** for reflection is the same atmosphere-rendered cubemap
  the sky uses. No second probe render in v1.
- **Per-tile water classification** is built once at tile load (off the
  hot path, async) and cached on the tile alongside the existing water
  mask. Per-frame cost is one texture binding, not a recompute.

### 4.8.4 GPU compute budget targets (mid hardware, 1080p)

| Scene | Target water cost |
|---|---|
| Earth from orbit, ocean visible | **0 ms** (status quo path) |
| Coastal city, mid-band ocean visible | **0.4 – 0.8 ms** |
| Ground-level lake shore, near band | **1.0 – 1.6 ms** |
| First-person on a small boat, ocean horizon | **1.5 – 2.2 ms** |
| Underwater, near + mid band + god rays | **2.5 – 3.5 ms** (god rays cost paid by celestial froxel; water adds ~0.5ms) |

These are budgets, not promises — confirmed once Phase 2 ships and
profiling lands.

### 4.8.5 Memory budget

- Classification mask: 256×256 RGBA8 per visible terrain tile = 256 KB.
  ~200 tiles visible at any time = 50 MB. Cached LRU.
- Per-type wave parameter LUT: < 1 KB total.
- Procedural caustics noise textures: 2× 256×256 R8 = 128 KB shared
  across all tiles.
- Wave normal maps (far/horizon bands): 2× 512×512 RG8 = 1 MB shared.
- No per-tile state beyond the classification cache.

Total water-specific GPU memory at typical viewer: **~52 MB**.

### 4.8.6 What we explicitly do NOT pay for

- No per-tile shader compilation. The water shader is one variant per
  *band*, not per tile. 5 pipelines total (orbital reuses terrain).
- No CPU-side wave simulation. All displacement is procedural in the
  vertex shader.
- No reflection probe renders in v1. Cubemap reflection only.
- No SDF generation per frame. The classification mask is a raster,
  built once per tile.
- No cross-tile communication. Each tile shades independently.

---

## 4.9 PBR water — what's actually available

The user asked: "is there PBR support for water or liquid in WebGL or
WebGPU?"

**Short answer:** No standard library / built-in. Both APIs are
rendering APIs, not material libraries — neither ships a "PBR water"
material. Water in every modern engine is a *custom shader* that
combines PBR primitives (Cook-Torrance Fresnel, GGX microfacets,
energy-conserving BRDF) with water-specific terms that PBR alone
doesn't model.

### 4.9.1 What "PBR water" means in practice

Real water rendering combines several physical models that are each
PBR-ish but no single one captures water:

| Term | Standard PBR? | Water needs |
|---|---|---|
| Fresnel reflection | Yes — Schlick approximation universal | F0 = 0.02 for water (vs 0.04 for skin/dielectrics) |
| Microfacet BRDF (GGX) | Yes — every PBR engine | Roughness driven by *small-scale* wave slope, not a constant |
| Specular IBL from a probe | Yes — every PBR engine | The probe must be the *sky cubemap*, not a baked light probe |
| Subsurface tint via Beer-Lambert | **Not standard PBR.** | Required — that's why deep water is blue |
| Refraction with index of water (n=1.33) | **Not standard PBR** (raster PBR assumes opaque surfaces) | Required — bed visible through water |
| Volumetric in-scattering | **Not standard PBR.** | Required for god rays + underwater fog |
| Caustics on submerged surfaces | **Not standard PBR.** | Required for shallow water look |

So the answer is: **PBR gives us about half the water shader for free
(Fresnel + GGX + IBL probe), and we have to write the rest**.

### 4.9.2 In CesiumJS specifically

- **WebGL path:** The existing `Source/Shaders/Materials/Water.glsl` is
  pre-PBR — it uses an old Phong-ish reflection model. The PBR codepath
  in Cesium (`czm_pbrLighting`, used by glTF / 3D Tiles) is not wired
  into water. So there is currently *no* PBR water in either the
  WebGL or WebGPU path of the engine.
- **WebGPU path:** Same — the WGSL water material
  (`PrimitiveMatWaterLit.wgsl`) was a 1:1 port and inherited the same
  pre-PBR reflection.
- **Available PBR primitives we can reuse:** `czm_pbrLighting`,
  `czm_pbrMetallicRoughnessMaterial` (GLSL); the WGSL twins in
  `Source/Shaders/WebGPU/chunks/`. They contain Schlick Fresnel, GGX
  distribution, Smith geometry, energy-conserving Lambert + GGX
  combination — exactly what we need for the surface reflection term.

### 4.9.3 What this design uses

This doc's water shader uses the engine's existing PBR helpers for the
surface BRDF (Fresnel + GGX, F0 = 0.02, roughness from local wave
slope), combines that with the water-specific Beer-Lambert / refraction /
caustics / foam terms that PBR alone doesn't model, and lights the
result with the celestial doc's Sun + Moon + sky cubemap as the IBL
probe. The result is energy-consistent with the rest of the PBR
materials in the engine — water hit by sunlight reflects and absorbs
the same total energy as a 3D Tiles building hit by the same sunlight.

**Open question §7.8:** Should we publish a `czm_pbrWaterLighting` WGSL
chunk + GLSL twin so the PBR water shader is reusable from custom
materials, or keep it inlined in the water module? Lean toward
publishing for parity with the rest of `czm_pbr*`.

---

## 5. Toggle Inventory

All on `Scene` (forwarded to `frameState` in the existing pattern):

```js
// Master switches
scene.waterEffectsEnabled               // global on/off
scene.waterUseClassificationProvider    // false → fall back to terrainProvider waterMask only

// Per-effect toggles
scene.water.enableSurfaceWaves
scene.water.enableFoam
scene.water.enableCaustics
scene.water.enableRefraction
scene.water.enableImageryTinting
scene.water.enableUnderwaterFog          // routes through celestial froxel grid
scene.water.enableUnderwaterGodRays      // requires froxel grid + sun shadow map
scene.water.enableFlowMaps               // rivers
scene.water.enableBathymetryPass

// Per-type toggles
scene.water.types.ocean.enabled
scene.water.types.sea.enabled
scene.water.types.lake.enabled
scene.water.types.river.enabled

// Tunables
scene.water.windSpeedOverride            // null → use AtmosphericConditions
scene.water.windDirectionOverride
scene.water.tideOffset                   // meters added to ocean datum
scene.water.imageryTintStrength          // 0..1 blend of imagery vs type-default
scene.water.refractionStrength
scene.water.foamThreshold
scene.water.causticsIntensity
scene.water.maxRenderDistance            // far cull distance for water pass

// Debug
scene.debugShowWaterClassification       // visualize the RGBA mask
scene.debugShowWaterDepth                // depth-as-color but only for water column
scene.debugShowWaterType                 // colored by type ID
scene.debugDisableWaterDisplacement      // flat surface, useful for shader bring-up
```

Each toggle flips a frameState bool. Hot-loop discipline applies (read
once outside the per-tile loop, branch to a cold-path pipeline variant
only when active), same as the Tier 2 debug system.

---

## 6. Phases

| Phase | Scope | Sessions |
|---|---|---|
| **1 — Foundation** | `WaterClassificationProvider` skeleton, RGBA mask texture, fall-through to existing `waterMaskTexture`, `WaterRegion` API + scene flags. No shader changes yet. | 1 |
| **2 — Surface shader v1** | Replace existing ripple with Gerstner sum, type LUT, imagery-tinted base color, Fresnel + reflection (sky cubemap probe). Both WGSL + GLSL. Toggle via `enableSurfaceWaves`. | 2 |
| **3 — Bathymetry & depth** | Water datum mesh, depth-buffer sampling, Beer-Lambert column attenuation, refraction via screen-space UV perturbation. | 1.5 |
| **4 — Foam & caustics** | Coastline foam from mask gradient, wave-slope whitecaps, screen-space obstacle foam, procedural caustics on bed. | 1 |
| **5 — Rivers** | Flow vector pipeline, OSM/HydroRIVERS classification, flow displacement model, river-specific shader branch. | 1.5 |
| **6 — Underwater & god rays** | Camera-under-water transition, underwater fog routed through celestial froxel grid, in-scattering god rays, surface-from-below shimmer. | 1 |
| **7 — Spatial control** | `WaterRegion` evaluation in classification provider, per-region toggles, debug visualization. | 0.5 |
| **Total v1** | | **8.5** |
| **Phase 8+ (future)** | FFT ocean, wave particles for boat wakes, ML-segmented water from imagery, seasonal river masks (JRC GSW), tide model | optional |

---

## 7. Risks & Open Questions

### Risks

1. **River classification accuracy.** OSM coverage is uneven; HydroRIVERS
   width inference will be wrong sometimes. Mitigated by `WaterRegion`
   manual overrides, but apps will need to provide them in poorly-mapped
   regions.
2. **Imagery-tint stability across LOD transitions.** When the imagery
   layer changes resolution, the sampled base color jumps. Need to
   blend smoothly across the transition (probably via the same 3×3
   average, taken from the lower-resolution mip).
3. **Z-fighting at the water datum.** Water surface mesh vs terrain
   mesh at exactly sea level. Mitigated by rendering water *after*
   terrain with `depthCompare: less` and a tiny offset.
4. **Reflection probe cost.** Planar reflections are expensive (extra
   render pass). v1 uses the existing sky cubemap as a cheap
   approximation; full planar reflections deferred to Phase 8.
5. **Refraction edge artifacts.** Screen-space refraction breaks at the
   edge of water bodies. Standard mitigation (snap to non-refracted UV
   when the offset samples a non-water pixel) costs an extra mask
   sample per fragment.
6. **Quantized-mesh extension growth.** If we add a *type* byte and
   *flow* RG to the per-vertex water mask, we are extending an existing
   public format. We should keep this *additive* — old clients see the
   existing 1-byte mask and ignore the new fields.
7. **3D Tiles tilesets that already contain baked-in water surfaces.**
   Some photogrammetry tilesets bake reflective water into the texture.
   Drawing our water on top double-renders. Mitigated by the
   `containsWaterSurface` flag + region exclude.

### Open Questions

1. **Should `WaterClassificationProvider` be a singleton on `Scene` or
   pluggable per-globe?** Multi-globe setups exist.
2. **Should river width inference run in WASM?** Per-tile rasterization
   is hot. Lean toward WASM with a JS fallback (per CLAUDE.md WASM
   strategy).
3. **Default for `enableUnderwaterFog` when no froxel grid?** Fall back
   to a cheap exp depth-fog or disable entirely?
4. **How does water interact with 3D Tiles classification?** Existing
   classification API exists for highlighting features under terrain;
   does it compose with water classification or override it?
5. **Tide source.** Plug user-provided tide function, or hard-code zero?
   Lean toward "user-provided callback, default zero."
6. **Per-region wave parameter overrides.** Should `WaterRegion` allow
   overriding individual Gerstner waves, or only the type? Lean toward
   type-only at v1, individual override at Phase 8.
7. **Imagery sampling cost.** We already sample imagery in the terrain
   shader; can the water pass reuse the result via a varying instead of
   re-sampling? Likely yes — investigate during Phase 2.

---

## 8. Decision Points (need answers before Phase 1)

1. **Water type taxonomy.** OK with the four-type model
   (ocean / sea / lake / river)? Or do we need more (estuary, wetland,
   ice-covered, glacier melt)?
2. **River source data licensing.** OK to depend on HydroRIVERS
   (CC-BY 4.0) and OSM (ODbL) by default? Both are free but ODbL has
   share-alike implications for derived tiles.
3. **Default for `waterEffectsEnabled`.** On or off in fresh
   `Scene` instances? Lean toward **off** (status quo behavior), with
   a one-line opt-in.
4. **Quantized-mesh extension.** Are we willing to publish an additive
   extension to the format spec for type + flow? Or keep all that data
   in a separate tileset and only consume the existing 1-byte mask?
5. **3D Tiles author flag.** Add a `containsWaterSurface` boolean to
   3D Tiles metadata, or detect via heuristics?
6. **Phase 1 blocking.** Should this doc proceed in parallel with the
   celestial doc, or is one a prerequisite for the other? They share
   the froxel grid for underwater fog/god rays — celestial Phase 5a
   (froxel infrastructure) is a prerequisite for water Phase 6, but
   water Phases 1–5 can run independently.
7. **Region API shape.** `scene.waterRegions.add(...)` collection vs
   `scene.water.regions.add(...)` namespaced. Lean toward the latter to
   keep `Scene` flat.

---

## 9. Cross-references

- [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md) §4.8
  (volumetric fog froxel grid) — water reuses this for underwater fog
  + god rays.
- [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md) §4.x
  (atmospheric conditions) — water consumes `windSpeed`, `windDirection`,
  `cloudCover` for surface displacement and reflection brightness.
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — water work
  will be added as a new top-level section once decision points are
  resolved.
- Quantized-mesh format: <https://github.com/CesiumGS/quantized-mesh>
- HydroRIVERS / HydroSHEDS: <https://www.hydrosheds.org/products/hydrorivers>
- JRC Global Surface Water: <https://global-surface-water.appspot.com/>

---

*End of v1 draft. Decision points 1–7 in §8 should be answered before
Phase 1 implementation begins. Phase 6 (underwater god rays) is
gated on celestial doc Phase 5a.*
