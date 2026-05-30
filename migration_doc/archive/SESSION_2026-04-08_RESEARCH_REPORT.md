> **ARCHIVED 2026-05-30** — historical point-in-time snapshot, superseded. NOT a live tracker. Live successors + index: `migration_doc/README.md`. Still-open items were lifted to `DEFERRED_WORK.md` (see its "Carried-forward on archive" section).

# Session 2026-04-08 — Max-Effort Research Report

**Date:** 2026-04-08 (decisions locked through end of session)
**Implementation status update (2026-04-09):** Phase 0 (8 sub-phases — toggle audit, canonical homes, VPT skeleton, invalidation feed Phase 1 with 4 path encodings, NEW-5 spec verification, snapshot mode skeleton) ✅ shipped. Phase 1.1 + Phase 1.2 of the celestial work (toggle scaffolding, MoonLight + ephemeris + lit-hemisphere shading + earthshine + phase gating + full WebGL parity moon port with bounding-cube ray-march + render bundle integration + snapshot freezable registration) ✅ shipped. See `WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-04-09)" for the full inventory and `WEBGPU_DEBUGGING_LOG.md` Session 27 for the moon parity bug history. **NEW-1, NEW-2, NEW-5, NEW-8 closed; NEW-3 partially landed (skeleton); NEW-9 added (quantized-mesh upstream PR).**
**Scope:** Full-stack review of the cesium-webgpu fork — bugs, tech debt, upstream divergence, comparison against modern WebGPU renderers and GIS viewers, a concrete design for live 3D Tiles invalidation that matches the user's real producer format, and **44 locked decisions** spanning the invalidation feed (A1-A7), celestial atmosphere design (B1-B23), and water rendering design (C1-C14).

**Working principle:** Where this report references competing renderers and viewers, it reads them as **inspiration sources** — what underlying *user needs* do they serve well? Cesium's job is not to copy their feature lists but to serve those needs better, with our specific advantages (WebGPU, RTE 64-bit precision, dual-backend, planet-scale, simulation-driven workflows).

**How to read this report:** Sections 1-7 are the original research findings. Section 8 is the **definitive decision log** for everything resolved during this session — when implementation begins, that section is the source of truth. Section 9 contains supporting analysis (A4 spec finding, A7 snapshot mode explanation, C8 OSM-vs-OGC pattern, C9 ODbL legal note, toggle audit). Section 10 is the new backlog items this session generated.

---

## Table of Contents

1. [Build Variant Infrastructure (shipped this session)](#1-build-variant-infrastructure-shipped-this-session)
2. [Codebase Audit (49 findings)](#2-codebase-audit-49-findings)
3. [Upstream Divergence](#3-upstream-divergence)
4. [WebGPU Renderer Landscape — User Needs Analysis](#4-webgpu-renderer-landscape--user-needs-analysis)
5. [GIS Viewer Landscape — User Needs Analysis](#5-gis-viewer-landscape--user-needs-analysis)
6. [Live 3D Tiles Invalidation — Final Design](#6-live-3d-tiles-invalidation--final-design)
7. [Synthesized Roadmap](#7-synthesized-roadmap)
8. [Decisions Locked This Session (A1-A7, B1-B23, C1-C14)](#8-decisions-locked-this-session-a1-a7-b1-b23-c1-c14)
9. [Supporting Analysis (Appendices)](#9-supporting-analysis-appendices)
10. [New Backlog Items From This Session](#10-new-backlog-items-from-this-session)

---

## 1. Build Variant Infrastructure (shipped this session)

The fork now produces three independent bundle variants from a single source tree:

| Variant | Output | Cesium.js (min) | index.js (min) | Default backend |
|---|---|---|---|---|
| **Dual** | [Build/Cesium](Build/Cesium) | **6.8 MB** | **5.6 MB** | WebGPU (auto-fallback to WebGL) |
| **WebGL-only** | [Build/CesiumWebGL](Build/CesiumWebGL) | — | **4.5 MB** | WebGL |
| **WebGPU-only** | [Build/CesiumWebGPU](Build/CesiumWebGPU) | — | **3.8 MB** | WebGPU |

Gzipped baseline: dual is ~1.9 MB, WebGPU-only is ~1.1 MB — a **44% download reduction** for users who explicitly opt out of the WebGL backend.

### How it works

- **`bundleVariantPlugin.js`** — esbuild plugin that aliases backend-specific imports to empty stubs based on the requested variant. WebGPU-only builds redirect every GLSL shader string to `scripts/stubs/emptyShader.js`; WebGL-only builds redirect every WebGPU module to `scripts/stubs/emptyModule.js` (a Proxy that throws if anyone tries to construct it).
- **`setGlobalDefaultRenderer()`** in [RendererType.ts](packages/engine/Source/Renderer/RendererType.ts) — added this session. Each variant's generated entry barrel calls it at module init time so `RendererType.AUTO` resolves to the right backend without user configuration.
- **ESM code-splitting** (`splitting: true` + `chunkNames: "chunks/[name]-[hash]"`) — the existing dynamic `import("./WebGPU/WebGPUContext.js")` in [ContextFactory.ts](packages/engine/Source/Renderer/ContextFactory.ts) now produces a separate `chunks/WebGPUContext-LMKCA7BX.js` (~288 KB minified). WebGL-first dual users no longer pay for it on cold start.
- **Gulp tasks**: `buildCesiumDual`, `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildAllVariants` (the last one hoists `buildEngine` + `buildWidgets` to a single shared pre-step so it doesn't rebuild them 3×).

### Bundle audit — non-trivial leftovers

- **`google-earth-dbroot-parser.js`** is 414 KB raw / ~80 KB gzipped, statically loaded by `Scene/GoogleEarthEnterpriseTerrainProvider.js`. Move behind `import()` — ~80 KB win for users who don't use Google Earth Enterprise.
- **`Assets/IAU2006_XYS/`** — 1.8 MB of astronomical data, currently lazy-fetched on first time-transform. Verify this hasn't regressed.
- **Source maps** — `Cesium.js.map` is 27 MB. Should be served only via the `SourceMap:` header (devtools-on-demand), not as a default sibling URL.
- **Per-feature renderer code splitting** — VoxelPrimitive, GaussianSplat, ProceduralClouds, WeatherParticles, DeferredGBuffer, SSR, Cloud collections are all in the main bundle but used by <10% of users. Estimated 200-500 KB gzipped if split behind dynamic imports keyed off the FeatureRendererKey registry.

---

## 2. Codebase Audit (49 findings)

Source: parallel research agent ran a thorough sweep over `packages/engine/Source/Renderer/WebGPU/` (105 files, ~54k LOC) and `packages/engine/Source/Shaders/WebGPU/` (242 WGSL files), cross-referenced with the migration backlog.

### Critical & high-severity (act on within 1-2 sessions)

| ID | Issue | File:Line | Why it matters |
|---|---|---|---|
| **AUDIT-1** | Lazy renderer loaders fail silently | [WebGPUFeatureRenderers.ts:301-446](packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts#L301) | GAUSSIAN_SPLAT, POINT_CLOUD, POINT_CLOUD_EDL, SSR, WEATHER_PARTICLES, PROCEDURAL_CLOUDS use `registerFeatureRendererLoader()`. If the dynamic `import()` rejects (network error, CSP block, wrong path) the feature renderer never gets registered and `getFeatureRenderer()` returns null — scene code crashes downstream with "cannot read property 'update' of null". **Wrap each load in a try/catch with a one-time warning.** |
| **AUDIT-2** | Subgroup feature requested but never validated | [WebGPUDevicePool.ts:273-279](packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts#L273), [WebGPUPerformanceManager.ts:951-954](packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts#L951) | We request optional `subgroups` from the device but `pointCloudLODUsesSubgroups()` generates subgroup-using WGSL without verifying the device actually got the feature. Pipeline creation will fail on devices that don't support it. **Gate on `device.features.has("subgroups")` before generating the variant.** |
| **AUDIT-3** | Hi-Z + OcclusionTest dispatchers wired but never invoked | [WebGPUPerformanceManager.ts:957-979](packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts#L957) | FORK-41. Two compute shaders compiled and registered but no frame-loop call site. Either dead code or unfinished feature — both shaders deliver 5-20× speedups on dense 3D Tiles per the migration matrix, so this is leaving a major perf win on the floor. |
| **AUDIT-4** | Device-loss recovery has synchronous-throw escape paths | [WebGPUContext.ts:261, 269, 313, 3211](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L261) | `WebGPUDeviceLossRecovery` handles loss after the device exists, but `requestDevice()` failures throw synchronously and bypass recovery. Edge platforms fail hard. |
| **AUDIT-5** | BUG-11: imagery layers bind but don't render | [WebGPUGlobeSurfaceRenderer.ts:801](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts#L801) | Backlog has 3 hypothesis branches (reprojection clear alpha=0; texCoordsRect init bug; stale view in `_imageryTextureCache`). Needs in-browser probe — code-level audit ruled out the obvious things. |
| **AUDIT-6** | SHADOW-LAYOUT — single fixed cast pipeline | [WebGPUShadowMapRenderer.js](packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) | Stride-24 RTE layout assumed. Quantized terrain (stride 8/12), instanced meshes, model PBR layouts produce garbage shadows or get filter-skipped. **Pipeline cache keyed on vertex layout.** |
| **AUDIT-7** | Test coverage 13% | [Specs/Renderer/WebGPU/](packages/engine/Specs/Renderer/WebGPU/) | 14 spec files for 104 source files. Critical untested paths: WebGPUContext (3334 LOC), WebGPUGlobeSurfaceRenderer (2320), WebGPUSceneRenderer (1685), WebGPUFeatureRenderers (registration logic). |

### Medium-severity (cleanup over next 2-4 sessions)

- **AUDIT-8**: Naga transpiler swallows errors silently. Three `eslint-disable no-console` over `console.warn` calls. The `_nagaUnavailable` flag exists but downstream callers may not check it. → [WebGPUNagaTranspiler.ts:96-120](packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts#L96)
- **AUDIT-9**: Shader compile errors lack source/stage/diagnostic context. Throws generic "Failed to create shader" — debugging is impossible. → [WebGPUShaderCache.ts:348, 434](packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts#L348)
- **AUDIT-10**: 35+ raw `console.warn/error` calls bypass `context.log()`. Top offenders: `WebGPUDeviceLossRecovery.ts` (5), `WebGPUGlobeSurfaceRenderer.ts` (4), `WebGPUIndirectDrawManager.ts` (3), `WebGPUContext.ts` (3), `WebGPUComputeEngine.ts` (3).
- **AUDIT-11**: ~50 `as any` casts across the WebGPU TS code. Worst offenders: `WebGPUSceneRenderer.ts` (14 sites), `WebGPUBufferPrimitiveRenderer.ts` (12), `WebGPUContext.ts` (6+). Almost all are internal state-tracking properties — should be typed instance fields, not escape hatches.
- **AUDIT-12**: 6 files >1000 LOC violating CLAUDE.md decomposition rule:
  - `WebGPUContext.ts` (3334) — extract device init / stub state setup / registry into companions
  - `WebGPUGlobeSurfaceRenderer.ts` (2320) — extract uniform packing / pipeline cache / tile resource cache
  - `WebGPUPrimitiveCommands.js` (1808)
  - `WebGPUSceneRenderer.ts` (1685) — extract pass execution / environment effects / dispatch
  - `WebGPUBufferPrimitiveRenderer.ts` (1478)
  - `WebGPUPerformanceManager.ts` (1469)
- **AUDIT-13**: `WebGPUF16Utils.ts` exists but production adoption unclear.
- **AUDIT-14**: WGSL preprocessor's transitive struct resolution fix (FORK-15) scope is unclear; nested chunks may still break.

### Low-severity / cleanup

- Debug log artifacts left in [WebGPUGlobeSurfaceRenderer.ts:795-803](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts#L795) ("DEBUG — remove after fixing")
- `WebGPUResourceManager` + `WebGPUPickManager` removed (FORK-2) without migration note
- `WebGPUCubeMapPanoramaRenderer.js:614` returns undefined from a critical path
- FORK-8: one residual `panoramaCommand.isWebGPUDrawCommand` check in Scene.js

**Aggregate severity:** 7 HIGH+, 25 MEDIUM, 17 LOW.

---

## 3. Upstream Divergence

```
40 commits behind upstream/main
41 commits ahead
```

### What's in the 40 upstream commits

Mostly type-system improvements (Color, Matrix2/3/4, PickId, Cesium3DTileFeature converted to ES6 classes), JSDoc cleanups, CesiumWidget BufferPrimitiveCollection support. Low-content commits, but they touch our hot files.

### Files we modified that upstream also touched (conflict risk on next sync)

| File | Upstream commits | Our commits | Risk |
|---|---|---|---|
| `Renderer/Context.js` | several | 5 | **HIGH** (we ES6'd it + extends GraphicsContext) |
| `Widget/CesiumWidget.js` | several | 3 | **HIGH** (createAsync + LoadingOverlay) |
| `Scene/BufferPrimitiveCollection.js` | 1 | 2 | Medium |
| `Scene/Cesium3DTileset.js` | 1 | 1 | Medium |
| `Scene/EquirectangularPanorama.js` | 1 | 1 | Medium |
| `Scene/ImageryProvider.js` | 1 | 1 | Medium |
| `Renderer/PickId.js` | 1 | 1 | Low |
| `Core/Color.js`, `Core/Matrix4.js` | 1 each | 1 each | Low |

**Recommendation:** Schedule an upstream sync within 1-2 weeks while the divergence is still manageable. The Context.js merge will be the most delicate — read upstream's PR notes carefully because 5 of our commits touch it.

---

## 4. WebGPU Renderer Landscape — User Needs Analysis

**Reframing note:** The original agent report listed "70 features Cesium is missing." This section reorganizes those findings around *underlying user needs*, identifies which needs Cesium uniquely positioned to serve, and proposes a Cesium-flavored response — not a copy.

### Where Cesium WebGPU is already ahead

These aren't features to add — they're moats to defend and build on:

| Capability | Why nobody else has it |
|---|---|
| **RTE 64-bit emulated precision throughout** | Three.js, Babylon, PlayCanvas all use single-precision world coordinates. None of them can render the full Earth without jitter. |
| **Multi-context registry + per-view backend** | Three.js's `WebGPURenderer` is one-per-app. We support split-screen, mixed backends, and offscreen-canvas worker rendering as a first-class concept. |
| **Logarithmic depth + reversed-Z combined** | Niche but Cesium's specialty. |
| **Full IBL compute pipeline** (BRDF/irradiance/radiance prefilter) | Par with Three.js, ahead of PlayCanvas WebGPU. |
| **Planetary atmosphere LUT** | Bevy 0.14 just shipped equivalent — we've had it. |
| **Naga GLSL→WGSL compatibility stub** | Three.js has TSL but no GLSL transpile path; Babylon has node materials but doesn't accept arbitrary GLSL. We can run legacy shaders nobody else can. |
| **WGSLShaderPreprocessor with `#import` chunks** | Closer to a real shader module system than anything in the JS ecosystem. |

