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

**This path is currently broken on WebGPU.** Verified at orbit altitude with WGS84 Ellipsoid + default Bing aerial — globe renders as black wedges with thin imagery slivers at the poles. The mid-latitude region of each level-0/1 tile is catastrophically wrong despite all three projection inputs (`useWebMercatorTLayer`, `translationAndScale`, `textureCoordinateRectangle`) being mathematically correct for geographic-V sampling. Tracked as the next concrete WGS84 work item.

**What's been ruled out (Batch 55 diagnostics):**

- Pipeline selection — `vertexMainWebMerc` correctly selected for stride=7 / hasVertexNormals=false / hasWebMercatorT=true.
- Vertex format alignment — `float32x3` location 1 padded to `vec4<f32>` in shader, `tc.xy` and `tc.z` map to correct fields.
- Depth-z planetary-scale clamping (BUG-39a) — `min(out.position.z, out.position.w)` is in place, `depthCompare: less-equal` enabled.
- Imagery reprojection early-return (Bug 11.1) — `return` after FR path is in place.
- Batch 46 translationAndScale recompute — disabling it does NOT change WGS84 rendering.
- Batch 49 textureCoordinateRectangle recompute — disabling it does NOT change WGS84 rendering.
- WebGPU source-image upload Y orientation — adding `flipY: true` to `copyExternalImageToTexture` does invert the close-zoom (useMercT=true) imagery upside-down but does NOT change the orbit-WGS84 catastrophe.
- Reprojection shader V-flip — neither `geographicFraction = in.texCoord.y` nor `1.0 - in.texCoord.y` fixes the orbit case.

**What's still suspected:**

- Reprojected texture content vs expected — never actually inspected via texture readback; the texture may be empty, mostly transparent, or have content at unexpected coordinates.
- `tileImagery.readyImagery` may be the PARENT imagery (when the current tile's imagery never reaches READY state on WebGPU), and the parent's `_webgpuReprojectedTexture` may not cover the geographic-radians-rectangle math we're applying.

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
