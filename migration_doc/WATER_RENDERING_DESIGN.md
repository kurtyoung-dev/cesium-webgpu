# Water Rendering — Design Document

**Status:** Draft v2 — Session 25 + 2026-04-08 decisions locked (C1-C14)
**Scope:** Dynamic water surfaces, underwater bathymetry, water classification,
type-specific behavior (ocean / sea / lake / river / wetland + future slots),
color sampling from imagery, semi-transparency, and integration with
quantized-mesh terrain + 3D Tiles.
**Audience:** CesiumJS WebGPU fork maintainers
**Sibling doc:** [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md)
— water consumes the same Sun/Moon directions, atmospheric conditions, and
volumetric fog froxel grid defined there.
**Decision log:** [SESSION_2026-04-08_RESEARCH_REPORT.md §8.3](SESSION_2026-04-08_RESEARCH_REPORT.md#83--c-series-water-rendering-design-14-questions)
locks all 14 C-series decisions referenced throughout this doc. When in doubt
on a value, that section is the source of truth.

> **Implementation status (2026-05-30):** **Phase 0 + Phase 0.3 are DONE.**
> The canonical-home facade shipped: `GlobeWater.js` exists and is reached as
> `scene.globe.water` (`Globe.js:560` `get water()` → `this._water`,
> delegating to the legacy `showWaterEffect` / `oceanNormalMapUrl` /
> enhanced-ocean fields). **Phases 1–9 remain unbuilt** — no
> `WaterClassificationProvider`, no Gerstner surface shader, no bathymetry,
> foam, caustics, river pipeline, or `WaterRegion` collection exists yet.
> The `scene.globe.water.*` toggle tree documented in §5 is the *planned*
> surface; only the upstream-owned `showWaterEffect` / `oceanNormalMapUrl` /
> enhanced-ocean leaves are live today. **Namespace note:** the canonical
> home is `scene.globe.water.*`, **not** `scene.water.*`. The design-session
> `scene.water.*` spelling in §4.7, §5.1, §6, §7, §8 has been reconciled to
> `scene.globe.water.*` to match the shipped Phase 0.3 facade; remaining bare
> `scene.water` mentions are intentional historical contrasts ("refined from
> the original `scene.water`").

> **Reading guide for v2:** §4 Architecture, §5 Toggle Inventory, and §6 Phases
> have been updated in place to reflect the locked decisions. New §9 documents
> the quantized-mesh Option A wire format. New §10 documents the OSM vocabulary
> + adapter pattern. New §11 documents the ODbL clean-ship licensing model.
> §7 (formerly "Open Questions") and §8 (formerly "Decision Points") are now
> "Resolved" sections that point at the canonical answers.

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
4. **Water type taxonomy** — six types: `OCEAN`, `SEA`, `LAKE`, `RIVER_AREA`
   (polygon-form rivers like the Amazon mainstem), `RIVER_LINE` (centerline-form
   rivers and streams that get extruded ribbons), `WETLAND`. Two future slots
   reserved: `GLACIER`, `ICE_SHELF`. Each rendered type has its own wave
   amplitude / frequency / direction model, foam behavior, transparency depth,
   and flow profile. Per **C8** locked decision, the canonical data vocabulary
   is **OSM tag names preserved verbatim** (`natural=water`, `water=lake`, etc.);
   the `WaterType` enum is a renderer-internal normalization helper. See §10.
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

> **Locked C1:** `WaterClassificationProvider` is **pluggable per globe**, not
> a singleton on `Scene`. Multi-globe setups get independent providers. The
> instance lives at `globe.water.classificationProvider` (mirrors how
> `globe.terrainProvider` works today).
>
> **Locked C8:** The provider's *internal cache* uses the packed RGBA
> texture format described below for fast per-fragment lookup. The *source
> data* keeps OSM tag names verbatim (`natural=water`, `water=lake`,
> `waterway=river`, etc.) — see §10 for the adapter pattern that translates
> between the two.

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
  Per **C2 locked decision**, this rasterization runs in **WASM with a JS
  fallback** following the CLAUDE.md WASM bridge pattern. WASM is the hot
  path for the per-tile rasterization step; JS fallback ensures
  WASM-disabled browsers (or feature-flag-off deployments) still produce
  correct output, just slower.
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

Per **C8 locked decision**, six rendered types in v1 plus two reserved future
slots. The enum is the renderer-internal normalization of OSM tag triples
(`natural=*`, `water=*`, `waterway=*`); see §10 for the full mapping table
and adapter pattern.

| Type ID | OSM source | Wave amplitude | Wave freq | Direction model | Foam threshold | Beer-Lambert k | Notes |
|---|---|---|---|---|---|---|---|
| `OCEAN` | `place=ocean`, `natural=coastline` (sea side) | 0.5 – 4.0 m | 0.05 – 0.3 Hz | Wind vector + dominant swell | Low (lots of whitecaps) | 0.05 / m (deep blue) | Big rolling waves, long wavelengths |
| `SEA` | `place=sea` | 0.2 – 1.5 m | 0.1 – 0.5 Hz | Wind vector | Medium | 0.08 / m | Shorter chop, fetch-limited |
| `LAKE` | `natural=water`+`water=lake\|pond\|reservoir\|basin\|lagoon\|oxbow` | 0.02 – 0.3 m | 0.3 – 1.5 Hz | Wind vector or flat | High (rare foam) | 0.10 – 0.40 / m (more turbid) | Tiny ripples, often glassy |
| `RIVER_AREA` | `natural=water`+`water=river\|canal` (polygon) | 0.05 – 0.4 m | flow-locked | **Flow vector** | Around obstacles only | 0.30 – 0.80 / m (very turbid) | Wide rivers like Amazon mainstem; renders as polygon fill |
| `RIVER_LINE` | `waterway=river\|stream\|canal\|drain\|ditch` (linear) | 0.02 – 0.2 m | flow-locked | **Flow vector** (line direction = downstream) | Obstacle-only | 0.40 – 1.00 / m | Centerline-form; renders as extruded ribbon at width inferred from Strahler order. See §4.1.1 |
| `WETLAND` | `natural=wetland`+`wetland=marsh\|swamp\|bog\|...` | 0.0 – 0.05 m | very low | Wind | None | 0.50 – 1.50 / m | Patchy, often vegetated; v1 uses a flat darker tint with no wave displacement |
| *(future)* `GLACIER` | `natural=glacier` | — | — | — | — | — | Reserved for Phase 9+ — frozen surface, sub-surface scattering, melt water |
| *(future)* `ICE_SHELF` | *no canonical OSM tag* | — | — | — | — | — | Reserved for polar regions; needs custom data source |

The Beer-Lambert `k` values are starting points; the imagery-tinting
pass (§4.5) modulates them per location. The renderer dispatches one
shader variant per *rendered* type — `WETLAND` shares a variant with
`LAKE` minus displacement, `RIVER_LINE` and `RIVER_AREA` share a flow
shader with different mesh generation paths.

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

> **Locked C3:** When the celestial froxel grid is **not** enabled (the
> common case for users who haven't opted into the volumetric fog feature),
> `enableUnderwaterFog = true` falls back to a **cheap exponential
> depth-fog** in the water fragment shader: `fogColor =
> exp(-depthBelowSurface * underwaterFogDensity)`. This is a single multiply
> + exp per fragment, costs essentially nothing, and produces a believable
> "color washes out with depth" effect without any volumetric machinery.
> The fragment-shader path is the default; the froxel-grid path is the
> upgrade users get when they also enable celestial volumetric fog.

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
   containing baked-in water geometry (see below), sample its diffuse
   output the same way during the water pass. Useful for high-resolution
   photogrammetry tilesets where the water area has accurate aerial color.

> **Locked C12:** The "this tile contains baked-in water" hint is published
> via the **standard `EXT_structural_metadata` extension** with a custom
> Cesium semantic name: **`_CESIUM_CONTAINS_WATER_SURFACE`**. The producer
> declares it in the tileset's metadata schema (`tile` class, BOOLEAN
> property, semantic `_CESIUM_CONTAINS_WATER_SURFACE`) and sets it on
> each tile that has baked water. The Cesium client reads it via the
> existing structural-metadata API and uses it to suppress overlay water
> rendering on those tiles. **No 3D Tiles spec change required** —
> custom semantics with leading underscore are explicitly allowed by
> the spec. See `SESSION_2026-04-08_RESEARCH_REPORT.md §9.3` for the
> full spec analysis.
>
> For tilesets that DON'T set the flag (the common case for existing
> photogrammetry tilesets), Cesium provides a **per-tileset runtime
> override**: `tileset.containsWaterSurface = true`. This is the
> conservative path — heuristic detection (sampling tile content for
> blue pixels, checking glTF feature flags) is **NOT in v1**. Keep it
> explicit; users with photogrammetry tilesets opt out manually.

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
active". The `WaterRegion` system provides this.

> **Locked C14:** The collection is **namespaced** under `scene.globe.water`
> (Phase 0.3 refined the canonical home from the original `scene.water` —
> see §5), not hung directly off `Scene` as `scene.waterRegions`. This keeps
> `Scene` flat and follows the same pattern as other locked decisions in this
> session — every new water-related property goes under `scene.globe.water.*`,
> every new atmospheric property goes under `scene.globe.atmosphericConditions.*`.

```js
scene.globe.water.regions.add(new WaterRegion({
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

A global `scene.globe.water.enabled = false` (per **C10**, default `false`)
disables everything without removing regions (cheap kill switch for
performance probes). The legacy property `scene.waterEffectsEnabled`
is preserved as a delegating shell that reads/writes through to
`scene.globe.water.enabled` for backward compatibility — see the toggle
audit pattern in `SESSION_2026-04-08_RESEARCH_REPORT.md §9.5`.

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

1. **Master toggle.** `scene.globe.water.enabled === false` → skip.
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

> **Canonical home (Phase 0.3 update):** water state lives at
> `scene.globe.water`, **not** `scene.water`. Three reasons: (1) every
> existing water property already lives on `Globe`
> (`showWaterEffect`, `oceanNormalMapUrl`, `enableEnhancedOcean`, the
> `ocean*` tunables), (2) water is rendered as part of the terrain pass
> via the water mask, so it conceptually belongs to the globe, and (3)
> it pairs symmetrically with `scene.globe.atmosphericConditions`. The
> `scene.globe.water` facade **shipped** in the Phase 0.3 refactor
> (`GlobeWater.js`, `Globe.js:560`; pure delegation, zero behavior change).
> The `showWaterEffect` / `oceanNormalMapUrl` / enhanced-ocean leaves are
> live through it today; all other toggles listed below are the *planned*
> Phase 1+ surface and are accessed through the same facade once built.

All toggles live under the namespaced `scene.globe.water.*` tree per **C14**.
Per **C10**, `scene.globe.water.enabled` defaults to `false` (status quo
behavior; users opt in with one line). Each leaf is forwarded to
`frameState` in the existing pattern, with hot-loop discipline (read
once outside per-tile loop, branch to cold-path pipeline variant only
when active — same as the Tier 2 debug system).

```js
// ─── Master switches ──────────────────────────────────────────────
scene.globe.water.enabled                    // global on/off — DEFAULT: false (C10)
scene.globe.water.useClassificationProvider  // false → fall back to terrainProvider waterMask only

// ─── Per-effect toggles ───────────────────────────────────────────
scene.globe.water.surfaceWaves.enabled
scene.globe.water.foam.enabled
scene.globe.water.caustics.enabled
scene.globe.water.refraction.enabled
scene.globe.water.imageryTinting.enabled
scene.globe.water.underwaterFog.enabled      // routes through celestial froxel grid;
                                             //   when grid disabled, falls back to
                                             //   cheap exp depth-fog (C3)
scene.globe.water.underwaterGodRays.enabled  // requires froxel grid + sun shadow map
scene.globe.water.flowMaps.enabled           // rivers
scene.globe.water.bathymetry.enabled

// ─── Per-type toggles ─────────────────────────────────────────────
scene.globe.water.types.ocean.enabled
scene.globe.water.types.sea.enabled
scene.globe.water.types.lake.enabled
scene.globe.water.types.riverArea.enabled    // polygon-form rivers
scene.globe.water.types.riverLine.enabled    // centerline-form rivers
scene.globe.water.types.wetland.enabled
// Future: scene.globe.water.types.glacier, scene.globe.water.types.iceShelf

// ─── Tunables ─────────────────────────────────────────────────────
scene.globe.water.windSpeedOverride          // null → use AtmosphericConditions
scene.globe.water.windDirectionOverride
// ─── Sea-level datum + tide (SHIPPED Batch 763, C6-FFT-OCEAN-TIDE-DATUM) ──
scene.globe.water.oceanVerticalDatum         // "AUTO" | "ELLIPSOID" | "GEOID"
                                             //   DEFAULT "AUTO" — derived from the
                                             //   terrain provider. NOT a feature
                                             //   toggle: the ellipsoid-0 anchor was
                                             //   a measured 101.64 m defect over
                                             //   Cesium World Terrain (ruling T2)
scene.globe.water.tideEnabled                // DEFAULT true; false → tide term is
                                             //   EXACTLY 0
scene.globe.water.tideExaggeration           // DEFAULT 1.0 = true scale (ruling T3);
                                             //   > 1 is explicitly stylised
scene.globe.water.tideCallback               // (positionWC, time) => meters;
                                             //   undefined → the in-engine
                                             //   equilibrium Core/TideModel.js
                                             //   (ruling T1 SUPERSEDES OQ5's
                                             //   "null → 0"; use tideEnabled =
                                             //   false for no tide at all)
// Read-only per-frame diagnostics on scene.globe.water.ocean:
//   resolvedVerticalDatum, geoidUndulationMeters, tideHeightMeters,
//   anchorHeightMeters
scene.globe.water.imageryTintStrength        // 0..1 blend of imagery vs type-default
scene.globe.water.refractionStrength
scene.globe.water.foamThreshold
scene.globe.water.causticsIntensity
scene.globe.water.maxRenderDistance          // far cull distance for water pass
scene.globe.water.underwaterFog.density      // used by both froxel and exp paths
scene.globe.water.underwaterFog.expFallback  // bool — force exp path even if froxel available

// ─── Region collection (C14 namespaced) ───────────────────────────
scene.globe.water.regions                    // WaterRegionCollection
                                             //   .add(region), .remove, .removeAll, .get(i)

// ─── Debug ────────────────────────────────────────────────────────
scene.globe.water.debug.showClassification   // visualize the RGBA mask
scene.globe.water.debug.showDepth            // depth-as-color but only for water column
scene.globe.water.debug.showType             // colored by type ID
scene.globe.water.debug.disableDisplacement  // flat surface, useful for shader bring-up
```

### 5.1 Backward-compatibility shells

Apps written before v2 used flatter property names. To preserve them
without breaking, every legacy path becomes a delegating
getter/setter that reads/writes the new canonical home — same pattern
as the celestial doc's toggle audit (`SESSION_2026-04-08_RESEARCH_REPORT.md §9.5`):

```js
// Legacy → canonical delegation (illustrative — actual implementation
// in the Scene/Globe extension PR that lands before water Phase 1)
Object.defineProperty(Scene.prototype, "waterEffectsEnabled", {
  get() { return this.globe.water.enabled; },
  set(v) { this.globe.water.enabled = v; },
});
Object.defineProperty(Scene.prototype, "waterRegions", {
  get() { return this.globe.water.regions; },
});
```

This means existing apps that set `scene.waterEffectsEnabled = true`
keep working — the value flows through to the new canonical home. We
deprecate nothing in this pass; the legacy paths are documented as
"prefer the namespaced form" in JSDoc but never removed.

---

## 6. Phases

> **Locked C13:** Water and celestial run **in parallel**. Water Phases
> 1-5 are fully independent of the celestial work. Only **water Phase 6
> (underwater god rays)** depends on **celestial Phase 5a (froxel grid
> infrastructure)**, because that's the data structure water samples for
> in-scattering. If celestial Phase 5a slips, water Phase 6 ships with the
> cheap exp depth-fog fallback (C3) instead of god rays — Phases 1-5 are
> not blocked.
>
> Both designs share the **toggle audit + canonical home migration prep
> PR** documented in `SESSION_2026-04-08_RESEARCH_REPORT.md §9.5`. That
> PR is a prerequisite for both this design's Phase 1 AND celestial
> Phase 1, because it establishes the nested config object structure
> (`scene.globe.water.*` for water; `scene.globe.atmosphericConditions.*` for
> celestial) that both designs build on.

| Phase | Scope | Sessions | Depends on |
|---|---|---|---|
| **0 / 0.3 — Toggle audit prep PR** ✅ **DONE** | Canonical home migration: introduce the `scene.globe.water` facade (`GlobeWater.js`, `Globe.js:560`) + delegating shells for legacy paths. Pure delegation, no behavior change. Phase 0.3 refined the home from the originally-planned `scene.water` to `scene.globe.water` (water already lives on `Globe`). Shared with celestial doc. | 1-2 | None |
| **1 — Foundation** | `WaterClassificationProvider` skeleton (pluggable per globe per C1), RGBA mask texture (renderer-internal cache, OSM tag preservation in source data per C8), fall-through to existing `waterMaskTexture`, `WaterRegion` API + scene flags. No shader changes yet. | 1 | Phase 0 |
| **2 — Surface shader v1** | Replace existing ripple with Gerstner sum, type LUT, imagery-tinted base color, Fresnel + reflection (sky cubemap probe). Both WGSL + GLSL. Toggle via `scene.globe.water.surfaceWaves.enabled`. Investigate imagery sampling reuse via varying (C7). | 2 | Phase 1 |
| **3 — Bathymetry & depth** | Water datum mesh, depth-buffer sampling, Beer-Lambert column attenuation, refraction via screen-space UV perturbation. Cheap exp depth-fog fallback for `enableUnderwaterFog` (C3). | 1.5 | Phase 2 |
| **4 — Foam & caustics** | Coastline foam from mask gradient, wave-slope whitecaps, screen-space obstacle foam, procedural caustics on bed. | 1 | Phase 3 |
| **5 — Rivers** | Flow vector pipeline, OSM/HydroRIVERS classification (WASM rasterization per C2), flow displacement model, river-specific shader branch. Both `RIVER_AREA` (polygon) and `RIVER_LINE` (centerline) paths. | 1.5 | Phase 4 |
| **6 — Underwater & god rays** | Camera-under-water transition, underwater fog routed through celestial froxel grid (when available) or cheap exp fallback (always available), in-scattering god rays, surface-from-below shimmer. **Gates on celestial Phase 5a**, but ships with exp fallback if Phase 5a slips. | 1 | Phase 5 + (celestial Phase 5a optional) |
| **7 — Spatial control** | `scene.globe.water.regions` evaluation in classification provider, per-region toggles, debug visualization. | 0.5 | Phase 1 |
| **Total v1** | | **8.5 + 1-2 prep** | |
| **Phase 8+ (future)** | FFT ocean, wave particles for boat wakes, ML-segmented water from imagery, seasonal river masks (JRC GSW), tide model | optional | |
| **Phase 9+ (future)** | Quantized-mesh **Option B version bump** (see §9.2). Promote the additive water classification extension from Option A (extension ID 0x05) to a first-class format field via a coordinated quantized-mesh format version bump. Requires ecosystem coordination with cesium-native, Cesium for Unreal, and major third-party tilers. Schedule when ~6-12 months of Option A real-world usage is available. | 2-3 + coordination | Option A in production for 6-12 months |
| **Future** | `GLACIER` and `ICE_SHELF` water types | optional | |

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

### Open Questions — RESOLVED on 2026-04-08

All seven open questions from v1 have been answered. The canonical
answers live in `SESSION_2026-04-08_RESEARCH_REPORT.md §8.3`. Quick
pointer table:

| OQ | Resolution | Reference |
|---|---|---|
| OQ1 — `WaterClassificationProvider` singleton vs pluggable | **Pluggable per globe.** Lives at `globe.water.classificationProvider`. | C1 |
| OQ2 — River width inference in WASM | **WASM with JS fallback** per CLAUDE.md WASM bridge pattern. | C2 |
| OQ3 — `enableUnderwaterFog` default when no froxel grid | **Cheap exponential depth-fog fallback.** Single multiply + exp per fragment. See §4.4. | C3 |
| OQ4 — Water vs 3D Tiles classification interaction | **Compose, don't override.** They answer different questions through different APIs. Use `EXT_structural_metadata` for the water semantic — already supported by 3D Tiles 1.1, no spec change needed. See `SESSION_2026-04-08_RESEARCH_REPORT.md §9.3`. | C4 |
| OQ5 — Tide source | **SUPERSEDED 2026-07-24 by maintainer ruling T1** (`TIDES_FEASIBILITY_2026-07-24.md` §5a). The room the original answer left has been used: the callback stays (`scene.globe.water.tideCallback`, `(positionWC, time) => metres`) but its DEFAULT is no longer zero — an undefined callback now falls through to the in-engine equilibrium `Core/TideModel.js` (Simon-1994 ephemerides at the scene clock). "No tide at all" is `scene.globe.water.tideEnabled = false`, which makes the term EXACTLY 0. Amplitude control is `tideExaggeration` (default 1.0 = true scale, ruling T3). Regional prediction (EOT20 atlas, NOAA CO-OPS stations — ruling T5) is the follow-up slice and rides the same hook. Shipped Batch 763 on the FFT ocean anchor together with the vertical-datum term (ruling T2); §5 above is the live surface. | C5 |
| OQ6 — Per-region wave parameter overrides | **Type-only at v1**, individual Gerstner override at Phase 8. | C6 |
| OQ7 — Imagery sampling reuse cost | **Investigate during Phase 2** (likely viable via varying — no extra sample cost). | C7 |

---

## 8. Decision Points — RESOLVED on 2026-04-08

All seven decision points from v1 have been answered. The canonical
answers live in `SESSION_2026-04-08_RESEARCH_REPORT.md §8.3`. Quick
pointer table:

| DP | Resolution | Reference |
|---|---|---|
| DP1 — Water type taxonomy | **Six rendered types** (`OCEAN`, `SEA`, `LAKE`, `RIVER_AREA`, `RIVER_LINE`, `WETLAND`) plus two future slots (`GLACIER`, `ICE_SHELF`). OSM tag vocabulary preserved verbatim as the canonical data form; the enum is a renderer-internal normalization helper. See §4.2 and §10. | C8 |
| DP2 — River source data licensing | **Ship NO OSM data in the default build.** Sandcastle demo loads OSM live with proper attribution (`© OpenStreetMap contributors` + link). Document user licensing responsibility in API reference. **Zero ODbL exposure for Cesium itself.** See §11 and `SESSION_2026-04-08_RESEARCH_REPORT.md §9.4`. | C9 |
| DP3 — Default for water effects | **Off by default** (`scene.globe.water.enabled = false`), may revisit later. Backward-compat shell preserves the legacy `scene.waterEffectsEnabled` property. See §5.1. | C10 |
| DP4 — Quantized-mesh extension | **Ship Option A (backward-compatible additive) now**, using extension ID `0x05`. Document Option B (cleaner version-bumped format) as deferred long-term work for Phase 9+. See §9. | C11 |
| DP5 — `containsWaterSurface` flag | **No spec change.** Use custom `_CESIUM_CONTAINS_WATER_SURFACE` semantic via `EXT_structural_metadata`. Per-tileset runtime override (`tileset.containsWaterSurface = true`) for tilesets that don't set it. Heuristic detection NOT in v1. See §4.5. | C12 |
| DP6 — Phase 1 blocking | **Run in parallel with celestial.** Water Phases 1-5 are fully independent. Only water Phase 6 (underwater god rays) depends on celestial Phase 5a (froxel grid infrastructure) — and Phase 6 ships with the exp fallback (C3) even if Phase 5a slips. See §6. | C13 |
| DP7 — Region API shape | **Namespaced** (`scene.globe.water.regions.add(...)`), not flat. Keeps `Scene` flat. See §4.7. | C14 |

---

## 9. Future Spec Work — Quantized-Mesh Extension

Per **C11 locked decision**, water classification ships in two phases:
**Option A (additive, ID `0x05`)** in water Phase 1, **Option B (version
bump)** as deferred long-term work for Phase 9+. This section documents
both so the eventual migration path is clear.

### 9.1 Phase 1 — Option A (additive, ships now)

The existing quantized-mesh format already supports a sparse extension
mechanism: each tile carries an extension list where each entry is
identified by a 1-byte extension ID followed by a 4-byte length and the
extension's payload. The format reserves ID `0x01` for vertex normals,
`0x02` for the existing 1-bit water mask, `0x04` for tile metadata, etc.
**Unknown extension IDs are gracefully skipped** by all conformant
parsers — this is the existing format's escape hatch for additive
extensions.

We register **extension ID `0x05`** as the **water classification
extension**. When present, it appends additional optional buffers
*after* the existing 1-bit water mask. Old clients see ID `0x05` and
skip past its payload via the length prefix; new clients parse it.

**Wire format (ID `0x05` payload):**

```text
struct WaterClassificationExtension {
  // Number of texels in each per-texel array. Either 1 (uniform across
  // tile) or 256*256 (full per-texel resolution matching the existing
  // water mask). Same convention as the existing water mask.
  texelCount: uint32

  // One byte per texel: WaterType enum (0=none, 1=ocean, 2=sea, 3=lake,
  // 4=river_area, 5=river_line, 6=wetland, 7=glacier, 8=ice_shelf).
  // 9..255 reserved.
  waterType: uint8[texelCount]

  // Two signed shorts per texel: flow vector (X, Y) in tile-local
  // coordinates, normalized direction × intensity. (0, 0) = no flow.
  // Used for rivers and ocean currents. Optional — if texelCount is 1
  // and the single waterType is not a river type, this section may be
  // omitted (parsers detect via the extension's length prefix).
  flowVectorX: int16[texelCount]
  flowVectorY: int16[texelCount]
}
```

**Detection on the client side:** the existing extension dispatch loop
reads ID + length, checks if the ID is recognized, and either parses
or skips. Adding `case 0x05` to the parser is ~30 lines of code.

**Producer side:** terrain producers emit ID `0x05` ONLY when they
have classification data to publish. Older producers that don't know
about `0x05` continue to emit just the existing 1-bit water mask
(ID `0x02`) and the system falls back to the legacy single-bit
mask + per-tile defaults. **Zero coordination required** with
existing producers — they keep working unchanged.

**Why we ship Option A first even though Option B is cleaner:**

This is the same pattern we used for the 3D Tiles invalidation feed:
opt-in, additive, zero break. Option A's overhead is small (~3 bytes
per texel of optional data, only for tiles that publish the new
fields) and it lets us iterate on the wire format without coordinating
with every downstream consumer (cesium-native, Cesium for Unreal,
third-party tilers). We can ship Option A in parallel with the rest
of the water work, get real-world data on which fields are actually
useful, refine them, and only THEN propose Option B with the lessons
learned. Doing Option B first would mean designing in a vacuum and
immediately needing version 2 once we use it.

### 9.2 Phase 9+ — Option B (version bump, deferred long-term direction)

Once we have ~6-12 months of real-world Option A usage, the long-term
direction is to promote the water classification fields to first-class
status via a coordinated **quantized-mesh format version bump**. This
is the cleaner design but requires ecosystem coordination.

**What changes in Option B:**

1. **Bump the quantized-mesh format version** (e.g. from the current
   format version to `2.0` or to a new sibling extension spec).
2. **Define `waterType` and `flowVector` as required fields** for the
   new version, not optional buffers.
3. **Drop the extension-ID dispatch overhead** for the new fields —
   they live at fixed offsets in the new format header, parseable in
   constant time.
4. **Add new field types we couldn't fit in Option A:** higher-precision
   flow magnitudes, multi-band depth/turbidity (for sediment-laden
   rivers), wave amplitude per texel (for shallow-water shoaling
   effects), all things that real-world Option A usage will help us
   identify as worth elevating.
5. **Provide a migration path** from Option A → Option B for clients
   and producers that need to support both during the transition.

**Migration sequence (when triggered):**

1. **Survey real-world usage.** After 6-12 months of Option A in
   production, query producers and clients to identify which Option A
   fields are actually being used and which ones are missing.
2. **Refine the field set.** Drop unused fields, add high-demand fields,
   tune precision based on real data.
3. **Propose the version bump** as a formal quantized-mesh format
   change. Coordinate with the cesium-native team, Cesium for Unreal,
   and known third-party tiler maintainers (Mapbox, Felt, MapTiler,
   etc. that have shipped quantized-mesh consumers).
4. **Provide a deprecation timeline for Option A** optional buffers
   (probably 18-24 months from announcement to removal).
5. **Ship Option B as the canonical format**, with parser support for
   both Option A (for backward compat during the deprecation window)
   and Option B (for new producers).

**Why we're not doing this now:**

1. The structural-metadata path (per C12) handles everything we need
   for 3D Tiles content without touching quantized-mesh at all.
2. Extending a public format that's used by Cesium ion + Cesium for
   Unreal + cesium-native + every third-party producer is a significant
   coordination effort.
3. The benefit is marginal — most water classification can come from
   a separate vector overlay (OSM, HydroRIVERS) rather than baked into
   terrain.
4. If we later find we need per-texel flow vectors at globe scale
   (unlikely), Option A gives us the capability and Option B gives us
   the cleaner format.

**Status:** Documented here as the explicit deferred direction.
Schedule for water Phase 9+ or sooner if a coordinating opportunity
arises (e.g. simultaneous quantized-mesh changes from a related
feature). See `SESSION_2026-04-08_RESEARCH_REPORT.md §10 NEW-7` for the
backlog item.

### 9.3 Spec verification (NEW-5, completed 2026-04-09)

The original locked decisions C4 / C8 / C11 / C12 were drawn from
training-knowledge during the 2026-04-08 design session because the
research agent's web access was blocked. NEW-5 in
`SESSION_2026-04-08_RESEARCH_REPORT.md §10` queued a verify-before-shipping
re-check. Phase 0.6 of the implementation work executed that verification.
Results:

- **C4 — Bounding volume containment.** ✅ **Verified.** The 3D Tiles
  spec is explicit: *"The tree has spatial coherence; the content for
  child tiles are completely inside the parent's bounding volume."* This
  is a hard rule about **content**, not the children's bounding volumes
  themselves (a child's bounding volume may extend outside the parent's
  because children's bounding volumes are not guaranteed to be tightly
  fit). Our load-bearing assumption — that we can use a parent tile's
  bounding volume as an early-out for water-mask propagation and as an
  invalidation traversal pruning hint — holds, **provided we treat the
  parent's volume as enclosing child *content* rather than child volumes**.
  Adjust the §4 traversal pseudocode comments in any place that says
  "parent encloses child volumes" to "parent encloses child content".
  Source: [3d-tiles spec](https://github.com/CesiumGS/3d-tiles/tree/main/specification),
  [Cesium HLOD blog post](https://cesium.com/blog/2017/02/17/hierarchical-culling-with-children-bounding-volumes/).

- **C8 — Underscore-prefixed custom semantics.** ✅ **Verified, with
  refinement.** Two relevant facts: (1) glTF allows underscore-prefixed
  attribute names in any scope (`_TEMPERATURE`, `_VELOCITY`, etc.) without
  the spec constraining them — this is the existing escape hatch for
  vendor-defined attributes. (2) `EXT_structural_metadata` property IDs
  must match the regex `^[a-zA-Z_][a-zA-Z0-9_]*$`, so leading-underscore
  IDs are explicitly legal. **Refinement worth noting:** there is active
  community discussion ([KhronosGroup/glTF#2514](https://github.com/KhronosGroup/glTF/pull/2514))
  about whether custom attributes should also include an extension-name
  prefix for disambiguation when two extensions might define the same
  underscore name. Recommended pattern: `EXT_structural_metadata:_TEMPERATURE`
  in cases where collision is plausible. For our water vocabulary
  (`_OSM_natural`, `_OSM_water`, `_HYFEATURES_FType`, etc.) the prefix
  itself disambiguates, so the bare-underscore form is fine. Source:
  [EXT_structural_metadata spec](https://github.com/CesiumGS/glTF/tree/3d-tiles-next/extensions/2.0/Vendor/EXT_structural_metadata).

- **C11 — Quantized-mesh extension ID `0x05` is free.** ✅ **Verified.**
  Currently assigned IDs: `0x01` Oct-Encoded Per-Vertex Normals (terrain
  lighting), `0x02` Water Mask, `0x04` Metadata. ID `0x03` is also
  unassigned (gap not addressed in the spec). ID `0x05` is unassigned and
  available for the new water classification extension. Confirmed via
  [CesiumGS/quantized-mesh](https://github.com/CesiumGS/quantized-mesh).
  Action: **before shipping**, file a PR against the quantized-mesh repo
  registering `0x05` to formally reserve the ID and document the wire
  format from §9.1, so we don't race another extension proposal.

- **C12 — `EXT_mesh_features` for per-vertex tagging, `EXT_structural_metadata`
  for the schema.** ✅ **Verified, with corrected understanding.** These
  extensions are **complementary, not alternatives**. The split:
  `EXT_mesh_features` defines **feature IDs** at vertex / texel
  granularity (e.g. a `_FEATURE_ID_0` vertex attribute that distinguishes
  per-vertex features within a primitive). `EXT_structural_metadata`
  defines **the schema and storage** of the metadata that those feature
  IDs index into (property tables — column-major binary, indexed by
  feature ID). For per-vertex water type tagging on a glTF mesh inside
  3D Tiles, the correct pattern is **both**: use `EXT_mesh_features` to
  declare a per-vertex feature ID and `EXT_structural_metadata` to define
  the property table that maps each feature ID → `waterType` enum value.
  Update §4.5 / §10 / DP5 to mention both extensions explicitly rather
  than treating them as alternatives. The custom
  `_CESIUM_CONTAINS_WATER_SURFACE` semantic remains an
  `EXT_structural_metadata` tile-level metadata property (no per-vertex
  granularity needed for the hint flag). Source:
  [EXT_mesh_features spec](https://github.com/CesiumGS/glTF/tree/3d-tiles-next/extensions/2.0/Vendor/EXT_mesh_features),
  [Cesium fine-grained metadata blog post](https://cesium.com/blog/2022/05/31/fine-grained-metadata-in-3d-tiles-next/).

**Net impact on Phase 1 work:** all four C-decisions hold, with three
small refinements: (1) wording fix for C4 traversal pruning comments,
(2) future-proofing note for C8 prefix collisions (use full
`EXT_:_NAME` form if a collision arises), (3) PR-the-spec action item
for C11 before shipping ID `0x05`, (4) §4.5/§10/DP5 should describe
`EXT_mesh_features` + `EXT_structural_metadata` as a paired pattern not
alternatives.

---

## 10. Vocabulary & Adapter Pattern

Per **C8 locked decision**, this section documents how the water
classification system maps between source vocabularies and the
renderer-internal `WaterType` enum.

### 10.1 The pattern: source-native preserved, renderer-internal normalized

Cesium leans **OGC for transports (how data moves)** and **source-native
for vocabulary (what's inside the data)**. This is the pattern
established by the existing `createOsmBuildingsAsync` API at
[packages/engine/Source/Scene/createOsmBuildingsAsync.js](../packages/engine/Source/Scene/createOsmBuildingsAsync.js)
— see `SESSION_2026-04-08_RESEARCH_REPORT.md §9.6` for the full analysis.
The water rendering system follows the same pattern:

- **Wire format / transport:** OGC 3D Tiles + `EXT_structural_metadata`
  for 3D Tiles content; quantized-mesh + extension ID `0x05` (per §9.1)
  for terrain content. Both are OGC-aligned.
- **Vocabulary inside the metadata:** **OSM tag names preserved
  verbatim** when the source is OSM. Producers do NOT pre-translate
  OSM tags into a custom enum at ingestion time. The `feature['water']`
  property is literally the OSM `water=*` tag value.
- **Renderer-internal `WaterType` enum:** a **normalization helper**
  that the rendering shader consumes. The renderer reads the source
  vocabulary's tag triples, runs them through an adapter (§10.3),
  and produces a `WaterType` value at the last possible moment before
  sampling the water material.

### 10.2 OSM vocabulary reference

These are the canonical OSM tags the water renderer expects from
OSM-sourced data. Producers that bake OSM into 3D Tiles or
quantized-mesh tiles preserve these exactly.

**`natural=water`** with `water=*` subtype:

| OSM tag | `WaterType` |
|---|---|
| `water=lake` | `LAKE` |
| `water=pond` | `LAKE` |
| `water=reservoir` | `LAKE` |
| `water=basin` | `LAKE` |
| `water=lagoon` | `LAKE` |
| `water=oxbow` | `LAKE` (oxbow lake) |
| `water=wastewater` | `LAKE` (treatment basin) |
| `water=river` | `RIVER_AREA` (polygon-form river) |
| `water=canal` | `RIVER_AREA` |
| `water=ditch` | `RIVER_AREA` |
| `water=lock` | `RIVER_AREA` |

**`waterway=*`** for linear water features (centerlines):

| OSM tag | `WaterType` |
|---|---|
| `waterway=river` | `RIVER_LINE` |
| `waterway=stream` | `RIVER_LINE` |
| `waterway=canal` | `RIVER_LINE` |
| `waterway=drain` | `RIVER_LINE` |
| `waterway=ditch` | `RIVER_LINE` |
| `waterway=tidal_channel` | `RIVER_LINE` (tidal flow gets the river shader) |

**`natural=coastline`** with implicit sea-side convention (sea on the
right when walking along the line, OSM convention) → `OCEAN`.

**`place=sea`**, **`place=ocean`** → `SEA`, `OCEAN` respectively.

**`natural=wetland`** with `wetland=*` subtype:

| OSM tag | `WaterType` |
|---|---|
| `wetland=marsh` | `WETLAND` |
| `wetland=swamp` | `WETLAND` |
| `wetland=bog` | `WETLAND` |
| `wetland=fen` | `WETLAND` |
| `wetland=wet_meadow` | `WETLAND` |
| `wetland=mangrove` | `WETLAND` |
| `wetland=tidalflat` | `WETLAND` |
| `wetland=saltmarsh` | `WETLAND` |
| `wetland=reedbed` | `WETLAND` |

**`natural=glacier`** → `GLACIER` (future, Phase 9+).

### 10.3 Adapter pattern

The renderer's classification path uses a small adapter interface:

```js
/**
 * Maps source-native feature properties to a WaterType enum value.
 * Each adapter implements one source vocabulary; the renderer picks
 * the right adapter based on the data source.
 *
 * @interface WaterTypeAdapter
 */
class WaterTypeAdapter {
  /**
   * @param {object} feature  Feature properties from EXT_structural_metadata
   * @returns {WaterType}     The normalized type, or WaterType.UNKNOWN
   */
  classify(feature) { throw new Error("abstract"); }
}

class OsmWaterTypeAdapter extends WaterTypeAdapter {
  classify(feature) {
    const water = feature['water'];
    const waterway = feature['waterway'];
    const natural = feature['natural'];
    const place = feature['place'];
    const wetland = feature['wetland'];

    // Lakes / standing water
    if (water === 'lake' || water === 'pond' || water === 'reservoir' ||
        water === 'basin' || water === 'lagoon' || water === 'oxbow' ||
        water === 'wastewater') {
      return WaterType.LAKE;
    }
    // Polygon rivers
    if (water === 'river' || water === 'canal' ||
        water === 'ditch' || water === 'lock') {
      return WaterType.RIVER_AREA;
    }
    // Linear waterways
    if (waterway === 'river' || waterway === 'stream' ||
        waterway === 'canal' || waterway === 'drain' ||
        waterway === 'ditch' || waterway === 'tidal_channel') {
      return WaterType.RIVER_LINE;
    }
    // Ocean / sea
    if (natural === 'coastline' || place === 'ocean') return WaterType.OCEAN;
    if (place === 'sea') return WaterType.SEA;
    // Wetland
    if (natural === 'wetland') return WaterType.WETLAND;
    // Future: glacier
    if (natural === 'glacier') return WaterType.GLACIER;

    return WaterType.UNKNOWN;
  }
}

class HyFeaturesAdapter extends WaterTypeAdapter {
  // Maps OGC HY_Features hyf:waterBodyType / hyf:flowPathType to WaterType
  classify(feature) { /* ... */ }
}

class InspireHydrographyAdapter extends WaterTypeAdapter {
  // Maps INSPIRE Watercourse / StandingWater / Wetland / ShoreWaterBody to WaterType
  classify(feature) { /* ... */ }
}

class CityGmlWaterAdapter extends WaterTypeAdapter {
  // Maps CityGML 3.0 WaterBody / WaterSurface to WaterType
  classify(feature) { /* ... */ }
}

class CustomWaterTypeAdapter extends WaterTypeAdapter {
  constructor(classifyFn) { super(); this._fn = classifyFn; }
  classify(feature) { return this._fn(feature) ?? WaterType.UNKNOWN; }
}
```

**Default adapter:** `OsmWaterTypeAdapter` (the most common source).
Users with non-OSM data construct their own adapter or use one of
the bundled ones for HY_Features, INSPIRE, CityGML, etc. The
classification provider is configured with one or more adapters and
tries them in order until one returns a non-`UNKNOWN` value.

### 10.4 Why this pattern matters

1. **Matches existing Cesium precedent.** `createOsmBuildingsAsync` already
   uses raw OSM tag names in user-facing style expressions. Water follows
   the same pattern — users write `${feature['water']} === 'lake'` style
   conditions in their own water styles, just like the OSM Buildings
   example.
2. **Source-agnostic rendering.** The renderer doesn't care which adapter
   produced a `WaterType` value. New data sources are added by writing
   a new adapter — no changes to the rendering path.
3. **No translation lock-in.** Source data keeps its original vocabulary.
   If a user later wants to migrate from OSM to OGC HY_Features, the
   data conversion happens once in their pipeline; the Cesium client
   just swaps adapters.
4. **OGC standards friendly without picking a single vocabulary.** The
   transport is OGC; the adapters cover multiple standardized
   vocabularies. Users with strict OGC-compliance requirements use the
   `HyFeaturesAdapter` or `InspireHydrographyAdapter`. Users with OSM
   data use the default. Both work.

---

## 11. Licensing & Distribution

Per **C9 locked decision**, this section documents the licensing model
for water classification data. The full legal analysis lives in
`SESSION_2026-04-08_RESEARCH_REPORT.md §9.4`.

### 11.1 What we ship in the default Cesium build

**No OSM-derived data.** The default Cesium build contains zero
pre-baked water polygons, river centerlines, coastlines, or any other
OSM-sourced classification data. The build ships only the *capability*
to consume such data from a `WaterClassificationProvider` the user
configures.

**Result: zero ODbL exposure for Cesium itself.** Cesium engine code
stays Apache-2.0, no share-alike obligations enter the dependency tree,
commercial users get a clean license story.

### 11.2 Sandcastle demo pattern

The Sandcastle demo for water rendering loads OSM data **live** at
runtime via a public Overpass API endpoint or a hosted GeoJSON file.
The demo's HTML page displays the required attribution prominently:

```html
<!-- Required by ODbL when using OSM-derived data -->
<div class="cesium-attribution">
  Water classification:
  © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
</div>
```

The demo's *output* (the rendered scene + the HTML page itself) is a
**Produced Work** under ODbL terminology, not a Derivative Database.
Produced Works only require attribution, not share-alike. This is the
same legal model used by Mapbox, Leaflet, OpenLayers, MapLibre, and
every other tool that demonstrates OSM data in their docs.

### 11.3 User responsibility

Cesium documentation MUST tell users they are responsible for the
licensing of any data they bring to the water classification system:

```text
NOTE: Water classification data sourced from OpenStreetMap is licensed
under the Open Database License (ODbL). If you use OSM data with this
feature, your application must display attribution prominently
("© OpenStreetMap contributors") and link to https://www.openstreetmap.org/copyright.
For other data sources (HydroRIVERS / HydroSHEDS, JRC Global Surface
Water, commercial vendors), consult the source's license terms.
Cesium itself does not include any pre-licensed water data in the
default build.
```

This text (or equivalent) goes in the JSDoc for `WaterClassificationProvider`,
in the user-facing API reference, and in the Sandcastle demo's
description panel.

### 11.4 Why this matches existing Cesium precedent

`OpenStreetMapImageryProvider` already follows this exact pattern in
upstream Cesium today:

- The class is Apache-2.0
- The user provides the tile URL
- The OSM attribution requirement falls on the user's deployment
- Cesium itself doesn't ship any baked-in OSM tile data

The water classification system uses the same approach. **This is not
a new policy** — it's the application of an existing Cesium policy to
a new feature.

---

## 12. Cross-references

- [SESSION_2026-04-08_RESEARCH_REPORT.md §8.3](SESSION_2026-04-08_RESEARCH_REPORT.md#83--c-series-water-rendering-design-14-questions)
  — locked C1-C14 decisions referenced throughout this doc
- [SESSION_2026-04-08_RESEARCH_REPORT.md §9.3](SESSION_2026-04-08_RESEARCH_REPORT.md#93--c4-3d-tiles-already-supports-water-classification-via-ext_structural_metadata)
  — full 3D Tiles spec analysis for water classification
- [SESSION_2026-04-08_RESEARCH_REPORT.md §9.4](SESSION_2026-04-08_RESEARCH_REPORT.md#94--c9-odbl-share-alike-legal-note-osm-data-licensing)
  — full ODbL legal analysis
- [SESSION_2026-04-08_RESEARCH_REPORT.md §9.5](SESSION_2026-04-08_RESEARCH_REPORT.md#95--toggle-audit-findings-current-state-of-sceneglobefogatmosphere-toggles)
  — toggle audit + canonical home migration prep PR (Phase 0)
- [SESSION_2026-04-08_RESEARCH_REPORT.md §9.6](SESSION_2026-04-08_RESEARCH_REPORT.md#96--c8-how-cesium-handles-osm-data-today-createosmbuildingsasync-precedent)
  — full analysis of OSM vocabulary precedent in Cesium
- [SESSION_2026-04-08_RESEARCH_REPORT.md §10](SESSION_2026-04-08_RESEARCH_REPORT.md#10-new-backlog-items-from-this-session)
  — new backlog items, including NEW-7 (Quantized-mesh Option B version bump)
- [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md) §4.8
  (volumetric fog froxel grid) — water reuses this for underwater fog
  + god rays (when celestial Phase 5a is available; cheap exp depth-fog
  fallback per C3 when not)
- [CELESTIAL_ATMOSPHERE_DESIGN.md](CELESTIAL_ATMOSPHERE_DESIGN.md) §4.x
  (atmospheric conditions) — water consumes `windSpeed`, `windDirection`,
  `cloudCover` for surface displacement and reflection brightness
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — water work
  will be added as a new top-level section once Phase 0 lands
- [packages/engine/Source/Scene/createOsmBuildingsAsync.js](../packages/engine/Source/Scene/createOsmBuildingsAsync.js)
  — existing precedent for OSM tag preservation (see line 48 example)
- Quantized-mesh format: <https://github.com/CesiumGS/quantized-mesh>
- HydroRIVERS / HydroSHEDS: <https://www.hydrosheds.org/products/hydrorivers>
- JRC Global Surface Water: <https://global-surface-water.appspot.com/>
- 3D Tiles 1.1 specification: <https://github.com/CesiumGS/3d-tiles>
- 3D Tiles `EXT_structural_metadata`:
  <https://github.com/CesiumGS/3d-tiles/tree/main/extensions/3DTILES_metadata>
- ODbL legal text and Produced Work guidelines:
  <https://wiki.osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline>

---

*End of v2 draft. All 14 C-series decisions are locked — see §7 and §8
for the resolution tables. Phase 0 / Phase 0.3 (toggle audit prep +
canonical-home facade) have **shipped** — `GlobeWater.js` is live at
`scene.globe.water` (`Globe.js:560`); Phases 1–9 remain unbuilt. Water
Phase 1 (the `WaterClassificationProvider` foundation) is the next
implementation step. Phase 6 (underwater god rays) gates on celestial
Phase 5a, but ships with the cheap exp depth-fog fallback (C3) even if
Phase 5a slips. Phase 9+ (Quantized-mesh Option B version bump) is the
deferred long-term direction documented in §9.2.*
