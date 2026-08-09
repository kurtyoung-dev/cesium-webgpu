# Imagery Projection — Architecture & Renderer Mapping

**Created:** 2026-05-16 (Batch 55)
**Purpose:** Single source of truth for how Cesium handles imagery layer projection across the WebGL and WebGPU renderers. Updated every time we touch the imagery sampling, reprojection, or tile-UV math.

Every fix to imagery rendering (`*Reprojection*`, `GlobeFS.glsl`, `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `WebGPUGlobeSurfaceCameraUB.ts`) must end with a check that this doc still matches reality.

---

## High-Level Model

Cesium tiles the world in two independent quadtree spaces:

- **Terrain space** — the geometry tiles produced by the active terrain provider. The provider's `tilingScheme.projection` decides whether tile rectangles live in **Geographic** (lon/lat radians, equirectangular world map) or **Web Mercator** (square world map).
- **Imagery space** — same idea for the active imagery provider. May differ from the terrain projection.

When the two differ the renderer has to **reproject** so each terrain tile fragment can sample the right pixel of the imagery texture. The common case in this codebase is **Mercator imagery on Geographic terrain** (Bing aerial on the default WGS84 ellipsoid, or any of the imagery layer picker's options on top of `EllipsoidTerrainProvider`).

Three primitives carry the projection bookkeeping per (tile, imageryLayer) pair on `tileImagery`:

| Field | What it carries | Computed by |
| --- | --- | --- |
| `useWebMercatorT` | "Is the per-vertex `webMercatorT` attribute valid AND should the shader sample with it instead of the geographic V?" | `ImageryLayerHelpers.js:80` — true iff (a) imagery is Web Mercator AND (b) the tile is entirely inside `WebMercatorProjection.MaximumLatitude` (±85.05°) |
| `textureTranslationAndScale` | Affine mapping from base tile-UV [0,1] to imagery-texture-UV. `(tx, ty, sx, sy)` | `ImageryLayer.js:_calculateTextureTranslationAndScale` — branches on `useWebMercatorT` |
| `textureCoordinateRectangle` | Alpha-mask rect in tile-UV space. Fragments outside go to alpha=0 | `ImageryLayerHelpers.createTileImagerySkeletons` — branches on Mercator vs Geographic |

**Key observation about `useWebMercatorT`:** it is a function of the **tile's latitude range**, not the LOD. Level-0/1 polar-spanning tiles get `false` even when the imagery is Mercator; mid-latitude high-LOD tiles get `true`. This determines which sampling path the shader runs.

The vertex format for terrain tiles has an optional `webMercatorT` attribute. Whether it's present is a function of `encoding.hasWebMercatorT` (decided at mesh-creation time by the terrain provider for tiles whose imagery may require Mercator-V sampling). A tile with `encoding.hasWebMercatorT=true` AND `tileImagery.useWebMercatorT=false` for the current layer is normal — the vertex attribute is just unused for that layer.

---

## Per-Renderer Implementation

### Geographic terrain + Geographic imagery (trivial)

Both rectangles are in radians. Sample at `tileUV * scale + translation` directly. No reprojection needed. Both renderers handle this identically — the WebGL path falls through to the simple branch of `_calculateTextureTranslationAndScale`, and the WebGPU path takes the cached value.

### Mercator terrain + Mercator imagery

Both rectangles are in Mercator-Y. The terrain tile's rectangle is already in Mercator natively (terrain provider matches imagery scheme). Sample at `tileUV * scale + translation`. Both renderers fine.

### Mercator imagery on Geographic terrain — the interesting case

The terrain tile rectangle is in radians; the imagery is stored Mercator-projected. Two distinct paths depending on tile latitude:

#### Path A — `useWebMercatorT == true` (tile entirely inside ±85°)

The terrain mesh carries a `webMercatorT` vertex attribute (a precomputed Mercator-V for each vertex's geographic latitude). The shader samples the Mercator-source imagery texture using `(u, webMercatorT)` instead of `(u, geographicV)`. No reprojection happens — we sample the original Mercator texture directly.

**WebGL** (`GlobeFS.glsl`):

- Vertex shader reads `webMercatorT` attribute → passed as varying.
- Fragment shader uses `u_dayTextureUseWebMercatorT[i]` boolean to choose between geographic V and webMercatorT.
- Binds `imagery.textureWebMercator` (the unreprojected Mercator texture).
- `_calculateTextureTranslationAndScale` converts both rectangles to Mercator-native meters before computing scale/translation, so the affine math lives in Mercator-Y space matching the per-vertex webMercatorT.
- `textureCoordinateRectangle` is also in Mercator-Y tile-UV space.

**WebGPU** (`GlobeTerrain.wgsl` + `WebGPUGlobeSurfaceTileUB.ts` + `WebGPUGlobeSurfaceTextures.ts`):

- Vertex pipeline selects `vertexMainWebMerc` / `vertexMainWebMercNormals` / `vertexMainQuantizedWebMerc` / `vertexMainQuantizedWebMercNormals` depending on `(isQuantized, hasNormals)`. The vertex attribute layout for these entry points includes the webMercatorT slot — `float32x3` (u, v, mercT) or `float32x4` (u, v, mercT, encodedNormal) for uncompressed; compressed paths decode mercT from `compressed0.w` or a separate attribute slot. See `WebGPUGlobeSurfacePipelines.ts:200-247`.
- `v_textureCoordinates: vec3<f32>` carries (u, v_geographic, webMercatorT) through to the fragment.
- Fragment helper `selectLayerUV(geoUV, webMercT, useWebMerc)` picks per-layer.
- `useWebMercatorTLayer[4]` uniform packs 16 layer flags (4 per vec4) so the unrolled per-layer fragment blocks stay branch-light.
- Texture binding (`getOrCreateImageryTexture`): falls through to the standard `imagery.image` upload path (the per-tile Mercator-source ImageBitmap). The cached upload is reused on subsequent frames.
- `tileImagery.textureTranslationAndScale` cached value is in Mercator-Y — passed through unchanged.
- `tileImagery.textureCoordinateRectangle` cached value is in Mercator-Y — passed through unchanged.

**This path is known-working on WebGPU.** Verified at close-zoom over Texas (1 Mm altitude) in `probe-wgs84.mjs`.

#### Path B — `useWebMercatorT == false` (tile spans past ±85°, level-0/1 polar tiles)

The geographic terrain tile covers latitudes the Mercator imagery cannot reach. The shader must sample the imagery at the geographic V, which requires a per-fragment Mercator-Y reprojection.

**WebGL** (`Scene/ImageryLayer.js` + GLSL):

- A separate ComputeCommand runs `ReprojectWebMercatorVS.glsl` + `ReprojectWebMercatorFS.glsl` on a 64-row vertex grid. Each vertex has a precomputed `webMercatorT` for its geographic-V row. Rasterization interpolates between rows, producing a geographic-projected output texture.
- The result is stored on `imagery.texture` (the regular WebGL texture handle).
- Subsequent globe rendering samples `imagery.texture` at geographic V via the standard sampler. `useWebMercatorT` is false → fragment uses geographic V.
- `_calculateTextureTranslationAndScale` takes the else branch (geographic-radians math).
- `textureCoordinateRectangle` is in geographic-radians tile-UV.

**WebGPU** (`WebGPUImageryReprojection.ts` + `WebGPUGlobeSurfaceTextures.ts` + `WebGPUGlobeSurfaceTileUB.ts`) — **Batch 65 dual-texture model**:

- When the imagery FIRST becomes ready AND the provider is Mercator, `ImageryLayer._reprojectTexture` calls `fr.uploadAndReproject(device, image, …)` which produces **two** `GPUTexture`s with full mip chains: `imagery._webgpuMercatorTexture` (the raw Mercator source, mirrors WebGL's `imagery.textureWebMercator`) and `imagery._webgpuReprojectedTexture` (the geographic reprojection, mirrors WebGL's `imagery.texture`). Both are uploaded eagerly — regardless of whether `needGeographicProjection` is set at the time — so the bind-group setup and the tile-UB packer (which iterate `passLayers` independently inside the renderer) see a consistent dual-texture state from frame 1.
- Texture binding (`getOrCreateImageryTexture(host, tileImagery)` in `WebGPUGlobeSurfaceTextures.ts`): picks the variant matching the per-tile `tileImagery.useWebMercatorT` flag. Mercator-binding tiles → `_webgpuMercatorTexture`, cached under `${imagery.key}_merc`. Geographic-binding tiles → `_webgpuReprojectedTexture`, cached under `${imagery.key}`. Returns `{ view, isMercator }` so callers can keep `useWebMercatorTLayer` in lock-step with the binding decision.
- `useWebMercatorTLayer[i] = (tileImagery.useWebMercatorT && !!imagery._webgpuMercatorTexture) ? 1 : 0` — written by `WebGPUGlobeSurfaceTileUB.ts`. Tracks what the cache will actually bind. The WGSL `selectLayerUV` then samples at `webMercatorT` for Mercator layers and `geoUV.y` for geographic layers.
- `tileImagery.textureTranslationAndScale` and `textureCoordinateRectangle` are used **as cached** — no inline recalc. `_calculateTextureTranslationAndScale` already produces Mercator-space values when `useWebMercatorT === true` and geographic-space values when `false`, which is exactly what the matching bound texture needs. (The Batch 46 and Batch 49 inline recalcs were removed in Batch 65 because they were patching for the single-texture model that no longer exists.)
- Geographic providers (no reprojection needed) still go through the legacy lazy-upload path in `getOrCreateImageryTexture` — `imagery.image` is uploaded on demand as a single geographic-keyed texture. `_webgpuMercatorTexture` stays undefined for these, and `useWebMercatorT` is false at skeleton time anyway, so the dual cache naturally collapses to the single geographic variant.

**Resolved (Batch 56):** the orbit-WGS84 catastrophe turned out to NOT be a projection bug — the projection chain was mathematically correct (`useWebMercatorTLayer`, `translationAndScale`, `textureCoordinateRectangle` all right). Three distinct bugs in the per-tile fragment pipeline downstream of imagery sampling stacked together to produce the mesh-pattern + dark-globe rendering:

1. **Reprojected-texture alpha=0** (`WebGPUImageryReprojection.ts`). `copyExternalImageToTexture` on an opaque JPEG source does not populate the destination alpha channel; the texture's alpha ended up at 0 for every reprojected texel. The downstream `applyImageryLayer` chain multiplies by `texSample.a` (`effectiveAlpha = layerMask * layer.alpha * sampleAlpha * texCoordsMask * dayNightAlphaValue * splitMask * cutoutMask`) so every reprojected-imagery composite produced zero contribution → black tiles. **Fix:** force `alpha=1.0` in the reprojection fragment shader output. Source imagery from the Mercator providers is always opaque (Bing aerial JPEG, Esri WorldImagery JPEG), so this is safe. If/when transparent imagery providers need support, this needs to be conditional on the source format.
2. **Ray-sphere intersection precision loss** (`raySphereIntersectionInterval` in `GlobeTerrain.wgsl`). The naive formulation `c = dot(origin, origin) - radius*radius` for a Cesium-scale camera at 1.6e7 m loses ~10m of precision (1.6e7 squared = 2.56e14, beyond f32's 24-bit mantissa integer range). **Audit note:** this fix did NOT visibly change the rendering on its own — Bug 3 below is what eliminated the mesh-pattern. WebGL has the same imprecision in its `czm_raySphereIntersectionInterval` and renders correctly because it switches to per-fragment math at orbit. We keep the WGSL precision improvement as a defensive correctness fix; it costs one divide + multiply per call and may matter for future ray-sphere uses elsewhere in the renderer. **Fix:** scale `origin` by `1/radius` before the dot product so all intermediate quantities stay in the [-10, 10] range where f32 precision is ~1e-6.
3. **Per-vertex ground atmosphere at orbit distance** (`GlobeTerrain.wgsl` fragment main, ground atmosphere drape branch). At orbit altitudes the per-vertex Rayleigh/Mie ray march produces wildly different optical depths between front-side vertices (110m of atmosphere) and far-side / limb vertices (13Mm of atmosphere). Linear interpolation across triangles spanning the limb produces a visible mesh-pattern artifact that the `mix(color, draped, fadeAmount=1.0)` then overwrote imagery with. **WebGL avoids this** via `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE` (defined CPU-side when `cameraDist > nightFadeOutDistance`) which calls `computeAtmosphereScattering` per-fragment in `GlobeFS.glsl` lines 492-501. **Fix:** WGSL now always calls `computeAtmosphereScatteringGround(positionWC, lightDir)` per-fragment inside the ground-atmosphere drape branch. Re-introducing the close-camera per-vertex optimization is a future task.

**Batch 57 fixes (2026-05-16) — imagery mipmap chain + LOD-aware sampling:**

4. **WebGPU imagery textures had no mipmap chain.** `uploadImageSource` and `WebGPUImageryReprojection` both allocated single-mip textures. WebGL calls `gl.generateMipmap` after every imagery upload — without an equivalent, the GPU has no lower-resolution mip to sample at orbital altitudes, point-samples Level 0, and aliases under-sample bright pixels. **Fix:** allocate with `mipLevelCount = floor(log2(maxDim)) + 1` and run `WebGPUMipmapGenerator.generateMipmapsAndSubmit` after upload / reprojection. Per-device generator caches per-format pipelines internally.
5. **`sampleImagery` used `textureSampleLevel(LOD=0)`, hard-locking to mip 0.** Even with the chain present from fix 4, the sampler never picked anything but mip 0. The comment cited the WGSL rule that `textureSample` requires uniform control flow (clipping-plane discards in `globeClipByPlanes` break it). **Fix:** switch to `textureSampleGrad(uv, uv_dx, uv_dy)` — picks a mip from gradient magnitude AND is legal in non-uniform control flow. Derivatives `geoUV_dx`/`geoUV_dy` are pre-computed at `fragmentMain` entry (uniform CF), then per-layer `uv_dx`/`uv_dy` are chosen via a new `selectLayerUVDerivative` helper (geographic vs webMercatorT-sampled layers have different derivatives because their V coordinate differs).

**What's still suspected (residual brightness mismatch):**

- The headline 4.2× brightness ratio reported pre-Batch-56 was inflated by an unrelated measurement bias — the previous probe averaged over the full sample region, dragged down by WebGPU rendering the globe ~10% smaller in screen space. The new per-globe-pixel measurement (`probe-brightness-ratio.mjs`) reports a 1.13× average — close to parity. Close (1 Mm) and orbit (20–40 Mm) are at parity; the remaining real per-pixel gap is concentrated at mid-distances (5–12 Mm altitude, ratio ~1.5×). Suspects: drape branch's `1 - exp(-2*x)` tonemap interacting with the partially-engaged `fadeAmount` ramp at those distances; the close + orbit ends of the ramp work fine. Chasing this is a future batch (R-7-MID-FADE-BRIGHTNESS).

**Batch 58 update (2026-05-16):** the residual mid-distance gap had nothing to do with the drape branch — it was the WGSL `computeEnhancedOcean` function REPLACING the imagery with a deep-color blend (`mix(baseColor × darkening, deepColor, 0.6)`) instead of WebGL's ADDITIVE highlight pattern (`color = imageryColor + diffuseHighlight + specular`). For pure-water fragments, the replacement dimmed Bing aerial ocean by ~5×, and since ocean covers most of the visible globe at mid/orbit altitudes, this dominated the brightness measurement. The fix has two parts:

6. **`computeEnhancedOcean` rewritten** to mirror WebGL's additive-highlights pattern — wave-band diffuse + optional GGX specular sun-glint added on top of imagery, never replacing it.
7. **`tile.flags.x` gated** on `tileProvider.showWaterEffect === true` (renamed from `hasWaterMask` to `showReflectiveOcean`) to match WebGL's `SHOW_REFLECTIVE_OCEAN` define.

Post-Batch-58 brightness ratios (per-globe-pixel): mid-5mm 1.026, mid-12mm 1.144 (down from 1.529 / 1.526). `probe-saved-view` caribbean-mid diff% dropped from ~90% to 1.89% — essentially pixel-perfect parity. Average ratio: 0.93×.

**Batch 60 update (2026-05-17):** canvas-source imagery (notably `TileCoordinatesImageryProvider` and the fork-added `DebugTileImageryProvider`) rendered upside-down on WebGPU. The WGSL globe-FS samples at `(u, geoUV.y)` where `geoUV.y = 0` is the tile's SOUTH edge (the WebGL V=0-at-bottom convention preserved through the shared terrain mesh). For the texture to honor this, the source image's row 0 must end up at V=1 of the texture. The standard imagery providers route through `Resource.fetchImage({ flipY: true })` which decodes via `createImageBitmap(blob, { imageOrientation: "flipY" })`, so ImageBitmaps arrive PRE-FLIPPED and `flipY: false` on `copyExternalImageToTexture` is correct for them. Canvases / HTMLImageElements are NOT pre-flipped and need `flipY: true` on upload. **Fix:** `uploadImageSource` ([WebGPUGlobeSurfaceTextures.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts)) sets `flipY: true` for `HTMLCanvasElement` / `HTMLImageElement` sources, `flipY: false` for `ImageBitmap`. A blanket-`flipY: true` was tried earlier and broke close-zoom Bing (wgs84-close 1% → 57% diff) because it double-flipped the already-flipped ImageBitmaps — the conditional version is the correct version.

**Realization sharing + frame-owned mip prep (C9-12A, Batch 685, 2026-07-17) — OWNERSHIP only, never projection:** the WebGPU direct-upload path (`uploadImageSource` for geographic providers) now dedups the backend GPU texture for immutable sources. A single immutable source (an `ImageBitmap`, or a provider-declared-immutable canvas such as `GridImageryProvider`'s constructor-drawn grid — declared via `Renderer/ImagerySourceIdentity.ts`) is realized ONCE into a shared `GPUTexture`+view held by a per-context, device-scoped `WebGPUSharedImageryRealizations` table and referenced by every tile that binds it (measured: 1 realization + 31 shares on a GridImagery 3-altitude route; the C9-01 baseline was 513 identical realizations). Distinct sources (real per-tile streamed ImageBitmaps) get distinct realizations — real imagery stays distinct and never aliases. Mip generation moved out of draw emission into a frame-owned `"ImageryMipPreparation"` encoder submitted before the frame encoder (`WebGPUContext.enqueueImageryMipGeneration` → `endFrame`), eliminating the per-tile private submit. **This changes only who OWNS the GPUTexture and when its mips are encoded — it does NOT touch `resolveImageryProjection` (the merc/geo/upload decision), the flipY table above, the sRGB copy, the sampler, or the reprojection (Route B) path.** Rendered imagery is byte-identical (crossBackend `globe-default` 0.46%; `probe-terrain-selection-parity` GridImagery webglHash === webgpuHash exact). Sharing lives BELOW the cache (a `shared` reference on the cache entry). **Cache key (Batch 686, review F5):** the per-renderer imagery cache key is now LAYER-SCOPED — `imageryCacheKey(imagery)` in `WebGPUGlobeSurfaceTextures.ts` returns `L{layerId}_{x}_{y}_{level}` (stable per-`ImageryLayer` WeakMap id; `imagery.key` still wins if ever assigned), closing the cross-layer x/y/level collision at the root. Both derivation sites (`resolveImageryProjection` + `getOrCreateImageryTexture`, including the `_merc` variant suffix) route through the one helper. This is a cache-identity change only — projection-variant selection, flipY, sRGB, and reprojection are untouched. See `WEBGPU_DEBUGGING_LOG.md` C9-12A.

**Polar black hole — RESOLVED (Batch 62, 2026-05-17):** WebGPU previously showed a solid-black circular hole at the south pole when looking straight down at it (~within ±2° of -90° latitude) while WebGL rendered imagery + tile labels normally. It was diagnosed in Batch 61 (the initial `tile.layerCount = 0` hypothesis was wrong) and root-caused in Batch 62: the Batch-49 inline geographic recalc in `WebGPUGlobeSurfaceTileUB.ts` clobbered the base-layer `minV = 0` south-edge fixup (forcing `rect.y` back to the geographically-correct ~0.96), so the layer-0 alpha mask read 0 across the polar gap and the fragment composited to near-black. The fix gated that recalc on `useWebMercatorT === true`; Batch 65 then removed the recalc entirely with the dual-texture move (see the [base-layer south/north fixup](#base-layer-southnorth-fixup-the-polar-black-hole-gotcha) section). `polar-southpole-close` is now near-pixel-identical to WebGL (~2.6% plain-probe residual). See `WEBGPU_DEBUGGING_LOG.md` Batches 61/62.

**Residual polar/orbit pixel mismatch — the Batch-64 "unfixable drift" verdict was WRONG (corrected 2026-07-02, GLOBE-POLAR-STRETCH):** the 12–46% pixel mismatch at polar/orbit views was NOT cross-vendor numerical drift — the bulk of it was the `ReprojectWebMercator.wgsl` double vertical flip (see the reprojection-compare section below). That bug latitude-mirror-warped every reprojected (geographic-variant) texture built from an imagery tile that is not symmetric about the equator; since ALL far-zoom terrain tiles sample the reprojected variant (`useWebMercatorT=false` for tiles spanning past ±85°), the whole far-zoom disc was misprojected — the long-standing user-visible "polar stretch". Post-fix `probe-polar-multi-plain` numbers (2026-07-02): northpole-close 2.4%, northpole-orbit 6.4%, southpole-close 2.7%, southpole-orbit 5.4%, equator-mid 1.2%, midlat-mid 1.5%. What remains at that level IS the cross-vendor filtering/AA drift Batch 64 described, plus atmosphere-limb brightness and the WebGPU tile-seam lines (tracked separately). These are the new baseline numbers to gate against. See `WEBGPU_DEBUGGING_LOG.md` Batch 64 (history) and GLOBE-POLAR-STRETCH (2026-07-02).

---

## Fragment Compositing (how imagery becomes a final pixel)

Once imagery is sampled the fragment-side composite is structurally identical between renderers but spelled out differently. Both apply the same effect chain per imagery layer, then mix toward ground-atmosphere drape near orbit altitudes. The drape branch is the single biggest divergence between WebGL and WebGPU and is where the WGS84 mesh-pattern bug lived.

### Per-layer composite (WebGL `GlobeFS.glsl` `sampleAndBlend` / WGSL `applyImageryLayer`)

The output of `sampleImagery` is one `vec4` per bound layer. For each non-zero layer:

```text
sampleAlpha = colorToAlphaKey(texSample, layer.colorToAlpha)  // -1 sentinel disables
adjusted    = pow(texSample.rgb, layer.oneOverGamma)
splitMask   = (split == NONE) ? 1 : (split == LEFT && fragX < splitX) ? 1 : 0  // or RIGHT variant
cutoutMask  = (boundsUV inside layer.cutoutRectangle) ? 0 : 1
adjusted    = brightness × contrast × hueShift × saturation chain (BCHS)
texCoordsMask = step(rect.xz, selV) × step(selV, rect.yw)  // alpha mask; selV = per-layer selected V (Mercator-V if useWebMercatorT else geoUV) — see "Imagery alpha-mask V-space"
dayNightVal = mix(nightAlpha, dayAlpha, dayFade)
effectiveAlpha = layerMask × layer.alpha × sampleAlpha × texCoordsMask × dayNightVal × splitMask × cutoutMask
color = mix(prevColor, adjusted, effectiveAlpha)
alpha = max(prevAlpha, effectiveAlpha)
```

**WebGL** runs this once per layer slot (`czm_globe_translucency_main`, looping over `TEXTURE_UNITS` constant). The number of layer slots is whatever the pipeline cache decided to compile for this tile.

**WebGPU** unrolls 16 layer slots in `fragmentMain` (`GlobeTerrain.wgsl` ~lines 2308-2479) because WGSL cannot dynamically index a texture binding. The `count = u32(tile.layerCount)` gate skips inactive slots; the cost of the unused branches is one comparison plus a structurally-zero mask in the helper. **Adding a 17th layer slot requires updating both the bind-group layout and unrolling another `if (count >= 17u)` block.**

> **Alpha-mask test V — fix landed (re-verified 2026-08-08 at C16-05).** The latent latitude-gated bug recorded here is closed. `applyImageryLayer` now takes two bounds coordinates: `texCoordsBoundsUV` (the per-layer selected V from `selectLayerUV`, used for the `texCoordsRect` alpha-mask test) and `boundsUV` (the geographic `geoUV`, used only for `cutoutRectangle`). Every one of the 16 unrolled call sites passes `applyImageryLayer(color, alpha, tex, geoUV, uv, …)`, so the test V and the sample V are the same per-layer V, as WebGL requires. See **Imagery alpha-mask V-space** below for the canonical model.
>
> **UV clamp at fragment entry (GLOBE-POLAR-STRETCH-POLISH, 2026-07-02):** both backends clamp the interpolated tile UV to `[0,1]` before it feeds the composite. WebGL: `computeDayColor(u_initialColor, clamp(v_textureCoordinates, 0.0, 1.0), ...)` (`GlobeFS.glsl:396`, upstream's rasterizer-overshoot workaround). WGSL: `geoUV`/`webMercT` are clamped where they are unpacked at `fragmentMain` entry (`GlobeTerrain.wgsl` — `clamp(input.v_textureCoordinates...)`). Without the clamp, tile-edge fragments interpolate UVs epsilon-outside `[0,1]`, fail the `texCoordsMask` step test, and expose the dark-blue `initialColor` as dashed tile-seam grid lines (BUG-GLOBE-TILE-SEAM-LINES — was 62% of the mid-zoom WebGL↔WebGPU residual). Do not remove the clamp on either backend. (Debug-only: the `bypass-seam-clamp` globe-fragment debug mode, sentinel 25e9, reverts the WGSL clamp at runtime for A/B attribution — NEW-GLOBE-BELOWSURFACE-DECOMP; production-inert.)

### Subsequent vs first pass

When a tile is split across frustums, the renderer issues two draw commands with different blend modes:

- **First pass** (`isSubsequentPass = false`): opaque blend, full effect chain runs (material composite, lighting, fog, ground atmosphere, HSB).
- **Subsequent pass** (`isSubsequentPass = true`): additive blend, ONLY the per-layer imagery composite runs. The shader returns `vec4(color, alpha)` right after the layer block (`GlobeTerrain.wgsl` ~line 2495).

The subsequent-pass branch matters because additive over an already-shaded first-pass color must not double-apply atmosphere/fog. Both renderers honor this.

### Ground atmosphere drape — biggest renderer divergence

After the per-layer composite, both renderers mix the imagery toward atmospheric scattering. This is what makes the globe look like a planet with sky around it instead of a flat disk of pixels.

The drape formula (WebGL `GlobeFS.glsl` lines 535-563, WGSL `GlobeTerrain.wgsl` lines 2667-2841):

```text
transmittance       = 0.5 + clamp(1 - groundAtmosphereColor.a, 0, 1)
finalAtmosphereColor = imagery + groundAtmoColor × transmittance
(if HDR off) draped = 1 - exp(-2 × finalAtmosphereColor)
(else)       draped = finalAtmosphereColor
color = mix(imagery, draped, tile.groundAtmosphereControl.y)   // y = fadeAmount
```

The `fadeAmount` is a CPU-computed ramp from 0 at the fog threshold up to 1 at `lightingFadeInDistance` (~20 Mm). At orbit it is 1.0 — imagery is **fully replaced** by the drape — so anything wrong with `groundAtmoColor` directly overwrites the visible globe.

**WebGL** picks between per-vertex and per-fragment computation of `groundAtmoColor` via `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE`. The define is set CPU-side when `cameraDist > nightFadeOutDistance` (≈ π/2 × Rmin ≈ 10 Mm). At close cameras, the per-vertex varyings (`v_atmosphereRayleighColor`, `v_atmosphereMieColor`) are read directly. At orbit, the fragment shader calls `computeAtmosphereScattering(positionWC, lightDir, …)` per fragment for numerical consistency across the limb.

**WebGPU** previously ONLY used the per-vertex varyings. At orbit, neighboring vertices traverse vastly different lengths of atmosphere (front-side vertex: ~110m, far-side limb vertex: ~13Mm) and linear interpolation across triangles spanning the limb produced visible mesh-pattern artifacts in `groundAtmoColor`. Since `fadeAmount=1.0` at orbit, the mesh-pattern overwrote imagery entirely — the WGS84 catastrophe.

**Batch 56 fix:** WGSL now calls `computeAtmosphereScatteringGround(positionWC, lightDir)` per-fragment inside the ground-atmosphere drape branch (matching WebGL's `PER_FRAGMENT_GROUND_ATMOSPHERE` path). The per-vertex VS computation is still wired (currently dead at orbit, kept for the close-camera optimization that re-introduces the distance gate).

The drape branch ALSO runs a separate fog path (`fogDensity > 0.0`) at lower altitudes; that path uses a different formula (`czm_fog(distance, color, fogColor)`) and produces an HDR-tonemapped result that mixes by distance instead of `fadeAmount`. Per-fragment vs per-vertex distinction does NOT apply there because at fog altitudes the per-vertex variation is small.

---

## Imagery alpha-mask V-space — canonical coordinate-space model (CRITICAL)

> **Verified 2026-06-21** against the WebGL reference, the shared CPU packer (read directly), and an empirical 4-altitude × 3-provider Playwright sweep. This section is the authoritative spec for the `texCoordsRect` alpha-mask **test** coordinate. The `applyImageryLayer` docstring in `GlobeTerrain.wgsl` once asserted the test was *always* geographic; it now states the law below — the test V is the per-layer selected V — and matches the code. (Re-verified 2026-08-08 at C16-05, which rewrote that docstring; the line range the earlier note cited no longer applies, so the citation is by symbol.)

### The one law (from WebGL)

WebGL's `sampleAndBlend` takes a **single** coordinate, `tileTextureCoordinates`, and uses it for **both** the `textureCoordinateRectangle` `step()` alpha-mask test (`GlobeFS.glsl:250,253`) **and** the texture sample (`GlobeFS.glsl:262`). The geographic-V-vs-Mercator-V choice is made **once**, at the call site (`GlobeSurfaceShaderSet.js:352` — `useWebMercatorT[i] ? textureCoordinates.xz : textureCoordinates.xy`). **The alpha-mask test V and the sample V are always the same per-layer V.** WGSL must honor this.

`webMercatorT` (the `.z` of the tex-coord varying) is a **precomputed per-vertex attribute** (CPU-side, during terrain mesh encoding), interpolated to the fragment — *not* a Mercator formula evaluated in the shader. When a mesh lacks Mercator-Y it falls back to the geographic V. WGSL sources it the same way (`processVertex` ≡ `GlobeVS.glsl:265`), plus a polar-NaN guard (`sanitizeWebMercatorT`) with no WebGL counterpart (benign — replaces a ±90° NaN with geoV).

### What space is `texCoordsRect` packed in?

**Mercator-V for `useWebMercatorT=true`; geographic-V for `false`.** `createTileImagerySkeletons` converts `terrainRectangle`, `imageryRectangle`, and `clippedImageryRectangle` to **native (Mercator) coordinates in-place** when `useWebMercatorT` ([ImageryLayerHelpers.js:229-247](../packages/engine/Source/Scene/ImageryLayerHelpers.js#L229-L247)), *then* computes `minV/maxV = (clipped.south − terrain.south) / terrain.height` ([:277-281,343-347](../packages/engine/Source/Scene/ImageryLayerHelpers.js#L343-L347)) from those Mercator-Y values over the Mercator terrain height. Because Mercator-Y is **nonlinear**, the ratio does **not** cancel back to a geographic fraction — the rect is a genuine **Mercator fraction**. (A 2026-06-21 review briefly claimed the conversion "cancels in the ratio → geographic"; that is mathematically false and was rejected after reading the in-place native mutation directly.) The rect is the **identical cached `Cartesian4`** consumed by both backends (`WebGPUGlobeSurfaceTileUB.ts:191`); the backends cannot disagree on its value. Only `cutoutRectangle` is **always geographic** (packed `÷ tile.rectangle.height`).

### Coordinate-space table

| Coord / rect | Layer type | LOD | Space | WebGL uses | WGSL uses | Match |
| --- | --- | --- | --- | --- | --- | --- |
| per-vertex geoUV (`.xy`) | both | all | geographic [0,1] | `v_texCoords.xy` | `v_texCoords.xy` | ✅ |
| per-vertex Mercator-V (`webMercatorT`, `.z`) | Web-Mercator | all | Mercator-Y [0,1] (precomputed attr; geoV fallback) | `v_texCoords.z` | `v_texCoords.z` (+NaN guard) | ✅ |
| **texCoordsRect test** | **Web-Mercator** | **deep/interior** | **Mercator-V** | **Mercator-V (= sample)** | **`geoUV` — WRONG** | ❌ |
| texCoordsRect test | Web-Mercator | low/base (fixup) | rect forced `(0,0,1,1)`; moot | Mercator-V | geoUV | ✅ (trivial) |
| texCoordsRect test | geographic | all | geographic | geoUV | geoUV | ✅ |
| texture sample | both | all | matches bound texture | `tileTexCoords` | `selectLayerUV` | ✅ |
| cutoutRectangle test | both | all | geographic | geoUV | geoUV | ✅ |
| textureTranslationAndScale | Web-Mercator | all | Mercator-V | Mercator-space | cached ts | ✅ |

### LOD / altitude behavior — the bug is latitude-gated, NOT LOD/altitude-gated

`useWebMercatorT` is a function of the tile's **latitude range, not LOD**. Two LOD bands matter for the alpha mask:

- **Low LOD / base layer:** the south/north/east/west fixup (next section) forces the rect to `(0,0,1,1)` full coverage. V-space is **moot** — any V passes. (Why the current geoUV bug is invisible at base LOD and at orbit.)
- **Deep LOD / non-base interior sub-tiles:** the rect carries genuine interior Mercator fractions (`texCoordsRect.y>0` or `.w<1`). V-space **matters** — a geographic-vs-Mercator test mismatch clips/leaks an alpha-mask edge. The discrepancy is **zero at the equator and grows poleward**.

An empirical 4-altitude sweep (far-orbit / near-orbit / in-atmosphere / near-ground; ArcGIS + OSM + NaturalEarthII control; mid-latitude coastal view; PNG-confirmed) found the imagery **sample** is pixel-perfect WebGPU-vs-WebGL (0px cross-correlation, ~0.8% masked diff) at near/mid/deep LOD on both Mercator providers; the geographic control stays clean at all altitudes.

> **STALE CLAIM CORRECTED (2026-07-02, GLOBE-POLAR-STRETCH):** this section previously concluded "the only WebGPU-vs-WebGL divergence at far-orbit is the globe-disc-framing + atmosphere-halo gap, not imagery projection." That was wrong. A quantified far-zoom repro (disc-normalized latitude-band profiling at lon −95 / lat 40 / h 25 Mm) showed the disc RIMS matched between backends while the imagery INSIDE was non-rigidly latitude-remapped (ice centroid 17.5 px equatorward, ice area +28%, 32.15% pixel mismatch). The cause was a genuine imagery-projection bug: the `ReprojectWebMercator.wgsl` double vertical flip warped every reprojected texture built from a non-equator-symmetric imagery tile (see the reprojection-compare section). The earlier sweep missed it because its mid-latitude coastal views sample the direct-Mercator (`useWebMercatorT=true`) path, and its far-orbit check only measured disc width — a rigid metric blind to the interior remap. Fixed 2026-07-02; `probe-globe-polar-stretch.mjs` now gates all three zoom bands with band-alignment metrics. The residual imagery-adjacent defect at far zoom is the WebGPU-only faint tile-seam lines (separate issue).

The residual imagery defect the sweep did identify is the latitude-gated alpha-mask **test** coordinate above, which the equator-targeted probes do not exercise.

### Session-65 Batch-8 reconciliation (why geographic-V was once correct)

Batch 8 switched the bounds test from Mercator-V to geographic-V to fix "dark blue at close zoom." That was correct **only under the then-current single-texture model**: Mercator imagery was reprojected into one geographic output texture, but the per-layer `useWebMercatorT` flag was still TRUE, so `selectLayerUV` fed a **Mercator-V** to the test while the bound texture (and its rect) were **geographic** → `step()` failed for the bulk of fragments → `effectiveAlpha=0` → imagery-base fallback `vec3(0.04,0.04,0.06)` = the dark blue. It was a coordinate-**space mismatch**, not a numerically-wrong Mercator-V. Batch 65's **dual-texture** model superseded that: each Mercator layer now carries both a Mercator and a reprojected texture, and the cached rect/translationAndScale track the **bound** texture's space. So the correct fix today is **not** a global flip back to Mercator-V (that re-breaks the now-common geographic/reprojected polar tiles into dark-blue) but a **per-layer projection-matched** test V — exactly `selectLayerUV`'s output — for the `texCoordsRect` test, while keeping `geoUV` for `cutoutRectangle`.

### The fix (LANDED — Batch 349, 2026-06-21)

In `applyImageryLayer` (`GlobeTerrain.wgsl`) add a rect-test UV parameter = the per-layer selected `uv`; test `texCoordsAlpha(selectedUV, layer.texCoordsRect)` while keeping `applyCutoutMask(geoUV, layer.cutoutRectangle)`. Thread the already-computed `uv` (from `selectLayerUV`, in scope at every call site) through all 16 unrolled slots. For `useWebMercatorT=false` layers `selectLayerUV` returns `geoUV`, so behavior is byte-identical to today — **dark-blue cannot return** (the polar dark-blue victims are all `useWMT=false`). Adversarially reviewed dark-blue-safe.

**Verification (Batch 349, workflow `wlxypmndy`):** all 4 gates passed — G1 mid/high-lat deep-LOD parity (0.36%, mask edges aligned, dark-blue = 0), G2 orbit dark-blue non-regression (the apparent dark-blue was real ocean imagery on **both** backends; true fallback = 0), G3 polar sanitize, G4 equator non-regression (~0.8%, unchanged). No dark-blue, no mask-edge seam, no regression.

**Honest empirical caveat — negligible visible impact.** A pre/post at the G1 deep-LOD view (Finland, lat 65) was a near-no-op (0.358% pre vs 0.361% post; 31 px / 0.003% changed, at the noise/UI-chrome floor). At deep LOD the within-tile Mercator-V vs geographic-V divergence is locally linear (sub-pixel), and a single base layer's rect is forced to `(0,0,1,1)` by the south/north fixup, so the V-space is moot there. The bug's measurable footprint is thin sub-rect mask edges at **mid-LOD high latitude** only. The fix is correct by construction (matches WebGL's one-V rule + this model) and safe, but it is a code-correctness alignment, **not** a visible-stretch fix — the visible base-globe "stretch" is the separate atmosphere/sky disc-framing gap.

**Edge-case caveats (probe before claiming fixed):**

- **Batch-304 fall-through:** WebGPU derives `effectiveUseWebMercatorT` from which texture variant actually bound (`WebGPUGlobeSurfaceTileUB.ts:163-173`), which can diverge from WebGL's `u_dayTextureUseWebMercatorT[i]` in the Mercator→geographic cache fall-through. The fix is still safe because WebGPU's selected-V and its rect are **co-derived in the same bound-texture space** (internal consistency) — parity is "matches WebGL's intent," not "byte-identical flag."
- **Polar NaN:** `sanitizeWebMercatorT` can shift a ±90° bounds edge vs WebGL's raw-NaN `step()`. Add a polar-tile probe.

**Required new probe gates** (no equator-targeted pass-1 probe exercises the latitude-gated case):

1. **Mid/high-latitude (~lat 60) deep-LOD sub-rect** view with a non-base Web-Mercator overlay (`texCoordsRect.y>0`): alpha-mask edges must match WebGL, no clipped/leaked imagery stripe.
2. **Mid/high-latitude low-LOD/orbit** Web-Mercator view where polar-adjacent tiles take the geographic path: assert **no dark-blue fallback** pixels (`vec3(0.04,0.04,0.06)`).
3. **Polar-tile** view (lat ≈ ±90): `sanitizeWebMercatorT` must not shift the bounds edge vs WebGL.
4. Keep the geographic NaturalEarthII control clean at all bands.

---

## Base-layer south/north fixup (the polar black-hole gotcha)

`createTileImagerySkeletons` in [ImageryLayerHelpers.js](../packages/engine/Source/Scene/ImageryLayerHelpers.js) applies a base-layer-only **edge fixup** when constructing the cached `textureCoordinateRectangle` for a tile's imagery skeleton:

- Lines 263-272: when the imagery tile is the WESTERNMOST and the layer is the base layer, `maxU` clamps to `0.0` so the southwest gap is closed by clamp-to-edge.
- Lines 316-322: same idea at the EAST edge — `maxU = 1.0`.
- Lines 274-284, 351-358: same at NORTH and SOUTH edges. **For southernmost imagery of a base layer, `minV = 0.0` is forced** — this is what extends Mercator's ±85° coverage down to the polar tile's -90° south edge by sampler clamp-to-edge.

Consequence: a polar tile's cached `textureCoordinateRectangle.y` (`minV`) is **0.0**, not the geographically-correct `(iR.south - tR.south) / tR.height ≈ 0.96`. The sampler then reads the bottommost imagery row across the polar gap, producing visually-clean (if slightly stretched) Antarctic/Arctic imagery.

`textureTranslationAndScale` is computed unchanged in geographic space when `useWebMercatorT === false` (i.e., for polar tiles), so the cached values together are correct for the polar case.

**WebGPU consequence (pre-Batch-65):** the inline geographic recalc in [WebGPUGlobeSurfaceTileUB.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts) introduced by Batch 49 had to be gated on `useWebMercatorT === true` so it wouldn't clobber the south-edge fixup. Batch 62 added that gate.

**WebGPU consequence (Batch 65 onward):** the inline recalc was removed entirely along with the move to dual textures. Polar tiles (`useWebMercatorT === false`) bind `_webgpuReprojectedTexture` and use the geographic-space cached rect with the base-layer south-edge fixup intact — exactly what WebGL does for the same tiles when it binds `imagery.texture`.

---

## SceneMode-Specific Behavior

The above is the SCENE3D path. In SCENE2D and COLUMBUS_VIEW, additional considerations:

- The planar vertex shader uses `tileRectangle` (CPU-projected meters, shifted relative to per-tile rtc) instead of the radians-based tile bounds. See `WebGPUGlobeSurfaceCameraUB.ts` (Batch 50).
- The imagery sampling itself is unchanged — `useWebMercatorT`, `textureTranslationAndScale`, `textureCoordinateRectangle` work identically because they describe imagery-texture access, not vertex geometry.
- MORPHING blends between SCENE3D and SCENE2D positions; imagery sampling stays consistent across the blend.

---

## Per-Renderer Reprojection Compare

| Aspect | WebGL | WebGPU |
| --- | --- | --- |
| **Trigger** | `_reprojectTexture()` in `ImageryLayer.js` queues a `ComputeCommand` (only when geographic projection is needed); raw Mercator texture is uploaded separately on imagery load | Same call site, takes the FR branch and runs `fr.uploadAndReproject` synchronously for ANY Mercator provider (Batch 65) |
| **Geometry** | 4-vertex quad (Batch 66 — previously a 64-row vertex grid with precomputed per-vertex `webMercatorT`) | Full-screen triangle |
| **Mercator math** | Per-fragment exact `0.5 * log((1+sin(lat))/(1-sin(lat)))` (Batch 66 — previously precomputed per-row in JS, then linearly interpolated by the rasterizer) | Per-fragment exact in WGSL |
| **Output texture format** | RGBA8 (same as source) | `rgba8unorm` (`getOutputFormat()`) |
| **Output orientation** | V=0 corresponds to imagery south (UNPACK_FLIP_Y=true at upload) | V=0 corresponds to imagery south too (**corrected 2026-07-02, GLOBE-POLAR-STRETCH**: the pre-flipped ImageBitmap's flip IS baked into the pixels `copyExternalImageToTexture` consumes, so the WGSL FS is now line-for-line identical to the GLSL FS — `v_geo = texCoord.y`, `srcV = mercatorFraction`. The previous `1.0 - y` double flip only cancelled for equator-symmetric imagery tiles and latitude-mirror-warped all others = the far-zoom polar stretch) |
| **Stored on imagery** | `imagery.textureWebMercator` (Mercator source) + `imagery.texture` (geographic reprojection) | `imagery._webgpuMercatorTexture` (Mercator source) + `imagery._webgpuReprojectedTexture` (geographic reprojection) — Batch 65 dual-texture parity |
| **Subsequent sampling** | Shader binds `imagery.textureWebMercator` or `imagery.texture` per tile based on `useWebMercatorT` | `getOrCreateImageryTexture` picks `_webgpuMercatorTexture` (cache key `${k}_merc`) or `_webgpuReprojectedTexture` (cache key `${k}`) per tile based on `useWebMercatorT` |

### Batch 66 — WebGL reproject FS rewritten to per-fragment math

The WebGL reproject had been a 64-row vertex grid for ~10 years: each row carried a precomputed `webMercatorT` attribute (the Mercator-Y fraction at that row's latitude) and the rasterizer linearly interpolated between consecutive rows to give a per-fragment `webMercatorT` for source sampling. Batch 66 replaces this with a 4-vertex quad whose FS computes the exact `0.5 * log((1+sin(lat))/(1-sin(lat)))` per fragment, mirroring `Shaders/WebGPU/ReprojectWebMercator.wgsl`.

Motivation: chasing the WebGL-vs-WebGPU polar pixel mismatch (14-38% at orbit views), Batch 65's reprojected-texture-compare probe suggested the 64-row piecewise approximation might be the source. The hypothesis turned out to be wrong — the piecewise error at high latitudes is ~0.017 pixels of source-V sampling, sub-pixel, can't explain the observed 200+ RGB delta. The fix landed anyway because it's a strict improvement on its own merits:

- Math is the exact closed-form, not an approximation.
- Drops 64 `sin` + 64 `log` per-tile CPU computations + the `copyFromArrayView` stream-draw write that pushed them to the GPU.
- Drops the per-row vertex attribute, the 128-float scratch buffer, the `TerrainProvider.getRegularGridIndices(2, 64)` index helper, and an unused `FeatureDetection` import.
- 4 vertices instead of 128 in the VS work per imagery tile reproject.
- Adds 4 scalar uniforms and a per-fragment sin/log; runs once per imagery tile when it first reaches `READY`. Negligible cost.

The polar pixel residual remained after Batch 66 — and the Batch-66/67 investigation got tantalizingly close to the real cause before ledgering the wrong conclusion. The Batch-66 working hypothesis — **source-texture upload conventions** — was the right neighborhood: Batch 67 correctly noted that "the two upload paths both land `v=0 = south`" but then ALSO ledgered the contradictory "flipY is metadata-only → WebGPU source v=0 = NORTH" theory to justify keeping the WGSL FS's `srcV = 1.0 - mercatorFraction` + `v_geo = 1.0 - texCoord.y` double flip. Those two flips cancel exactly for imagery tiles symmetric about the equator (which the compare probe used), so the reprojected-texture compare looked clean; for asymmetric tiles they produce a latitude-mirrored warp. **The Batch-64 "cross-vendor drift, not a fixable bug" verdict was therefore wrong** — the drift was mostly this warp. **Corrected 2026-07-02 (GLOBE-POLAR-STRETCH):** both flips removed; the WGSL FS is line-for-line identical to the GLSL FS; `probe-polar-multi-plain` dropped from 12-46% to 2.4-6.4% at polar/orbit views. Gate against the new numbers (see the corrected residual note above).

Files modified in Batch 66:

- `packages/engine/Source/Shaders/ReprojectWebMercatorFS.glsl` — replaced lookup-only FS with per-fragment Mercator-Y math + 4 new scalar uniforms.
- `packages/engine/Source/Shaders/ReprojectWebMercatorVS.glsl` — dropped `webMercatorT` attribute; passes `position.xy` through as `v_textureCoordinates`.
- `packages/engine/Source/Scene/ImageryLayerHelpers.js` — replaced 64-row grid + per-tile `webMercatorT` loop with a 4-vertex quad and 4 uniformMap entries (`u_southLatitude`, `u_northLatitude`, `u_southMercatorY`, `u_oneOverMercatorHeight`); dropped `FeatureDetection` and `TerrainProvider` imports + the `float32ArrayScratch` 128-float buffer.

---

## Probe Coverage

| Probe | Location | Covers |
| --- | --- | --- |
| `probe-saved-view.mjs` | `Tools/visual-regression/` | URL-loaded saved view with WebGL/WebGPU pixel diff + channel decomposition |
| `probe-wgs84.mjs` | `Tools/visual-regression/` | WGS84 Ellipsoid + default imagery at orbit and 1Mm-close altitudes |
| `probe-2d-cv-modes.mjs` | `Tools/visual-regression/` | SCENE3D, COLUMBUS_VIEW, SCENE2D with morphTo*(0) |
| `probe-mode-roundtrip.mjs` | `Tools/visual-regression/` | 3D→CV→3D, 3D→2D→3D round-trips for split-globe artifacts |
| `probe-projection-fix.mjs` | `Tools/visual-regression/` | Eight orbital views (northam, arctic, equator, asia, southern, europe-mid, tile-edge-test, dusk-pacific) for Batch 46/49 verification |
| `probe-globe-polar-stretch.mjs` | `Tools/visual-regression/` | GLOBE-POLAR-STRETCH acceptance gate: mid (2 Mm) / far (25 Mm) / extreme (55 Mm) zoom, WebGL-vs-WebGPU disc-normalized latitude-band alignment (ice centroid, land-profile shift, ice area ratio) + mismatch ceilings. Guards the ReprojectWebMercator.wgsl orientation fix |
| `probe-reproject-baseline.mjs` | `Tools/visual-regression/` | NEW-WEBGL-REPROJECT-BASELINE golden-baseline guard: pins the **WebGL** reprojected-texture pixel output (deterministic polar tile 1/1/2 at lat 80°) to a stored PNG (`baseline/reproject-webgl.png`) with a channel-tolerance diff. Unlike the cross-backend probes above, this catches drift where BOTH backends' reproject math regress together (e.g. an accidental edit to the Batch-66-forked `ReprojectWebMercatorFS/VS.glsl` + `ImageLayerHelpers.js` quad uniforms). `--update` re-baselines |

---

## Maintenance Rules

1. **Touch this doc whenever you modify any file in the projection chain** (the seven enumerated at the top). A drift between this doc and code is a worse bug than the projection bug itself, because the next person debugging will start from this doc.
2. **When a per-renderer behavior diverges intentionally, document the WHY** (browser-API constraint, performance, missing feature). Tag with the relevant Bug number from `WEBGPU_DEBUGGING_LOG.md`.
3. **Update the "What's been ruled out" / "What's still suspected" sections** of any active investigation block. A "ruled out" entry that turns out to be wrong becomes the next-session blocker.
4. **Cross-reference probe paths.** If you add a new failure mode, add the probe that reproduces it to the table above.