### User needs that competing engines serve well — and how Cesium should respond

Each row identifies a *user need*, the competitor that addresses it well, and what a Cesium-native response should look like (rather than a verbatim copy).

#### Need 1: "My outdoor scene has hard, uniform shadows that don't follow the light source"

**Inspiration:** Three.js `webgpu_shadowmap_csm`, Babylon's CSM, every game engine. Cascaded Shadow Maps split the view frustum into N depth ranges and use a different shadow map per range, dramatically improving outdoor shadow quality.

**Cesium-native response:** CSM **plus** the SHADOW-LAYOUT fix (per-vertex-layout cast pipeline cache) **plus** a hook for time-of-day that integrates with Cesium's existing solar position calculator. We're a globe renderer — our CSM should automatically pick cascade ranges based on the camera's altitude above the ellipsoid (different from terrestrial game engines), and our default sun direction should come from `Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame()`. **5-7 days, includes SHADOW-LAYOUT.**

#### Need 2: "Aliasing is unacceptable on long thin features (power lines, road edges)"

**Inspiration:** TAA in Three.js, Babylon, PlayCanvas. Reprojects the previous frame using a velocity buffer and accumulates samples temporally.

**Cesium-native response:** TAA — but the velocity buffer is **also** the building block for two more Cesium-specific things: (a) reprojection-based async picking (reduces stale-pick jitter from camera movement), and (b) motion blur on fast-moving entities (CZML-driven aircraft trails). One pass of work, three deliverables. **4-5 days.**

#### Need 3: "I have a city with hundreds of street lights and my framerate dies"

**Inspiration:** Filament's Forward+ / clustered lighting. Three.js `webgpu_lights_tiled`. Babylon and PlayCanvas both ship clustered.

**Cesium-native response:** Clustered forward — but the cluster-build compute shader should reuse our existing `WebGPUSubgroupUtils` for the histogram step (subgroupBallot collapses per-thread atomics into per-subgroup atomics, ~3× faster than the typical implementation). And the cluster grid should be **logarithmic in Z** to match our log-depth buffer, which terrestrial engines don't need but planetary scale demands. **5-7 days.**

#### Need 4: "I want haze, fog, god rays — atmosphere that *feels* like atmosphere"

**Inspiration:** Three.js `webgpu_postprocessing_godrays` + `webgpu_volume_lighting_*`. Bevy 0.14 `Atmosphere`.

**Cesium-native response:** Volumetric fog **integrated with our existing `AtmosphereLUT.wgsl`** — we already compute the precomputed scattering tables for Nishita-style sky rendering, and a froxel-based fog pass can sample the same data. This is a unique advantage: Three.js's atmosphere is per-fragment, ours is precomputed. The volumetric pass is 30% cheaper because the LUT is already there. **5-7 days.**

#### Need 5: "My GPU is sitting idle while the CPU encodes 2000 tile draws"

**Inspiration:** Babylon's Snapshot Rendering Mode (FAST) — records the GPU command list once and replays it until scene topology changes. PlayCanvas does similar with persistent render bundles.

**Cesium-native response:** Snapshot mode **on top of our existing `WebGPURenderBundleManager`** — we already cache render bundles per-tile-list. The new piece is invalidation tracking: any property change that affects a draw command (style, visibility, lighting, sort order) bumps a version number, and we only re-encode bundles whose version is stale. The "static globe inspection" use case — locked camera looking at a single tileset — should run at near-zero CPU after warm-up. This is **uniquely valuable for geospatial inspection workflows**, where the camera is often pinned during analysis. **4-6 days.**

#### Need 6: "I want to render my own particle systems (smoke, dust, sparks) on a glTF model"

**Inspiration:** Three.js compute particle examples (`webgpu_compute_particles_*` — fluid, birds, flames, tornado).

**Cesium-native response:** Promote the existing weather-particles compute kernel into a generic `ParticleSystem` frontend with emitters/forces/collisions. **The Cesium-specific angle is geographic emitters** — particles spawn from a `Cartesian3` position, gravity points toward the planet center, wind comes from global meteorological data. None of the game-engine particle systems handle planet-curvature correctly. **3-5 days.**

#### Need 7: "I want users to write a shader without learning WGSL"

**Inspiration:** Three.js TSL (Three Shading Language) — node-based JS-callable shader DSL that emits both WGSL and GLSL. Babylon Node Material Editor.

**Cesium-native response:** This is a strategic question for the project. Two paths:
1. **Adopt Slang** (we have infrastructure for it via `compileSlang.js`, currently unused — FORK-29). Slang is now Khronos-backed, has a real type system with generics, and emits WGSL/GLSL/HLSL/Metal. Best long-term option but requires picking it up and committing.
2. **Adopt Naga-wasm** for the runtime path. We already have a stub at [WebGPUNagaTranspiler.ts](packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts) — a real productionization is 1-2 weeks.

The "Cesium is more fully featured" angle: neither Three.js TSL nor Babylon node materials understand RTE 64-bit precision. A Cesium-native shader DSL (whether Slang-based or Naga-fed) should automatically inject `mvpRelativeToEye` and `translateRelativeToEye()` so users never have to think about it. This is the differentiator no other engine can match.

#### Need 8: "I want to render millions of points without choking the renderer"

**Inspiration:** PlayCanvas SuperSplat, deck.gl PointCloudLayer.

**Cesium-native response:** We already ship [WebGPUPointCloudRenderer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts) with subgroup LOD. Two missing pieces:
- **COPC streaming** (Cloud-Optimized Point Cloud) — the new standard for LiDAR. ~3-5 days for the loader.
- **Eye-Dome Lighting post-process** — already implemented as [WebGPUPointCloudEyeDomeLighting.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts), needs polish + a default-on switch for point cloud tilesets.

Combined with the existing GPU sort and visibility culling, this should comfortably handle 100M+ point datasets — territory where game engines simply don't compete because LiDAR isn't their use case.

### Detected-but-unused WebGPU features (free wins)

These are device features the codebase already detects via `device.features.has(...)` but no production code uses. Listed in approximate ROI order:

| Feature | Use case | Effort |
|---|---|---|
| `chromium-experimental-multi-draw-indirect` | Collapse 500-2000 globe surface tile draws into 1 API call. Pairs with existing `WebGPUIndirectDrawManager`. | **1-2 days** + fallback |
| `dual-source-blending` | Single-pass weighted-blended OIT, replacing the MRT path in `WebGPUOIT.ts`. | **2-3 days** |
| `clip-distances` | Hardware clipping planes vs fragment discards in `WebGPUClippingPlaneCollection.ts`. | **2 days** |
| `shader-f16` | Atmosphere/IBL convolution/bloom — 2× bandwidth and ALU on capable GPUs. | **2-3 days per shader** |
| `GPUExternalTexture` | Zero-copy HTML5 video drape onto terrain — drone overlays, live camera feeds. **No other GIS viewer does this.** | **2-3 days** |
| `bgra8unorm-storage` | Compute shaders write directly to swapchain format — skip the post-FX composition blit. | **1 day** |
| `chromium-experimental-read-write-storage-texture` | Single-pass bloom downsample chain, in-place TAA history. | **1 day** |
| `chromium-experimental-unorm16-texture-formats` | Compact terrain heightmaps — halves GPU memory vs f32. | **2-3 days** |

### Things that aren't worth pursuing in the foreseeable future

- **Mesh shaders** — not in the WebGPU spec. Bevy emulates via compute meshlets; that's a 1-2 month spike if we want it as a Cesium-specific terrain LOD path. Not now.
- **Hardware ray tracing** — not in spec. Use SSR + DDGI-style probe approaches when we get there.
- **Bindless resources** — not in spec. Workaround via texture arrays + `indirect-first-instance`.
- **Variable rate shading** — not in spec.

---

## 5. GIS Viewer Landscape — User Needs Analysis

**Reframing note:** Same approach as §4 — needs first, Cesium-native response second. We don't want to reimplement Terria; we want to identify the user needs Terria solves well and serve them in ways that exploit our advantages.

### Need 1: "I have 200 datasets and need a UI to manage them"

**Inspiration:** Terria's CatalogItem + Workbench. Esri's LayerList widget. Felt's drag-and-drop ingest.

