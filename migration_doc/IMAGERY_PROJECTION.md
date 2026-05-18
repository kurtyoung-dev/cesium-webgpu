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

**WebGPU** (`WebGPUImageryReprojection.ts` + `WebGPUGlobeSurfaceTextures.ts` + `WebGPUGlobeSurfaceTileUB.ts`):

- When the imagery FIRST becomes ready and a Mercator→Geographic reprojection is needed, `WebGPUImageryReprojection.reprojectImageSourceWebGPU` runs synchronously (full-screen-triangle render pass). The output `GPUTexture` is stashed on `imagery._webgpuReprojectedTexture`.
- Texture binding (`getOrCreateImageryTexture:79`): prefers `_webgpuReprojectedTexture` over the source-image upload path. The reprojected texture is geographic-projected and matches what the shader expects when sampling at geographic V.
- `useWebMercatorTLayer[i] = 0` so the fragment uses geographic V.
- `tileImagery.textureTranslationAndScale` cached value would be in MERCATOR-Y space (because `_calculateTextureTranslationAndScale` is invoked with `useWebMercatorT` whose definition isn't aware of the WebGPU reprojection). **Batch 46** detects `_webgpuReprojectedTexture` and recomputes translation/scale in GEOGRAPHIC space at UB-pack time, overriding the cached Mercator-space value.
- `tileImagery.textureCoordinateRectangle` cached value similarly Mercator-Y. **Batch 49** detects `_webgpuReprojectedTexture` and recomputes the rect in GEOGRAPHIC tile-UV at UB-pack time.

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

**Remaining issue (Batch 61):** WebGPU shows a solid-black circular hole at the south pole when looking straight down at it (~within ±2° of -90° latitude). WebGL renders imagery + tile labels normally in the same area. Looks like a tile-culling or degenerate-mesh issue specific to the very polar tiles. Tracked separately.

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
texCoordsMask = step(rect.xz, boundsUV.xy) × step(boundsUV.xy, rect.yw)  // alpha mask
dayNightVal = mix(nightAlpha, dayAlpha, dayFade)
effectiveAlpha = layerMask × layer.alpha × sampleAlpha × texCoordsMask × dayNightVal × splitMask × cutoutMask
color = mix(prevColor, adjusted, effectiveAlpha)
alpha = max(prevAlpha, effectiveAlpha)
```

**WebGL** runs this once per layer slot (`czm_globe_translucency_main`, looping over `TEXTURE_UNITS` constant). The number of layer slots is whatever the pipeline cache decided to compile for this tile.

**WebGPU** unrolls 16 layer slots in `fragmentMain` (`GlobeTerrain.wgsl` ~lines 2308-2479) because WGSL cannot dynamically index a texture binding. The `count = u32(tile.layerCount)` gate skips inactive slots; the cost of the unused branches is one comparison plus a structurally-zero mask in the helper. **Adding a 17th layer slot requires updating both the bind-group layout and unrolling another `if (count >= 17u)` block.**

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

## SceneMode-Specific Behavior

The above is the SCENE3D path. In SCENE2D and COLUMBUS_VIEW, additional considerations:

- The planar vertex shader uses `tileRectangle` (CPU-projected meters, shifted relative to per-tile rtc) instead of the radians-based tile bounds. See `WebGPUGlobeSurfaceCameraUB.ts` (Batch 50).
- The imagery sampling itself is unchanged — `useWebMercatorT`, `textureTranslationAndScale`, `textureCoordinateRectangle` work identically because they describe imagery-texture access, not vertex geometry.
- MORPHING blends between SCENE3D and SCENE2D positions; imagery sampling stays consistent across the blend.

---

## Per-Renderer Reprojection Compare

| Aspect | WebGL | WebGPU |
| --- | --- | --- |
| **Trigger** | `_reprojectTexture()` in `ImageryLayer.js` queues a `ComputeCommand` | Same call site, but takes the FR branch (Bug 11.1 early-return) and runs `WebGPUImageryReprojection.reprojectImageSourceWebGPU` synchronously |
| **Geometry** | 64-row vertex grid with precomputed per-vertex `webMercatorT` | Full-screen triangle, Mercator math done per-fragment in WGSL |
| **Output texture format** | RGBA8 (same as source) | `rgba8unorm` (`getOutputFormat()`) |
| **Output orientation** | V=0 corresponds to imagery south (WebGL convention with UNPACK_FLIP_Y=true at upload) | V=0 corresponds to imagery north (`geographicFraction = 1.0 - texCoord.y`) — see Batch 55 V-orientation investigation note |
| **Stored on imagery** | `imagery.texture` (replaces unreprojected) | `imagery._webgpuReprojectedTexture` (separate field; original `imagery.texture` may also be set for compat) |
| **Subsequent sampling** | Shader binds `imagery.texture`, samples at geographic V | Globe surface texture-cache binds `_webgpuReprojectedTexture` preferentially; falls through to source upload otherwise |

The output orientation difference is suspicious and worth deeper investigation — WebGL's per-vertex grid implicitly defines a single canonical orientation, while the WebGPU full-screen-triangle approach defines orientation via the `geographicFraction` calculation in the FS. A mismatch between this orientation and the downstream sampling convention could explain the WGS84 catastrophe.

---

## Probe Coverage

| Probe | Location | Covers |
| --- | --- | --- |
| `probe-saved-view.mjs` | `Tools/visual-regression/` | URL-loaded saved view with WebGL/WebGPU pixel diff + channel decomposition |
| `probe-wgs84.mjs` | `Tools/visual-regression/` | WGS84 Ellipsoid + default imagery at orbit and 1Mm-close altitudes |
| `probe-2d-cv-modes.mjs` | `Tools/visual-regression/` | SCENE3D, COLUMBUS_VIEW, SCENE2D with morphTo*(0) |
| `probe-mode-roundtrip.mjs` | `Tools/visual-regression/` | 3D→CV→3D, 3D→2D→3D round-trips for split-globe artifacts |
| `probe-projection-fix.mjs` | `Tools/visual-regression/` | Eight orbital views (northam, arctic, equator, asia, southern, europe-mid, tile-edge-test, dusk-pacific) for Batch 46/49 verification |

---

## Maintenance Rules

1. **Touch this doc whenever you modify any file in the projection chain** (the seven enumerated at the top). A drift between this doc and code is a worse bug than the projection bug itself, because the next person debugging will start from this doc.
2. **When a per-renderer behavior diverges intentionally, document the WHY** (browser-API constraint, performance, missing feature). Tag with the relevant Bug number from `WEBGPU_DEBUGGING_LOG.md`.
3. **Update the "What's been ruled out" / "What's still suspected" sections** of any active investigation block. A "ruled out" entry that turns out to be wrong becomes the next-session blocker.
4. **Cross-reference probe paths.** If you add a new failure mode, add the probe that reproduces it to the table above.