**Cesium-native response:** A `CatalogItem` abstraction owned by the Viewer with two key Cesium-specific advantages:
1. **Reactive updates** — items can re-fetch on demand (which the user's simulation needs — see §6). Terria's catalog assumes data is static.
2. **Typed metadata** — items expose strongly-typed properties (units, projection, vertical datum, time extent, attribution) so widgets can render them generically.
3. **Both backends** — works identically on WebGL and WebGPU contexts, including mixed multi-context views.

**The "more fully featured" angle:** make the catalog support **invalidation-aware items** as a first-class concept. A `Cesium3DTilesCatalogItem` with `liveUpdates: true` automatically wires up to the invalidation feed from §6. Terria has no equivalent because their data model assumes static tilesets.

**Effort:** ~2 weeks scaffold + 1 week per CatalogItem subtype.

### Need 2: "I want to recolor my data without rebuilding it"

**Inspiration:** Mapbox/MapLibre style spec + data-driven expressions. `setPaintProperty()` runtime mutation. Feature-state for hover/selection.

**Cesium-native response:** A JSON style spec **adapted to 3D**:
- Mapbox styles assume 2D fills and lines. Ours adds `extrusion-height` (already in vector tile primitives), `terrain-clamp`, `altitude-mode`, and `volumetric-volume` for 3D-volumetric features.
- Expression language with `feature-state`, but also `camera-altitude`, `sun-elevation`, `time` (CZML interop) — variables a globe renderer has that a 2D map doesn't.
- Runtime mutation via `style.setPaintProperty(layerId, prop, expression)` — implemented over the existing FR pattern so it works on both backends.

**The "more fully featured" angle:** Mapbox styles can't reference 3D Tiles metadata. Ours should — `["get", "Name"]` should work against both vector tile features AND `EXT_structural_metadata` properties on 3D Tiles. A user can write one style document that colors buildings in a vector tileset by name AND colors a 3D Tiles building model by feature ID, without learning two APIs.

**Effort:** 3-4 weeks for a MapLibre-spec subset (`fill`, `line`, `symbol`, `fill-extrusion`, `hillshade`, `background`, `raster`).

### Need 3: "I want to load a real vector tile and have it look like Mapbox"

**Inspiration:** Mapbox/MapLibre's MVT renderer with collision-based label placement, line-following symbols, true font shaping.

**Current Cesium state:** `MapboxVectorTileImageryProvider` rasterizes vector tiles to images server-side or in a worker. It is **not** a real vector renderer — labels can't dodge each other, lines can't be styled at runtime, fills can't be extruded.

**Cesium-native response:** Build a real MVT renderer on top of the existing [BufferPolygonCollection](packages/engine/Source/Scene/BufferPolygonCollection.js) / [BufferPolylineCollection](packages/engine/Source/Scene/BufferPolylineCollection.js) / [BufferPointCollection](packages/engine/Source/Scene/BufferPointCollection.js). These already have efficient WebGPU paths; we just need:
- An MVT decoder (use `@mapbox/vector-tile`)
- A label placement engine with collision boxes
- Style spec interpreter (Need 2 above)
- 3D extrusion primitive (we already have it via fill-extrusion)

**The "more fully featured" angle:** Mapbox extrudes flat polygons. Ours extrudes **on the terrain surface**, with each extruded face correctly draped on the underlying heightmap. No 2D map renderer can do this because they have no terrain model. Globe-aware label placement (great-circle baselines along lines that span multiple tiles) is another differentiator.

**Effort:** 3-4 weeks for a usable subset, 2-3 months for parity with Mapbox styles.

### Need 4: "I want photorealistic lighting that integrates with my data"

**Inspiration:** ArcGIS Daylight widget, Filament's clustered Forward+, Bevy's atmosphere + DDGI.

**Cesium-native response:** We already have the core pieces (atmosphere LUT, IBL pipeline, ProceduralClouds, weather particles). The missing UX is the **Daylight widget itself** — a round clock dial + date slider + "play day" button that drives the existing sun position calculator and shadow map. ~1 week for the widget alone.

**The "more fully featured" angle:** The Daylight widget should also drive volumetric fog density (atmospheric haze varies with time), ProceduralClouds coverage (more clouds at sunset due to cooling), and a CZML-bound weather track. None of the game-engine equivalents understand real planetary lighting.

### Need 5: "I want to draw / edit / measure things on the globe"

**Inspiration:** Esri's Sketch / Measurement / ElevationProfile / LineOfSight / ShadowCast / Slice widgets. ~8 widgets, all polished, all on day one.

**Cesium-native response:** A first-party widget suite — current state has community plugins but no maintained baseline. Start with Sketch (point/line/polygon/rectangle/circle, snapping, vertex edit, undo) + 3D distance/area + elevation profile.

**The "more fully featured" angle:** Cesium's measurement widgets should be **time-aware**. When a 3D Tiles invalidation occurs (§6), the elevation profile should automatically re-sample and show a delta from the previous reading. ArcGIS measurements are static snapshots; ours can show change over time, which is the killer feature for simulation users.

**Effort:** 2-3 weeks for the first three widgets.

### Need 6: "I want to share what I'm looking at via a URL"

**Inspiration:** Terria's share button + Esri's WebScene portable document.

**Cesium-native response:** Serialize camera + timeline + layer stack + clipping + styles + invalidation feed connection state to a JSON document. Restoration is `Viewer.fromShareDoc(json)`. ~1 week.

**The "more fully featured" angle:** Include an optional **invalidation feed snapshot** — the share doc captures not just the camera but also "the data state at this revision," so a colleague clicking the link sees exactly what you saw, even if the live data has moved on. This is crucial for simulation users who need to discuss specific states.

### Need 7: "I have a CSV / GeoJSON / Shapefile and I want to see it on the globe right now"

**Inspiration:** Felt's drag-and-drop ingest.

**Cesium-native response:** A `Viewer.acceptDrop()` API that handles CSV (auto-detect lat/lon columns), GeoJSON, KML, GPX, Shapefile (zipped), GeoTIFF (with per-channel auto-style), LAS/LAZ. Reuses existing data sources where possible, adds new ones where missing.

**The "more fully featured" angle:** **Auto-style by inspection.** A dropped CSV with a numeric "magnitude" column should default to a graduated color ramp; a categorical "type" column should default to discrete colors with auto-generated legend. Felt does this for 2D; we should do it for 3D too (e.g. a CSV with "altitude" should auto-extrude points into vertical bars). ~1 week for the ingest API + 2-3 weeks for full auto-styling.

### Top user-need pillars, prioritized by reach × leverage

| Rank | Need | Inspiration | Cesium-flavored response | Effort |
|---|---|---|---|---|
| 1 | Real vector tiles + style spec | MapLibre | MVT renderer over existing buffer primitives + 3D extrusion + globe-aware labels | 3-4 weeks |
| 2 | Cloud-native data formats | PMTiles + COG + STAC | Three loaders, all <1 week each, huge credibility win | 2-3 weeks |
| 3 | Catalog + Workbench abstraction | Terria | Reactive items, typed metadata, invalidation-aware | 2 weeks scaffold |
| 4 | Sketch / Measurement / ElevationProfile widgets | ArcGIS | Time-aware (delta over invalidations) | 2-3 weeks |
| 5 | GPU aggregation layers | deck.gl | Globe-aware (great-circle hexbins, not planar) | 2 weeks |
| 6 | Daylight / Weather widget | ArcGIS | Drives atmosphere + clouds + weather particles | 1 week |
| 7 | Share link + portable document | Terria + ArcGIS WebScene | Includes invalidation feed snapshot | 1 week |
| 8 | Story builder | Terria | Camera keyframes + layer toggles + markdown | 1 week |
| 9 | Planar (projected CRS) view mode | iTowns | proj4 + planar transform alternative to ENU | 2-3 weeks |
| 10 | COPC / EPT / LAS streaming | iTowns + PlayCanvas | EDL post-FX + GPU sort already exist | 1-2 weeks for COPC alone |

### Data integration gap matrix

| Format | Cesium today | Priority for Cesium-WebGPU |
|---|---|---|
| **MVT (true vector render)** | Rasterized only | **CRITICAL** |
| **PMTiles** | No | High |
| **COG (Cloud-Optimized GeoTIFF)** | No | High |
| **STAC** | No | High |
| **WFS** | No | High |
| **OGC API Features** | No | High |
| **COPC** | No | High |
| OGC API Tiles/Maps | No | Medium |
| OGC SensorThings | No | Medium |
| EPT / Potree | No | Medium |
| LAS/LAZ direct | No | Medium |
| IFC / BIM | No | Medium |
| ArcGIS FeatureServer | Partial | Medium |

---

## 6. Live 3D Tiles Invalidation — Final Design

This is the highest-leverage feature in the entire report. Cesium already implements the zero-flicker swap mechanism; the new work is the push channel + pattern matcher + multi-tileset routing.

> **Decision pointer:** §8.1 contains the locked A1-A7 decisions that supersede speculative parts of this section. In particular: A2 (producer adds `id` + `timestamp` to messages — supersedes the `hashStrings(patterns)` token in the `ResourcePathAdapter` example below), A3 (multi-content tile support is in scope for Phase 4 — supersedes "MVP falls back to hard `unloadContent()`"), A5 (all three transports ship with HTTP as default), A6 (pass-through auth via headers/queryParameters/withCredentials/WS subprotocols), A7 (`Scene._snapshotVersion` hook in Phase 1 design). Read this section for the architecture; consult §8.1 for the final field/parameter values when implementing.

### Producer message format (real, from the user)

```json
{
  "extents": [
    {
      "lat": [31.211727, 31.225738],
      "layer": "terrain/",
      "lon": [-97.853787, -97.833195]
    }
  ],
  "resources": [
    "terrain/tileset.json",
    "terrain/5/0/1/3/2/1/1/3/0/0/1/2/3/1.*",
    "terrain/5/0/1/3/2/1/1/3/0/0/1/2/3.*",
    "terrain/5/0/1/3/2/1/1/3/0/0/1/2.*",
    ...
  ],
  "version": "2.0"
}
```

### Format observations

1. **`version: "2.0"` is the protocol version, not a revision number.** The producer publishes complete state per message and tolerates duplicates.
2. **`extents[]` is a fast spatial pre-filter.** Each extent has a geographic bounding box and an optional `layer` field (the producer's tileset name). Multiple extents per message are allowed.
3. **`resources[]` is a list of glob-style path patterns** rooted at the tileset name. The wildcard syntax has **two distinct meanings** that the matcher must distinguish:
   - **`.*`** suffix = **exact LOD match**. The `.*` is a file-extension wildcard (`.b3dm`, `.glb`, `.pnts`, …); the rest of the path is matched exactly. Does NOT cascade to descendants. Example: `terrain/5/0/1/3.*` invalidates only the tile at `5/0/1/3`, not its children.
   - **`X*`** suffix (where `X` is a digit at the end of a path component, no preceding dot) = **subtree wildcard**. Invalidates this node AND every descendant beneath it. Example: `terrain/5/0/1/3/2*` invalidates `5/0/1/3/2` and every tile under it.
   - No wildcard = literal match (used for `terrain/tileset.json` sentinel that flags a manifest re-fetch).
   - **Why the distinction matters:** the producer's encoding is precise. It enumerates every ancestor of a changed tile as `.*` (exact form, "this LOD changed but descendants may still be valid") AND specific subtrees as `X*` (bulk form, "this branch is entirely invalid"). Collapsing both into a single prefix-match would over-invalidate aggressively and waste GPU memory swapping tiles that are still good.
4. **The cascade is pre-enumerated by the producer.** For an invalidation rooted at `terrain/5/0/1/3/2/1/1/3/0/0/1/2/3/1`, the message contains every ancestor (`terrain/5.*`, `terrain/5/0.*`, ...) AND the descendant subtree (`terrain/5/0/1/3/2/1/1/3/0/0/1/2/3/1/0.*`, `.../1.*`, etc.) The client doesn't need to walk the tree to compute cascade.
5. **Multi-layer is first-class.** A single producer publishes `terrain/`, `terrain-srf/`, `objects/`, `objects-collision/`, `vegetation/`, `vegetation-collision/`, `water/`, `terrain_ue/`. The client must route each layer's patterns to the correct registered tileset.
6. **`*-collision` layers are not for rendering.** They're served to an Unreal client running off the same producer. The Cesium client should accept registrations for any layer name and silently ignore messages for layers that have no registered tileset.
7. **Idempotency is required.** The user's file shows the same invalidation messages repeating — the producer sends periodic state. Re-applying an already-applied invalidation must be a no-op.
8. **HTTP/2 transport is the deployment target.** WebSocket over HTTP/2 (multiplexed), Server-Sent Events over HTTP/2, or fetch streaming (`ReadableStream` from a long-lived `fetch()`) all qualify. The transport should be an interface; the parser/router is transport-agnostic.

### Architecture (3 modules)

```
┌─────────────────────────────────────────────────────────┐
│  Cesium3DTilesInvalidationTransport (interface)         │
│  ┌────────────┐ ┌──────────┐ ┌─────────────────────┐    │
│  │ WebSocket  │ │   SSE    │ │ HTTP/2 fetch stream │    │
│  └────────────┘ └──────────┘ └─────────────────────┘    │
└────────────────────────┬────────────────────────────────┘
                         │ raw JSON messages (parsed)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Cesium3DTilesInvalidationFeed                          │
│  - parses message                                       │
│  - groups resources by layer                            │
│  - extent pre-filter (skip irrelevant tilesets fast)    │
│  - compiles patterns (strip trailing wildcards)         │
│  - walks loaded tiles, matches via startsWith()         │
│  - applies bounded in-flight + visible-first ordering   │
└────────────────────────┬────────────────────────────────┘
                         │ tile.invalidate(token)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Cesium3DTile.invalidate() — REUSES _expiredContent     │
│  (this is the existing zero-flicker swap, unchanged)    │
└─────────────────────────────────────────────────────────┘
```

Owner: the **Scene** (or the Viewer), not an individual `Cesium3DTileset`. One feed serves N tilesets.

### Existing Cesium machinery we build on

| What | Where | What it does |
|---|---|---|
| `Cesium3DTileContentState.EXPIRED` (state index 4) | [Cesium3DTileContentState.js:4-11](packages/engine/Source/Scene/Cesium3DTileContentState.js#L4) | First-class state, not a flag. |
| `Cesium3DTile._expiredContent` snapshot | [Cesium3DTile.js:280](packages/engine/Source/Scene/Cesium3DTile.js#L280), [1067-1080](packages/engine/Source/Scene/Cesium3DTile.js#L1067) | Holds the old content during the swap window. |
| **`updateContent()` zero-flicker swap loop** | [Cesium3DTile.js:2155-2185](packages/engine/Source/Scene/Cesium3DTile.js#L2155) | Renders `_expiredContent` until new content reaches READY, then atomic destroy + swap. |
| `requestSingleContent()` cache-bust | [Cesium3DTile.js:1287-1316](packages/engine/Source/Scene/Cesium3DTile.js#L1287) | Already supports `?expired=...` query param injection for HTTP cache busting. |
| `requestContent()` decrements counts on expire | [Cesium3DTileset.js:2591-2627](packages/engine/Source/Scene/Cesium3DTileset.js#L2591) | Existing path treats `contentExpired === true` as "needs re-fetch" — no traversal changes needed. |
| Destructor handles `_expiredContent` | [Cesium3DTile.js:2459-2464](packages/engine/Source/Scene/Cesium3DTile.js#L2459) | Already paranoid about double-destroy. |

### Two known limitations for MVP

1. **Multi-content tiles are explicitly skipped** — [Cesium3DTile.js:2158](packages/engine/Source/Scene/Cesium3DTile.js#L2158): `if (!tile.hasMultipleContents && defined(expiredContent))`. MVP falls back to hard `unloadContent()` for multi-content tiles (which flickers). Phase 2 extends `Multiple3DTileContent` with per-inner swap.
2. **`unloadContent()` doesn't destroy `_expiredContent`** — latent bug for live invalidation, harmless for time-based expiration. Fix in MVP.

### Pattern matcher (sketch)

The matcher MUST distinguish the two wildcard forms (see observation #3 above):

```js
// packages/engine/Source/Scene/Cesium3DTilesInvalidationFeed.js

/**
 * Compile a producer pattern into a fast matcher.
 *   "terrain/5/0/1/3.*"   → { kind: "exact",   value: "terrain/5/0/1/3" }
 *   "terrain/5/0/1/3/2*"  → { kind: "subtree", value: "terrain/5/0/1/3/2" }
 *   "terrain/tileset.json"→ { kind: "literal", value: "terrain/tileset.json" }
 */
function compileResourcePathPattern(pattern) {
  if (pattern.endsWith(".*")) {
    return { kind: "exact", value: pattern.slice(0, -2) };
  }
  if (pattern.endsWith("*")) {
    return { kind: "subtree", value: pattern.slice(0, -1) };
  }
  return { kind: "literal", value: pattern };
}

/**
 * Test a single tile URI against a compiled matcher.
 *
 *   exact   — `pattern.value` is a path with no extension. The URI must
 *             begin with it AND the only continuation allowed is `.<ext>`
 *             with no additional path segments. This rejects descendants.
 *
 *   subtree — `pattern.value` is a path stripped of its trailing `*`. The
 *             URI must begin with it; the next character must be `/`
 *             (descendant) or `.` (the prefix tile itself). Both forms
 *             are matches.
 *
 *   literal — Exact equality, used for sentinels like `tileset.json`.
 */
function matchTile(uri, matcher) {
  const v = matcher.value;
  if (!uri.startsWith(v)) return matcher.kind === "literal" ? uri === v : false;
  const rest = uri.substring(v.length);
  switch (matcher.kind) {
    case "exact":
      // Allow only `.<ext>` continuation, no further `/` segments.
      return rest.length > 0
        && rest.charCodeAt(0) === 0x2E /* '.' */
        && rest.indexOf("/") === -1;
    case "subtree": {
      if (rest.length === 0) return true;
      const c = rest.charCodeAt(0);
      return c === 0x2F /* '/' */ || c === 0x2E /* '.' */;
    }
    case "literal":
      return rest.length === 0;
  }
}

function matchAny(uri, matchers) {
  for (const m of matchers) {
    if (matchTile(uri, m)) return true;
  }
  return false;
}
```

**Why the distinction matters:** the producer's encoding is precise. A message containing both `terrain/5/0/1.*` (exact) and `terrain/5/0/1/2*` (subtree of one child) means "the parent at LOD 5/0/1 is invalid AND specifically the `2` subtree below it is invalid, but the `0`, `1`, `3` subtrees may still be valid." A naive prefix matcher collapses both into `terrain/5/0/1` and over-invalidates the other three subtrees, wasting GPU memory swapping good tiles.

### Pluggable format adapters — supporting both resource-path AND OGC implicit tiling

The matcher engine is intentionally **address-scheme-agnostic**. It tests tile URIs against compiled matchers, but it doesn't know how those matchers were produced. This lets us support multiple wire formats through the same feed by introducing a small **format adapter** layer between transport and core.

```
┌──────────────────────────────────────────────────────────────────┐
│  Transport (WS / SSE / HTTP/2 fetch) — emits raw JSON messages   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Format adapters — pluggable, registered by `version`            │
│  ┌────────────────────────┐  ┌─────────────────────────────────┐ │
│  │ ResourcePathAdapter    │  │ ImplicitTilingAdapter           │ │
│  │ (producer v2.0)        │  │ (OGC implicit, hypothetical)    │ │
│  │ patterns → matchers    │  │ coords + level → matchers       │ │
│  └────────────┬───────────┘  └────────────────┬────────────────┘ │
└───────────────┼──────────────────────────────┬┘
                │  unified InvalidationDirective│
                ▼                               ▼
        ┌─────────────────────────────────────────┐
        │  Cesium3DTilesInvalidationFeed core     │
        │  - registered tilesets by layer         │
        │  - bounded in-flight + visible-first    │
        │  - matcher engine                       │
        │  - tile.invalidate(token)               │
        └─────────────────────────────────────────┘
```

#### Unified internal form

```js
/**
 * @typedef InvalidationDirective
 * @property {string} layer            Producer's layer identifier
 * @property {Matcher[]} matchers      Compiled matchers (any compile() output)
 * @property {Rectangle[]} extents     Optional spatial pre-filter rectangles
 * @property {string} token            Cache-bust token (hash or msgId)
 * @property {boolean} reloadManifest  True iff "<layer>/tileset.json" sentinel was present
 */
```

A directive is "what tiles to invalidate, where they live geographically, how to bust the HTTP cache." Format adapters produce one or more directives per message; everything downstream is format-agnostic.

#### Adapter contract

```js
/**
 * @interface InvalidationFormatAdapter
 * @property {string} versionId       Identifier matched against message.version
 * @method canHandle(message)          true iff this adapter understands the message shape
 * @method translate(message)          Returns InvalidationDirective[]
 */
```

#### `ResourcePathAdapter` (producer v2.0 — your real format)

```js
class ResourcePathAdapter {
  versionId = "2.0";
  canHandle(msg) {
    return msg.version === "2.0" && Array.isArray(msg.resources);
  }
  translate(msg) {
    // Group resources by leading path segment (= layer name)
    const byLayer = new Map();
    for (const r of msg.resources) {
      const slash = r.indexOf("/");
      if (slash < 0) continue;
      const layer = r.substring(0, slash);
      let bucket = byLayer.get(layer);
      if (!bucket) byLayer.set(layer, (bucket = []));
      bucket.push(r);
    }
    const directives = [];
    for (const [layer, patterns] of byLayer) {
      const manifestKey = `${layer}/tileset.json`;
      const reloadManifest = patterns.includes(manifestKey);
      const matchers = patterns
        .filter((p) => p !== manifestKey)
        .map(compileResourcePathPattern);
      const extents = (msg.extents ?? [])
        .filter((e) => !e.layer || e.layer === `${layer}/`)
        .map((e) => Rectangle.fromDegrees(
          e.lon[0], e.lat[0], e.lon[1], e.lat[1],
        ));
      directives.push({
        layer,
        matchers,
        extents,
        token: hashStrings(patterns),
        reloadManifest,
      });
    }
    return directives;
  }
}
```

#### `ImplicitTilingAdapter` (hypothetical OGC implicit format)

OGC implicit tiling addresses tiles by `(level, x, y, z)` coordinates from a templated URL. The adapter compiles each change into the same `{kind, value}` matcher form by materializing the expected URI from the tileset's URL template (captured at registration time).

```js
class ImplicitTilingAdapter {
  versionId = "implicit-1.0";
  canHandle(msg) {
    return msg.version === "implicit-1.0" && Array.isArray(msg.changes);
  }
  translate(msg) {
    // Each change has shape:
    //   { layer: "terrain", level: 8, x: 123, y: 456, z: 0,
    //     cascade: "descendants" | "self", boundingBox?: [...] }
    const byLayer = new Map();
    for (const c of msg.changes) {
      const layer = c.layer ?? "default";
      let bucket = byLayer.get(layer);
      if (!bucket) byLayer.set(layer, (bucket = []));
      bucket.push(c);
    }
    const directives = [];
    for (const [layer, changes] of byLayer) {
      const tilesetCtx = this._registry.get(layer); // captured at register()
      const matchers = changes.map((c) =>
        compileImplicitTilingMatcher(c, tilesetCtx.uriTemplate),
      );
      const extents = changes
        .filter((c) => c.boundingBox)
        .map((c) => Rectangle.fromDegrees(...c.boundingBox));
      directives.push({
        layer,
        matchers,
        extents,
        token: msg.revision != null ? `r${msg.revision}` : hashChanges(changes),
        reloadManifest: !!msg.reloadManifest,
      });
    }
    return directives;
  }
}

function compileImplicitTilingMatcher(change, uriTemplate) {
  // Materialize the expected tile URI from the template, e.g.
  //   uriTemplate = "buildings/{level}/{x}/{y}.b3dm"
  //   change      = { level: 8, x: 123, y: 456, cascade: "self" }
  //   →             "buildings/8/123/456" (extension stripped for exact-match)
  const path = uriTemplate
    .replace("{level}", change.level)
    .replace("{x}", change.x)
    .replace("{y}", change.y)
    .replace("{z}", change.z ?? 0);
  // Strip the file extension so the exact-match logic mirrors the v2.0
  // adapter's stripping of ".*". For subtree matches we additionally
  // strip the trailing path segment so any descendant under the parent
  // matches. (This depends on how the implicit URL template positions
  // the file extension — tweak per template.)
  const noExt = path.replace(/\.[^./]+$/, "");
  if (change.cascade === "descendants") {
    return { kind: "subtree", value: noExt };
  }
  return { kind: "exact", value: noExt };
}
```

The matcher emitted by the implicit adapter is **structurally identical** to the resource-path adapter's output: `{kind: "exact" | "subtree" | "literal", value: string}`. The matcher engine has no idea which format the directive came from. That's the win.

#### Registration with adapter context

```js
const feed = new Cesium3DTilesInvalidationFeed({
  transport: new WebSocketInvalidationTransport({ url: "wss://..." }),
  adapters: [
    new ResourcePathAdapter(),
    new ImplicitTilingAdapter(),
    // Custom adapters can be added by users for proprietary feeds
  ],
});

// Producer-format users register tilesets with a layer name only
feed.register(terrainTileset, { layer: "terrain" });

// Implicit-tiling users register with both layer name AND URL template
feed.register(buildingsTileset, {
  layer: "buildings",
  uriTemplate: "buildings/{level}/{x}/{y}.b3dm",
});
```

The register options are a free-form bag — each adapter looks at the keys it cares about. `ResourcePathAdapter` only needs `layer`; `ImplicitTilingAdapter` needs `layer` AND `uriTemplate`. The feed core just stores the bag and hands it to the matching adapter.

#### Dispatch

```js
class Cesium3DTilesInvalidationFeed {
  ingest(rawMessage) {
    const adapter = this._adapters.find((a) => a.canHandle(rawMessage));
    if (!adapter) {
      this._log("warn", `No adapter handles version: ${rawMessage.version}`);
      return;
    }
    const directives = adapter.translate(rawMessage);
    for (const d of directives) {
      const tileset = this._tilesetsByLayer.get(d.layer);
      if (!tileset) continue; // unknown layer, silently ignore
      this._applyDirective(tileset, d);
    }
  }
  // _applyDirective is identical regardless of which adapter produced d.
  // Spatial pre-filter → walk loaded tiles → matchAny() → queue invalidation.
}
```

### Why this matters

1. **Two protocols, one engine.** Your producer keeps using `version: "2.0"`. A second producer using OGC implicit tiling could publish `version: "implicit-1.0"` to the same feed. The same `Cesium3DTilesInvalidationFeed` handles both, routing per-layer to the appropriate tileset.
2. **A future v2.1 format change is additive.** When your producer adds (say) a `messageId` field, write a `ResourcePathAdapter21` that subclasses v2.0, registers `versionId: "2.1"`, and overrides `translate()` to use the messageId as the token. Old messages still go through v2.0 adapter; new messages go through v2.1. Both work simultaneously during a producer rollout.
3. **Mixing formats in one viewer.** A user could run a public OGC-implicit dataset alongside your simulation tileset. Both feeds wired up. The viewer doesn't care.
4. **Custom adapters for proprietary feeds.** Users with their own tile-change APIs write a 50-line adapter, register it, and get all the rest for free (bounded in-flight, visible-first ordering, `_expiredContent` swap, cache-busting).
5. **Tests are easier.** The matcher engine has a small surface area and gets unit-tested directly. Each adapter is unit-tested in isolation against fixtures. No transport, no tileset, no GPU needed.

### Public API

```js
import {
  Cesium3DTilesInvalidationFeed,
  WebSocketInvalidationTransport,
} from "@cesium/engine";

const feed = new Cesium3DTilesInvalidationFeed({
  transport: new WebSocketInvalidationTransport({
    url: "wss://sim.example.com/changes",
  }),
  bounded: { maxInFlight: 64, headroomFraction: 0.25 },
});
viewer.scene.invalidationFeed = feed;

const terrainTileset = await Cesium.Cesium3DTileset.fromUrl(".../terrain/tileset.json");
feed.register(terrainTileset, { layer: "terrain" });

const objectsTileset = await Cesium.Cesium3DTileset.fromUrl(".../objects/tileset.json");
feed.register(objectsTileset, { layer: "objects" });

feed.start();

// Optional: programmatic invalidation (no transport — for testing or non-feed sources)
feed.applyMessage({
  version: "2.0",
  extents: [{ lat: [31.21, 31.22], lon: [-97.85, -97.84], layer: "objects/" }],
  resources: ["objects/5/0/1/3.*"],
});
```

### Memory bounding (the main risk)

During the swap window every invalidated tile holds *both* `_content` (new, loading) and `_expiredContent` (old, being rendered). For a large change set this can 2× the working set and trip the `cacheBytes` limit.

**Mitigations:**

1. **Bounded in-flight count** (default 64, configurable). FIFO queue, dequeue as swaps complete.
2. **Prioritize visible tiles** by `tile._priority` (already computed by traversal).
3. **Skip-swap for off-screen tiles** — for tiles in cache but not selected this frame, call `unloadContent()` instead of swap. No `_expiredContent` = no doubling. Most invalidations in your scenario hit this path.
4. **Inflate `cacheBytes` while swap in-flight** by `headroomFraction` (default 25%), deflate when done.
5. **`RequestScheduler` already throttles** per-server requests so the network can't drown.

### Cache busting on re-fetch

Modify [Cesium3DTile.js:1287-1316](packages/engine/Source/Scene/Cesium3DTile.js#L1287) `requestSingleContent()`:

```js
if (expired || defined(tile._invalidationToken)) {
  const params = {};
  if (defined(tile._invalidationToken)) {
    params.inv = tile._invalidationToken;
  } else {
    params.expired = tile.expireDate.toString();
  }
  resource.setQueryParameters(params);
}
```

Token = hash of the resources array from the message that caused the invalidation. Deterministic, idempotent (same message → same cache key), no producer changes required.

### Edge cases

- **Bounding volume changes**: not in your message format (yet). When supported, `_updateBoundingVolume()` updates the spatial index BEFORE re-fetch is scheduled.
- **Cascade**: pre-enumerated by producer — no client-side walk.
- **Partial failures**: keep rendering `_expiredContent` for N retries; raise `feed.invalidationFailed` event for "stale data" UI indicator.
- **Deletions**: 404 on re-fetch → `unloadContent()`. Don't mutate the tree from the message handler — defer to `postPassesUpdate`.
- **Producer down**: WebSocket reconnect with exponential backoff (1s/2s/4s/.../60s max). Surface `feed.isLive` flag.
- **Layer name resolution**: extract first path segment from each resource. If no tileset is registered for that layer, silently ignore. (`*-collision` layers fall through to no-op.)
- **`tileset.json` re-fetch**: when present in resources, schedule `tileset.invalidateTilesetJson()`. Tile-level invalidation in the same message still runs against the OLD tree because the manifest re-fetch is async; we'll re-process on completion.

### Roadmap

| Phase | Scope | Effort |
|---|---|---|
| **MVP — Phase 1** | `tile.invalidate(token)` + `_expiredContent` reuse + bounded in-flight + cascade walker. New `Cesium3DTilesInvalidationFeed` module. Programmatic `feed.applyMessage()` API. Unit tests with sample messages from the user's file. | **2-3 weeks** |
| **Phase 2** | `Cesium3DTilesInvalidationTransport` interface + 3 implementations (WebSocket, SSE, HTTP/2 fetch streaming). Integration test with mock server replaying the user's actual message stream. | **1-2 weeks** |
| **Phase 3** | Bounding volume change handling, retry/failure events, deletion via 404, stats/diagnostics, debug overlay showing in-flight invalidations. | **1-2 weeks** |
| **Phase 4 (optional)** | Multi-content tile support, metadata-only fast path, cross-fade shader for smoother visual swap (WGSL+GLSL parity per CLAUDE.md). | **3-4 weeks** |

**Total to ship a production feature: 4-6 weeks for Phases 1-3.**

---

## 7. Synthesized Roadmap

Combining all four research streams into a single ranked sprint plan. Each item is sized to fit a focused work session.

### Sprint 1 (1-2 weeks) — finish what's already started

1. **Activate Hi-Z + OcclusionTest dormant compute shaders** (FORK-41) — 5-20× speedup on dense 3D Tiles
2. **Activate GPUSortKeys** — replace JS comparator beyond 50K commands
3. **Adopt `dual-source-blending`** — single-pass WBOIT
4. **Adopt `clip-distances`** — hardware clipping
5. **Adopt `shader-f16`** in atmosphere + IBL — 2× bandwidth
6. **Add error boundaries** to all 6 lazy renderer loaders (AUDIT-1)
7. **Validate subgroup feature** before generating subgroup WGSL (AUDIT-2)
8. **Upstream sync** — 40 commits, 9 conflict-risk files, ~3 hours focused work

### Sprint 2 (2-4 weeks) — visual quality wins

9. **CSM + per-layout shadow cast pipeline cache** (closes SHADOW-LAYOUT)
10. **TAA** (and the velocity buffer it requires)
11. **Volumetric fog + god rays** (reuses existing AtmosphereLUT data)
12. **Color grading + 3D LUT post stage**
13. **Motion blur** (free once velocity buffer exists)
14. **Clustered/tiled forward lighting** (log-Z grid for planetary scale)

### Sprint 3 (4-6 weeks) — 3D Tiles invalidation MVP through Phase 3

15. **Phase 1 MVP**: `tile.invalidate(token)` + `Cesium3DTilesInvalidationFeed` module + programmatic API
16. **Phase 2**: WebSocket / SSE / HTTP/2 fetch streaming transports
17. **Phase 3**: Edge cases + stats + debug overlay
18. **Document the protocol** as a markdown spec alongside existing 3D Tiles extensions

### Sprint 4 (4-6 weeks) — viewer platform features

19. **MVT vector tile renderer + JSON style spec** (the single biggest GIS gap; built on existing buffer primitives)
20. **PMTiles + COG + STAC providers**
21. **Catalog + Workbench abstraction** (Terria-inspired, with reactive items + invalidation-aware)
22. **Sketch / Measurement / ElevationProfile widgets** (time-aware, delta-over-invalidations)

### Sprint 5 (2-3 weeks) — quality + tech debt

23. **Expand Jasmine spec coverage** to ≥1 test per FR + utility (target: 50% file coverage)
24. **Decompose 6 files >1000 LOC** into focused modules (CLAUDE.md rule)
25. **Replace 35+ console.* calls with `context.log()`** (per-context prefixing)
26. **Visual regression CI** baseline corpus (`Tools/visual-regression/` already scaffolded)

### Long horizon (parking)

- ES6 modernization continues opportunistically under "10-line touch rule"
- Naga-wasm productionization (binding remap, vertex location remap, specialization constants) — only if WebGL stub becomes a real bottleneck
- Snapshot rendering (Babylon-inspired FAST) — high payoff but only after Sprint 1-2
- Mesh shader emulation via compute meshlets — research project, 1-2 month spike
- Planar projected-CRS view mode — large architectural change, separate decision

---

## 8. Decisions Locked This Session (A1-A7, B1-B23, C1-C14)

44 questions were posed across three feature areas during this session. Every one is now answered. This section is the **definitive decision log** — when implementation begins, this is the source of truth, not the design drafts.

### 8.1 — A series: Live 3D Tiles Invalidation (cross-cutting, 7 questions)

| # | Question | Decision | Rationale |
|---|---|---|---|
| **A1** | Naga vs Slang for runtime shader compilation | **Naga for runtime, Slang for prebuild/compile-time.** Clean split by purpose. | Naga is what Mozilla ships in Firefox and is production-tested for runtime GLSL→WGSL. Slang is Khronos-backed with rich language features (generics, modules) that benefit author-time tooling. Use each where it shines. |
| **A2** | Invalidation message ID strategy | **Producer adds `id` (monotonic counter scoped to feed connection) + `timestamp` to JSON.** ID becomes the cache-bust token AND the dedup key. Timestamp is informational only (don't use for ordering — message arrival order is the truth). | Counter compresses better than UUID, lets the client detect dropped messages (`expected N+1, got N+3` → fetch catch-up). Cleaner than client-side hashing. |
| **A3** | Multi-content tile invalidation priority | **In scope** for Phase 4 alongside per-layer routing. | User confirmed multi-content tiles are part of the producer's roadmap. |
| **A4** | Bounding volume monotonicity | **Trust the producer.** The 3D Tiles 1.1 spec REQUIRES `tile.boundingVolume` to enclose all descendants' bounding volumes (verified — see §9.1). No defensive verification needed. The one exception is when a re-fetched tile's *new* bounds grow past its previously cached bounds — handled by the existing spatial index update path. | Spec rule, not optimization. Verifying it client-side would be wasted work. |
| **A5** | Latency target / transport | **All three transports (WebSocket, SSE, HTTP) ship.** HTTP is the default. Customer-pluggable. The future topic of "better WS / SSE / HTTP3 / QUIC support" is a separate backlog item — see §10. | Cesium serves thousands of customers with different deployment constraints. Stay agnostic; let the customer pick. |
| **A6** | Authentication model | **Pass-through, never bake in.** The `InvalidationTransport` interface accepts `headers`, `queryParameters`, `withCredentials`, and WebSocket `protocols`. Customers run nginx / reverse proxies for OAuth / JWT refresh / mTLS / session cookies. Cesium implements **bearer tokens at most**. | Consistent with how every existing Cesium auth integration works (Ion, iTwin, Mapbox, Google, ArcGIS). All of them just carry a token; auth state machines live outside Cesium. See §9.4. |
| **A7** | Snapshot rendering ↔ live invalidation interaction | **Ship snapshot mode** built on `WebGPURenderBundleManager`. Schedule: **after Sprints 1 & 2**. Account for animations, tile invalidations, dynamic resources (lazy unlock when any of these occur). Invalidation feed bumps `Scene._snapshotVersion`; snapshot mode reads it to know when to discard cached command streams. Design the hook into the invalidation feed from day 1. | Genuinely differentiating for the locked-orbit inspection workflow. ~4-6 days on top of existing render bundle infrastructure. See §9.2. |

### 8.2 — B series: Celestial Atmosphere Design (23 questions)

| # | Question | Decision |
|---|---|---|
| **B1** | Earthshine on dark side of moon? Moon visibility from arbitrary positions? | **Yes — earthshine on, all phases, both sides of moon.** Moon mirrors sun: marker class with engine-computed direction. Geometry already correct (verified — `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame()` gives real ICRF position, `Ellipsoid.MOON.radii` gives real lunar radii, `IauOrientationAxes` gives real lunar reference frame). The only follow-up is a higher-resolution moon texture if the "fly to moon" use case is important — separate small task, deferred. |
| **B2 / B14** | `MoonLight` as `DirectionalLight` subclass or own marker class? | **Marker class mirroring `SunLight`** — NOT a `DirectionalLight` subclass. Engine writes its direction internally each frame from ephemeris, same pattern as the existing `SunLight`. Apps wanting manual moon direction construct a `DirectionalLight` instead and bypass the moon ephemeris. Symmetric design. |
| **B3** | Wavelength dependence of atmospheric coefficients | **`lightTint: vec3` per light, constant at construction time, not a per-frame uniform.** |
| **B4** | Star modulation curve location | **Smoothstep curve. Lives in `scene.globe.atmosphericConditions` nested config object** — see §9.5 for the full nested structure. Independently controllable from Scene-level shortcuts. |
| **B5** | `scene.skyAtmosphere.show = false` + dual-light enabled | **No-op + document the dependency.** |
| **B6** | Per-renderer cost of toggle reads | **Profile sanity check after Phase 1**, not a blocking decision. |
| **B7** | Default froxel resolution | **Auto-select via init benchmark** (`navigator.gpu.wgslLanguageFeatures` probe + one-time empty-dispatch timing), fall back to "low" if probe inconclusive. **EXPANDED into a new feature: VisualPerformanceTargetService** — see §10 for the new backlog item. |
| **B8** | Default for `enableVaryingAtmosphereDensity` | **Off by default.** 3D noise sample adds non-trivial constant cost. |
| **B9** | Scattering occlusion without volumetric fog | **Silently no-op + document.** No log warning (less noise). |
| **B10** | Fog interaction with 3D Tiles opacity | **Post-composite for v1**, per-fragment in follow-up if visible artifacts. |
| **B11** | Temporal reprojection — Phase 5b or defer? | **Defer to Phase 5f polish step**, after 5a-5d land. Blue-noise jitter alone may suffice. |
| **B12** | Default for `enableSunLight` | **`enableSunLight = true` by default.** The original concern about "breaking apps that manually configure direction" is ill-founded — the existing SunLight API doesn't expose `direction`, so there are no apps to break. |
| **B13** | Earthshine | **On.** (Same as B1.) |
| **B15** | Phase 6 (volumetric clouds) timing | **Promoted from "deferred" to "ships immediately after 5a-5d."** Cutover at altitude 50-100 km (configurable): below = volumetric raymarched, above = procedural 2D. **Volumetric path reads from the existing `WebGPUProceduralCloudRenderer` noise field** rather than generating its own — ensures cloud shapes match across the crossfade zone. **Effort drops from 3-4 sessions to 2-3 sessions** because noise generation is already done. Default off, quality dial (low/medium/high/auto). 5e (cloud shadows) ships at the same time and is no longer blocked. |
| **B16** | Toggle naming style — flat vs nested | **Stay flat at the leaf level** (`enableMoonLight`, not `moon.contributesToLighting`), but **organize the leaves under nested config groups** (`scene.globe.atmosphericConditions.lighting.enableMoonLight`). See §9.5. |
| **B17** | Default froxel resolution decision form | **Follow B7 plan (auto-select).** |
| **B18** | Default for `enableVolumetricFog` | **Off by default.** No perf regression, users opt in. |
| **B19** | Default for `enableVaryingAtmosphereDensity` decision form | **Off by default.** (Same as B8.) |
| **B20** | Default for `enableScatteringOcclusion` | **Independently toggleable, off by default.** When `volumetricFog.enabled === false`, the toggle is set but has no visible effect (silent gating, matches B9). |
| **B21** | Varying atmosphere density without froxel grid | **Skip for now.** Per-pixel sky atmosphere ray march path NOT implemented. May revisit. |
| **B22** | Fog composite placement | **After opaque + OIT-resolved, before UI overlay.** Transparent 3D Tiles get post-composite fog (approximate) in v1; per-fragment in follow-up if needed. |
| **B23** | Phase 5 blocking vs non-blocking for Phases 1-4 | **Land 1-4 first, then 5 as a separate feature branch.** Phases 1-4 deliver standalone value (celestial ephemeris + multi-light sky) without touching participating media. |

### 8.3 — C series: Water Rendering Design (14 questions)

| # | Question | Decision |
|---|---|---|
| **C1** | `WaterClassificationProvider` singleton vs pluggable | **Pluggable per globe.** Multi-globe setups get independent providers. |
| **C2** | River width inference in WASM? | **WASM with JS fallback** per CLAUDE.md WASM strategy. |
| **C3** | Default for `enableUnderwaterFog` when no froxel grid | **Cheap exponential depth-fog.** |
| **C4** | Water classification interaction with 3D Tiles classification | **Compose with existing classification** — they answer different questions through different APIs. `Cesium3DTileset.classificationType` is "where do my polygons project onto?"; water classification is "what kind of water body is this feature?" Both can apply to the same tileset. **Use `EXT_structural_metadata` for the water semantic — already supported by 3D Tiles 1.1, no spec changes needed.** See §9.3. |
| **C5** | Tide source | **User-provided callback, default zero.** Leave room to expand defaults later. |
| **C6** | `WaterRegion` per-Gerstner override | **Type-only at v1**, individual override at Phase 8. |
| **C7** | Imagery sampling reuse cost | **Investigate during Phase 2** (likely viable via varying). |
| **C8** | Water type vocabulary (OSM vs OGC) | **OSM tag vocabulary preserved verbatim** (``natural=water``, ``water=lake\|pond\|reservoir\|river\|canal``, ``waterway=river\|stream\|canal\|drain``, ``place=sea``, ``natural=coastline``, ``natural=wetland``, ``natural=glacier``). The internal `WaterType` enum is a renderer normalization helper, not the canonical data format. **Matches the existing `createOsmBuildingsAsync` pattern exactly** — see §9.6. Provide adapter pattern for non-OSM sources (HY_Features, INSPIRE, CityGML, custom). |
| **C9** | OSM/HydroRIVERS data licensing | **Ship NO OSM data in the default build.** Sandcastle demo loads OSM live with proper attribution (`© OpenStreetMap contributors` + link). Document user licensing responsibility in API reference. **Zero ODbL exposure for Cesium itself.** See §9.4. |
| **C10** | Default for `waterEffectsEnabled` | **Off by default**, may revisit. |
| **C11** | Quantized-mesh extension | **Ship Option A (backward-compatible additive) now**, using extension ID `0x05` ("water classification extension"). Additional optional buffers append after the existing 1-bit water mask: `waterType` byte + `flowVector` 2× signed short per texel. Old clients ignore the new buffers via existing extension-ID dispatch. **Document Option B (version bump) as deferred long-term work** — see §10 for the Phase 9+ backlog item. |
| **C12** | `containsWaterSurface` flag for tilesets with baked water | **No spec change.** Use custom `_CESIUM_CONTAINS_WATER_SURFACE` semantic via `EXT_structural_metadata`. Per-tileset runtime override (`tileset.containsWaterSurface = true`) for tilesets that don't set it. Heuristic detection NOT in v1 — keep it explicit. |
| **C13** | Water vs celestial Phase 1 ordering | **Run in parallel.** Water Phase 6 (underwater god rays) gates on celestial Phase 5a (froxel grid infrastructure). Water Phases 1-5 can run independently. |
| **C14** | Water region API shape | **Namespaced: `scene.water.regions.add(...)`.** Keeps Scene flat, follows OSM/OGC conventions. |

### 8.4 — Cross-cutting decisions from this session

These are not numbered Q's but emerged during the session and need to be captured:

1. **Toggle audit + canonical home migration as a prep PR before celestial Phase 1.** ~1-2 sessions of work, purely additive (no behavior change), establishes `scene.globe.atmosphericConditions` as the canonical nested home with delegating shells preserving every legacy path. See §9.5.
2. **Format adapter layer for the invalidation feed.** Both the producer-v2 string-pattern format AND a hypothetical OGC implicit-tiling format flow through the same `Cesium3DTilesInvalidationFeed` via pluggable `InvalidationFormatAdapter`s. See §6.
3. **`Scene._snapshotVersion` hook in the invalidation feed from day 1.** 5 minutes of code, zero risk, prevents painful retrofit when snapshot mode lands after Sprint 2.
4. **VisualPerformanceTargetService** is a new feature emerging from B7. Sprint 4 slot. Off by default. Respects `scene._renderRequested` and snapshot mode — won't degrade quality just because the scene is idle. See §10.

### 8.5 — Remaining open items (not blocking, but tracked)

These are NOT blocking — they're "future nice-to-haves" that came out of the session.

1. **3D Tiles spec re-verification for water/bathymetry** — the C4 finding came from training knowledge (cutoff May 2025), not live spec inspection. ~1-hour task: search `github.com/CesiumGS/3d-tiles/issues` for "water" / "bathymetry" / "hydrography" and refresh §9.3 if anything moved between May 2025 and now.
2. **Higher-resolution moon texture** for the "fly to moon" use case. Low priority. Half-session.
3. **Transport modernization survey** (WebSocket / SSE / HTTP3 / QUIC unified abstraction). Scope larger than the invalidation feature alone — should serve any future live-data system in Cesium. Separate design doc.

---

## 9. Supporting Analysis (Appendices)

This section captures the analysis behind the decisions in §8. Each subsection answers a question that was raised during the session, with file references and rationale.

### 9.1 — A4: 3D Tiles bounding volume containment IS a spec rule

**Question:** Does the producer guarantee that a re-fetched tile's new bounds are contained within the parent's new bounds, or do we need defensive verification client-side?

**Answer:** Yes, this is a hard 3D Tiles spec rule — verified two ways.

**Cesium's own source code documents the rule.** [Cesium3DTile.js:137-141](packages/engine/Source/Scene/Cesium3DTile.js#L137):

```js
// Non-leaf tiles may have a content bounding-volume, which is a tight-fit bounding volume
// around only the features in the tile.  This box is useful for culling for rendering,
// but not for culling for traversing the tree since it does not guarantee spatial coherence, i.e.,
// since it only bounds features in the tile, not the entire tile, children may be
// outside of this box.
```

Two distinct bounding volumes per tile:

| Field | Spec rule | Used for |
|---|---|---|
| **`tile.boundingVolume`** | "The bounding volume MUST enclose all descendant tiles' bounding volumes." | Hierarchical view-frustum culling — relies on the containment guarantee |
| **`tile.content.boundingVolume`** | "Tight-fit bounding volume around only the features in this tile." | Per-tile rendering cull — does NOT guarantee containment of children |

The comment exists *specifically* to distinguish these two — the only difference between them is whether they guarantee containment.

**The 3D Tiles 1.1 spec defines this in `tileset/tile.schema.json`** and the narrative spec explicitly says hierarchical culling depends on the containment property. Stable since 3D Tiles 1.0 (2017).

**Implication for the invalidation feed:** trust the producer's containment invariant without verifying. The verification cost is non-trivial (walk the tree, intersect bounds), and the spec says the producer is required to honor it anyway. If a malformed producer violates it, the visible symptom is "some children get culled that shouldn't" — same root cause as any malformed 3D Tiles dataset. Not the invalidation feed's job to defensively repair.

**One exception:** if a re-fetched tile's *new* bounds are larger than the *previously cached* bounds for that tile (rare growth case), the spatial index node needs to update before culling sees it. We need this for general bounding-volume-change support anyway, so it's not extra work.

### 9.2 — A7: What snapshot rendering mode is and why it's worth shipping

Babylon.js calls this **FastSnapshotRendering** ("SRM"). It's their answer to a problem WebGPU has and WebGL didn't: **CPU encoding cost is now significant relative to GPU work for static scenes.**

**The problem:** WebGPU's per-frame CPU work is roughly:

1. Walk the scene, decide which draw commands to issue
2. For each draw: pipeline lookup → bind groups → vertex/index buffers → encode draw call
3. Submit command buffer
4. GPU executes

Steps 1-2 are CPU-bound and run every frame even if nothing changed. For a globe with 2,000 visible tiles, that's a few milliseconds of CPU work. WebGL drivers cached most of this internally; WebGPU pushes it back to the application by design. For interactive scenes (camera moves, animations, LOD changes) this is fine. For locked-orbit inspection (camera parked, no animation, no LOD changes) it's pure waste.

**What snapshot mode does:**

| Mode | Behavior |
|---|---|
| `STANDARD` | Re-encode every frame. Default. Required for animated/interactive scenes. |
| `FAST` | Encode the GPU command buffer once, replay the same buffer until the user signals "scene changed." CPU drops to near zero. |

**Why this matters for Cesium specifically:** geospatial users have a use case game engines don't — the **locked-orbit inspection workflow.** Load a 3D Tiles dataset, fly to it, park the camera, stare at it for minutes during analysis. During those minutes 95% of CPU encoding is pure repetition. Snapshot mode would drop CPU to single-digit percent during these stretches. Other use cases that benefit: embedded thumbnails, comparison views, CI screenshot rendering, background tab rendering.

**Integration with live invalidation:** invalidation events bump `Scene._snapshotVersion`. Snapshot mode watches this counter — any bump invalidates the snapshot, falls back to per-frame encoding for one frame to record the new state, then re-locks. From the user's perspective: scene visibly updates within one frame of the invalidation, immediately returns to snapshot mode.

**Implementation cost:** the design proposes building on top of existing `WebGPURenderBundleManager` (which already caches per-tile bundles) by promoting bundle caching to a full frame-level snapshot. This is interesting because bundles today are per-pass; snapshot mode needs cross-pass scope. A 1-2 day spike before committing to the full implementation would surface which Cesium subsystems use dynamic per-frame resources that would need to opt out (likely candidates: `WebGPURingBufferAllocator`, `WebGPUGPUCuller`, anything driven by `frameState.time`). Estimated total: 4-6 days on top of existing render bundle infrastructure.

**Schedule:** after Sprint 1 (visual quality activation) and Sprint 2 (TAA / CSM / volumetrics) land. The visual quality features benefit more users than snapshot mode does, and snapshot mode has more knobs to turn after they ship.

### 9.3 — C4: 3D Tiles already supports water classification via `EXT_structural_metadata`

**Source:** training knowledge through May 2025; live re-verification recommended (see §8.5 item 1).

**3D Tiles 1.1 supports** the metadata machinery we need for water classification:

- **`tile.metadata`** — arbitrary key/value metadata per tile, schema-validated
- **`tile.content.metadata`** — same per content
- **`group.metadata`** — group-level metadata multiple tiles can reference
- **Property semantics** — registered list of standard semantic names (terrain-related: `_GEOID_HEIGHT`, `_TERRAIN_HEIGHT_MIN`, `_TERRAIN_HEIGHT_MAX`, `_TILE_TIGHTBOUNDS`)

The semantics list as of 1.1 has **no water-specific semantics**. There is no `_IS_WATER`, no `_WATER_DEPTH`. However, the spec is **explicit that custom semantics are allowed** — implementers define their own with a leading underscore prefix and use them through the standard metadata machinery.

**Inside glTF tile content, `EXT_structural_metadata`** lets you attach:

- **Property tables** — per-feature attribute rows (each polygon in a vector tileset gets a row)
- **Property textures** — per-texel attribute lookups (terrain tile with per-texel "is water" mask)
- **Property attributes** — per-vertex attributes referenced by the metadata schema

For water, the natural fit is:

- **Per-feature** for vector tiles where each polygon is a water body — rows have `featureType: "river" | "lake" | "ocean"`, `width: float`, etc.
- **Property texture** for terrain tiles where water/land needs to be specified per-texel — exactly the use case quantized-mesh's water mask serves, but in a more general format
- **Property attribute** for terrain meshes where each vertex is tagged

**This is the existing standard. We can ship tomorrow on top of it without proposing any extensions.**

**Bathymetry** in 3D Tiles is currently handled by **just letting the terrain provider serve negative heights**. Cesium World Bathymetry on Cesium ion is exactly this — quantized-mesh tiles where heights below sea level are negative numbers. No special bathymetry semantic exists. Our water rendering system just needs to know "where is the water surface" and "what's the depth at this point" — both come for free if the terrain provider serves bathymetry.

**3D Tiles 2.0 / future spec:** as of mid-2025 the OGC 3D Tiles SWG was NOT actively working on a water-specific extension. Active work: I3DM revision, implicit tiling refinements, better metadata typing, multi-content improvements. **This may have changed in the months since.** A live re-check is the §8.5 item 1 backlog task.

**Recommendation:** build the water classification system on top of `EXT_structural_metadata` with our own custom semantic names (`_CESIUM_WATER_TYPE`, `_CESIUM_WATER_FLOW_X`, `_CESIUM_WATER_FLOW_Y`, `_CESIUM_CONTAINS_WATER_SURFACE`). These follow the spec's underscore convention. If a future spec adds standard names, we alias to them in a backward-compatible way.

### 9.4 — C9: ODbL share-alike legal note (OSM data licensing)

**Question:** What are the licensing implications of using OpenStreetMap data, and does Cesium need to take on share-alike obligations?

**Answer:** ODbL (Open Database License) distinguishes between **Derivative Database** and **Produced Work**.

- **Derivative Database** = a modified or extended version of the OSM data itself. Subject to share-alike. Example: bake OSM into a JSON dump and publish.
- **Produced Work** = something *created using* the database — a map image, a rendered scene, a 3D tile, a printed book, a video. **NOT** subject to share-alike. Only attribution applies.

The OSM Foundation explicitly addresses this in their [Community Guidelines on Share-Alike](https://wiki.osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline). A rendered map tile (even a Mapbox vector tile, which contains structured data) is generally treated as a Produced Work because it's the *output* of a styling process, not a redistribution of the source database.

**What this means for the Cesium water rendering feature:**

| Scenario | ODbL exposure |
|---|---|
| **Cesium ships no OSM data in the default build** (the chosen path) | ✅ Zero exposure. The default build contains no OSM-derived data, just the *capability* to consume it. The user takes on whatever ODbL obligations apply to *their* deployment. |
| **Sandcastle demo loads OSM data live with attribution** | ✅ Zero exposure for Cesium itself. The demo's output is a Produced Work. Demo must display "© OpenStreetMap contributors" + link to https://www.openstreetmap.org/copyright. |
| **Cesium ships pre-baked OSM-derived water polygons in the default build** (NOT the chosen path) | 🚨 Triggers ODbL. The bundled file is a Derivative Database. Cesium becomes subject to share-alike for that asset (not the rest of Cesium). Avoided. |

**Decision for C9:** Path 1 + Path 2. Ship no OSM data in the default build. The Sandcastle demo is allowed to use OSM live (with attribution) — exactly what Mapbox / Leaflet / OpenLayers / a hundred other tools do. **Net effect on Cesium:** engine code stays Apache-2.0, zero new licensing obligations, no share-alike anywhere in the dependency tree.

This is the same path `OpenStreetMapImageryProvider` already takes in upstream Cesium today: the class is Apache-2.0, the user provides the tile URL, the OSM attribution requirement falls on the user's deployment.

### 9.5 — Toggle audit findings (current state of Scene/Globe/Fog/Atmosphere toggles)

The current toggle landscape is **scattered** and the celestial design adding 14+ new toggles into this mess would create another wave of duplication. Findings:

**Atmospheric / lighting toggles are scattered across at least 5 owners**, with overlapping/duplicated state:

| Owner | Toggle | Notes |
|---|---|---|
| `Scene` | `skyBox`, `skyAtmosphere`, `sun`, `sunBloom`, `moon` | Existence-based on/off (set to undefined to disable) |
| `Scene` | `atmosphere` (an `Atmosphere` instance) | Holds `lightIntensity`, `rayleigh*`, `mie*`, `hueShift`, `saturationShift`, `brightnessShift`, `dynamicLighting` |
| `Scene` | `fog` (a `Fog` instance) | Holds `enabled`, `renderable`, `density`, `heightScalar`, `maxHeight`, `visualDensityScalar`, `screenSpaceErrorFactor`, `minimumBrightness` |
| `Globe` | `enableLighting`, `dynamicAtmosphereLighting`, `dynamicAtmosphereLightingFromSun`, `showGroundAtmosphere`, `enableNightLights`, `enableEnhancedOcean`, `showProceduralClouds`, `showWaterEffect` | Globe-specific lighting/atmosphere/water flags |
| `Globe` | `atmosphereLightIntensity`, `atmosphereRayleighCoefficient`, `atmosphereMieCoefficient`, `atmosphereRayleighScaleHeight`, `atmosphereMieScaleHeight`, `atmosphereMieAnisotropy`, `atmosphereHueShift`, `atmosphereSaturationShift`, `atmosphereBrightnessShift` | **Duplicate** of `Scene.atmosphere.*` — copied INTO the GlobeSurfaceTileProvider every frame at `Globe.js:1067-1083` |

**The Scene.atmosphere ↔ Globe.atmosphere\* duplication is the worst offender.** Same values, two homes, no enforcement that they match. Apps could set `scene.atmosphere.hueShift = 0.4` and `globe.atmosphereHueShift = 0.7` and the globe would silently ignore the Scene-level setting. This is upstream Cesium's debt, not ours, but **we shouldn't make it worse**.

**Proposed canonical home (introduced by the prep PR before celestial Phase 1):**

```text
scene.globe.atmosphericConditions = {
  // ── Lighting ──
  lighting: {
    sun:  { enabled, intensity, tint, ... },     // mirrors scene.light SunLight
    moon: { enabled, intensity, tint, phase, earthshine, ... },  // new
  },

  // ── Sky atmosphere ──
  skyAtmosphere: {
    enabled, lightIntensity,
    rayleighCoefficient, mieCoefficient,
    rayleighScaleHeight, mieScaleHeight, mieAnisotropy,
    hueShift, saturationShift, brightnessShift,
    starModulationCurve: { inflection, steepness },  // new (B4)
  },

  // ── Ground atmosphere ──
  groundAtmosphere: {
    enabled,
    perFragment,            // currently buried in tile provider
  },

  // ── Fog (atmospheric haze, not volumetric) ──
  fog: {
    enabled, renderable,
    density, heightScalar, heightFalloff, maxHeight,
    visualDensityScalar, screenSpaceErrorFactor, minimumBrightness,
  },

  // ── Volumetric fog (NEW, Phase 5) ──
  volumetricFog: {
    enabled,                       // (B18) off by default
    density, falloff,
    enableScatteringOcclusion,     // (B20) off by default, gated/no-op if !enabled
    quality,                       // "low" | "medium" | "high" | "auto" (B7/B17)
    maxDistance,
  },

  // ── Clouds ──
  clouds: {
    proceduralCoverage,            // existing 2D procedural cloud cover
    enableVolumetric,              // (B15) off by default, Phase 6
    volumetricQuality,             // "low" | "medium" | "high" | "auto"
    volumetricEnableAltitude,      // 50_000 m default
    volumetricDisableAltitude,     // 100_000 m default
  },

  // ── Stars and night ──
  night: {
    enableNightLights,             // mirrors globe.enableNightLights
    nightIntensity,
    enableTerminatorGlow,
  },
};
```

**Backward compatibility plan:** every legacy property becomes a getter/setter that delegates to the new canonical home:

```js
// Globe.js — preserved for backward compat
Object.defineProperty(Globe.prototype, "atmosphereHueShift", {
  get() { return this._atmosphericConditions.skyAtmosphere.hueShift; },
  set(v) { this._atmosphericConditions.skyAtmosphere.hueShift = v; },
});

Object.defineProperty(Globe.prototype, "showGroundAtmosphere", {
  get() { return this._atmosphericConditions.groundAtmosphere.enabled; },
  set(v) { this._atmosphericConditions.groundAtmosphere.enabled = v; },
});

// Same for Scene.atmosphere — its own properties become delegating getters/setters
// to scene.globe.atmosphericConditions.skyAtmosphere
```

**This means:**

1. Existing apps continue to work unchanged. `scene.fog.density = 0.001` still works, but it now writes through to `scene.globe.atmosphericConditions.fog.density`. Same value, same place.
2. The duplication is fixed at the storage layer — no more "Scene.atmosphere vs Globe.atmosphere\*" divergence, because both shells point at the same underlying object.
3. The new design has a clean nested home for new toggles that doesn't add to the existing scatter.
4. We don't deprecate or rename anything in this pass — that's a separate (much larger) effort. This change is purely additive: new canonical home + delegating shells.
5. Upstream sync stays clean — when upstream adds new properties to `Scene.atmosphere`, we just add them to the canonical home and add a delegating shell. No conflict.

**Effort:** ~1-2 sessions. Lands as a prep PR before celestial Phase 1.

### 9.6 — C8: How Cesium handles OSM data today (createOsmBuildingsAsync precedent)

**Question:** Does Cesium prefer OGC vocabularies or OSM-shaped vocabularies for feature classification?

**Answer:** **Cesium leans OGC for transports (how data moves) and source-native for vocabulary (what's inside the data).** For OSM-sourced data specifically, Cesium preserves OSM tag names verbatim and uses them in user-facing API examples.

**What Cesium ships as first-party providers / loaders:**

OGC standards (transport protocols) — these are how data gets *into* Cesium:

| Class | What it implements |
|---|---|
| `WebMapServiceImageryProvider` | OGC WMS 1.1.1 / 1.3.0 |
| `WebMapTileServiceImageryProvider` | OGC WMTS 1.0.0 |
| `TileMapServiceImageryProvider` | OSGeo TMS (de facto OGC) |
| `KmlDataSource` | OGC KML 2.2 |
| `GeoJsonDataSource` | RFC 7946 (IETF, OGC-aligned) |
| `Cesium3DTileset` | OGC 3D Tiles 1.1 |
| `I3SDataProvider` | OGC I3S |

These are clearly OGC-or-OGC-adjacent. Every "how do I load data from a server" path uses an OGC standard if one exists.

OSM as a data source — used in two specific places:

| Class | What it does |
|---|---|
| `OpenStreetMapImageryProvider` | Loads pre-rendered raster tiles from an OSM tile server |
| `createOsmBuildingsAsync` | Loads the Cesium OSM Buildings 3D Tileset from Cesium ion. **The styling references raw OSM tag names directly.** |

**The crucial finding from `createOsmBuildingsAsync.js`:**

The example style at [createOsmBuildingsAsync.js:48](packages/engine/Source/Scene/createOsmBuildingsAsync.js#L48) is the most revealing thing in the codebase for our question:

```js
new Cesium.Cesium3DTileStyle({
  color: {
    conditions: [
      ["${feature['building']} === 'hospital'", "color('#0000FF')"],
      ["${feature['building']} === 'school'", "color('#00FF00')"],
      [true, "color('#ffffff')"]
    ]
  }
})
```

`feature['building']` is **literally an OSM tag key**. The values `'hospital'` and `'school'` are **literally OSM tag values** (from `building=hospital`, `building=school`). Cesium's first-party documentation example shows users querying data using raw OSM vocabulary inside an `EXT_structural_metadata`-backed feature in a 3D Tileset.

**The producer (Cesium ion's tiler) preserved OSM tag names verbatim** when baking OSM into 3D Tiles. They didn't translate `building=hospital` into some normalized OGC `BuildingFunction.Healthcare` enum. They kept the OSM tag names as the schema.

**Pattern Cesium uses:**

- **Use OGC standards for the wire format** — that's how data flows from server to client. Standards-compliant transports get you compatibility with thousands of servers.
- **Preserve the source vocabulary as data** — don't pre-translate. Let the user's `Cesium3DTileStyle` expression query whatever the source happened to use. OSM-sourced data has OSM tag names, Esri-sourced data has Esri attribute names, INSPIRE-sourced data has INSPIRE schema names.

**Implication for our water classification design:**

1. Transport via OGC 3D Tiles + `EXT_structural_metadata` (already decided in C4 and C12).
2. Vocabulary inside the metadata: **preserve OSM tag names verbatim when the data source is OSM.** Don't translate `natural=water` + `water=lake` into some custom `WaterType.LAKE` enum at ingestion time. Let the data carry the raw OSM keys.
3. Provide a `WaterType` enum as a **renderer normalization helper, not as the canonical storage format.** The enum is what the rendering shader consumes — internally we map `(natural, water, waterway)` triples to a small enum so the shader doesn't have to parse strings. But on the data side, the metadata keeps the source's native vocabulary.
4. The adapter pattern is **internal renderer-side**, not user-facing. The renderer reads `feature['natural']`, `feature['water']`, `feature['waterway']` from OSM-sourced tilesets and reads other vocabularies from non-OSM sources, normalizing both into the same internal enum at the last possible moment before sampling the water material.

This matches **exactly** how Cesium OSM Buildings works today: data preserves OSM tags, user writes style expressions in OSM vocabulary, rendering engine has internal logic to extract semantics from those tags.

---

## 10. New Backlog Items From This Session

These are net-new items emerging from session decisions. They get added to `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` after this report is reviewed.

| ID | Item | Why | Effort | Slot |
|---|---|---|---|---|
| **NEW-1** ✅ DONE 2026-04-09 | **Toggle audit + canonical home migration prep PR** | Completed in Phase 0.1 + 0.2 + 0.3. `AtmosphericConditions.js` and `GlobeWater.js` facade classes shipped with delegating shells for all 97 legacy paths across 11 surfaces. `scene.globe.atmosphericConditions.*` and `scene.globe.water.*` are the canonical homes. Pure refactor, zero behavior change, `npx tsc --noEmit` clean. | ~1-2 sessions | ✅ Completed Phase 0.1-0.3 |
| **NEW-2** ✅ DONE 2026-04-09 (skeleton) | **VisualPerformanceTargetService** | Skeleton shipped in Phase 0.4. `packages/engine/Source/Services/VisualPerformanceTargetService.js` with `enabled`, `targetFps`, `snapshotMode`, `registerProbe`/`registerSink`/`tick(scene)`, plus contract guards (no-op while disabled, no-op in snapshot mode, no-op when `_renderRequested === false`). Wired into `Scene.js` as `scene.visualPerformanceTarget`. **Auto-tuning logic still pending** — Phase 1+ features register against the surface; the actual probe/sink logic lands when there are real consumers to test against. | ~2-3 weeks | ✅ Skeleton Phase 0.4; auto-tuning Sprint 4 |
| **NEW-3** ✅ DONE 2026-04-09 (skeleton + first consumer) | **Snapshot rendering mode** built on `WebGPURenderBundleManager` | Spike + skeleton shipped in Phase 0.7 (`SNAPSHOT_MODE_SPIKE_2026-04-09.md` + `packages/engine/Source/Services/SnapshotModeService.js`). Reconciles against `Scene._snapshotVersion` for auto-thaw on invalidation. Phase 1.2c v2 wires the **moon as the first real freezable consumer** — registers via `scene.snapshotMode.registerFreezable("moon-renderer", { freeze, thaw })`. The bundle manager freeze flag, camera-delta auto-thaw, and `markSnapshotDirty` event hooks are still pending — see `SNAPSHOT_MODE_SPIKE_2026-04-09.md` Phases A-D for the breakdown. | ~4-6 days + 1-2 day spike | ✅ Spike + skeleton Phase 0.7; Phases A-D pending |
| **NEW-4** | **Transport modernization survey** — unified abstraction over WebSocket / SSE / HTTP3 / QUIC for any future Cesium live-data system | Flagged in A5 as a future topic. Larger than the invalidation feature alone. Should serve invalidation feed, future GraphQL subscriptions, future telemetry feeds, etc. | ~1 week design + 2-3 weeks implementation | Future topic, separate design doc |
| **NEW-5** ✅ DONE 2026-04-09 | **3D Tiles spec re-verification for C4/C8/C11/C12** | Completed in Phase 0.6. All four assumptions verified. Three small refinements: (1) C4 wording fix (parent encloses child *content*, not child volumes), (2) C8 prefix-collision pattern (`EXT_:_NAME` form available if needed), (3) C11 needs an upstream PR to formally reserve quantized-mesh ID `0x05` before shipping, (4) C12 should describe `EXT_mesh_features` + `EXT_structural_metadata` as paired (feature IDs + property tables) not alternatives. Full results in `WATER_RENDERING_DESIGN.md §9.3`. | ~1 hour | ✅ Completed Phase 0.6 |
| **NEW-6** | **Higher-resolution moon texture** for the "fly to moon" use case | The current `moonSmall.jpg` is fine from Earth-distance views but blurry up close. Low priority. | ~half session | Future |
| **NEW-7** | **Quantized-mesh Option B version bump** for water classification | Document Option A (additive, ID `0x05`) shipping in water Phase 1. Option B (cleaner version-bumped format) deferred to Phase 9+ once we have ~6-12 months of real-world Option A usage. | ~2-3 sessions plus ecosystem coordination | Water Phase 9+ |
| **NEW-8** ✅ DONE 2026-04-09 | **Cesium3DTilesInvalidationFeed `_snapshotVersion` hook** | Folded into Phase 0.5. `Scene._snapshotVersion` declared in `Scene.js` constructor and bumped from `Cesium3DTilesInvalidationFeed.apply()` whenever an invalidation set is applied. SnapshotModeService (Phase 0.7) reconciles against it. | 5 minutes (folded into Phase 0.5) | ✅ Completed Phase 0.5 |
| **NEW-9** | **File upstream PR registering quantized-mesh extension ID `0x05`** | Phase 0.6 verification confirmed `0x05` is unassigned and available for the water classification extension (Option A wire format documented in `WATER_RENDERING_DESIGN.md §9.1`). Before water Phase 1 ships, file a PR against [CesiumGS/quantized-mesh](https://github.com/CesiumGS/quantized-mesh) to formally reserve the ID and document the wire format upstream. Avoids racing another extension proposal. | ~2 hours (PR draft + review) | Before water Phase 1 ships |

---

## Appendix A — Files referenced

| File | Purpose in this report |
|---|---|
| [.clinerules](.clinerules) | Project-wide rules; informed audit and design decisions |
| [Documentation/Contributors/CodingGuide/README.md](Documentation/Contributors/CodingGuide/README.md) | Naming, formatting, API conventions |
| [migration_doc/WEBGPU_MIGRATION_BACKLOG.md](migration_doc/WEBGPU_MIGRATION_BACKLOG.md) | Existing backlog (FORK-*, BUG-*, etc.) |
| [migration_doc/WEBGPU_MIGRATION_STATUS.md](migration_doc/WEBGPU_MIGRATION_STATUS.md) | What's shipped and verified |
| [packages/engine/Source/Scene/Cesium3DTile.js](packages/engine/Source/Scene/Cesium3DTile.js) | Existing zero-flicker swap (lines 2155-2185), expire parsing (379-401) |
| [packages/engine/Source/Scene/Cesium3DTileset.js](packages/engine/Source/Scene/Cesium3DTileset.js) | requestContent path for expired tiles (2591-2627) |
| [packages/engine/Source/Scene/Cesium3DTileContentState.js](packages/engine/Source/Scene/Cesium3DTileContentState.js) | EXPIRED state (index 4) |
| [packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts](packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts) | Lazy renderer registrations (AUDIT-1) |
| [packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts) | Subgroup gating (AUDIT-2), Hi-Z dispatcher (AUDIT-3) |
| [packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts](packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts) | Spike for runtime GLSL→WGSL |
| [scripts/bundleVariantPlugin.js](scripts/bundleVariantPlugin.js) | Build variant aliasing (shipped this session) |
| [scripts/stubs/emptyShader.js](scripts/stubs/emptyShader.js), [scripts/stubs/emptyModule.js](scripts/stubs/emptyModule.js) | Variant build stub targets |

## Appendix B — Agent reports (raw)

The four parallel research agents produced detailed outputs preserved at:

- `tasks/ab3357ee1be682a71.output` — Codebase audit, 49 findings (4000 words)
- `tasks/a280a9dd75d20aba4.output` — WebGPU renderer comparison, 70-feature matrix (4200 words)
- `tasks/a0ee1cbf54b2847cc.output` — GIS viewer comparison, 30 user-need rows (3200 words; original `aa3285bce61ac9c08.output` failed with API 529, this is the successful retry)
- `tasks/a32a6e834d1ac2d98.output` — 3D Tiles invalidation design (6500 words; superseded for the producer-format details by §6 above, but the foundational analysis of Cesium's existing machinery is the source for the file:line references)

These are temp files and may not persist past the session. The findings are summarized in this report.

---

*End of session report. See `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` for the running backlog and `migration_doc/WEBGPU_MIGRATION_STATUS.md` for shipped work. This report is dated and not maintained as a living document, EXCEPT that §8 (Decisions Locked This Session) is the source of truth for implementation work derived from this session. Sections 1-7 capture the original research; §8 captures the decisions; §9 captures the supporting analysis; §10 captures the new backlog items. When sprint planning references "the 2026-04-08 decisions," they mean §8 specifically.*
