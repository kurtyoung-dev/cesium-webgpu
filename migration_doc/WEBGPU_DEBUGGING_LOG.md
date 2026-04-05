# CesiumJS WebGPU Renderer — Debugging Log

**Created:** April 3, 2026  
**Purpose:** Track all bugs found and fixed while pushing the WebGPU renderer to full functionality.

---

## Table of Contents

1. [Current Status](#current-status)
2. [Session 1: Initial Launch Errors](#session-1-initial-launch-errors)
3. [Session 2: Globe Terrain Rendering Errors](#session-2-globe-terrain-rendering-errors)
4. [Session 3: Index Validation & Pipeline Stride](#session-3-index-validation--pipeline-stride)
5. [Session 4: Black Screen → Blue Globe](#session-4-black-screen--blue-globe)
6. [Session 5: Feature Renderer Destroy & Buffer Errors](#session-5-feature-renderer-destroy--buffer-errors)
7. [Session 6: Diagnostic Page — Pipeline Compilation Failures](#session-6-diagnostic-page--pipeline-compilation-failures)
8. [Session 7: Build System Fixes](#session-7-build-system-fixes)
9. [Active Issues: Stars & Terrain Not Rendering](#active-issues-stars--terrain-not-rendering)
10. [Session 14: WebMercatorT Shader Support & UV Stretching Fix](#session-14-webmercatort-shader-support--uv-stretching-fix)
11. [Session 15: LOD Unlock & TexCoordsRect Alpha Masking](#session-15-lod-unlock--texcoordsrect-alpha-masking)
12. [Files Modified Summary](#files-modified-summary)

---

## Current Status

**What works:** Globe renders with satellite imagery at multiple LODs in the WebGPU viewer. WebMercatorT texture coordinate support matches WebGL. Higher LOD tiles load and render as camera zooms in. Environment injection wired. CubeMapPanorama pipeline fixed. Imagery reprojection crash fixed. Build system now compiles WGSL shaders + TypeScript.  
**What's being investigated:**

- ⚠️ Black tears/seams between some tiles (fill tile index buffer stride mismatches)
- ⚠️ Star map / space imagery (CubeMapPanorama depth-stencil fixed — needs visual verification)
- ⚠️ 2D mode still renders as sphere
- ⚠️ Camera jittering at close zoom

---

## Session 1: Initial Launch Errors

### Bug 1.1: Buffer Size NaN Errors
- **Files:** `WebGPUBuffer.ts`, `WebGPUEnvironmentRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`
- **Root cause:** `createVertexBuffer` and `createIndexBuffer` expected `(device, data, label)` but callers passed `(device, byteLength, flag, label)` — an old API pattern. The number `byteLength` was treated as data, and `number.byteLength` is `undefined` → NaN buffer size.
- **Fix:** Changed `WebGPUEnvironmentRenderer.js` (Sun quad + Moon sphere vertex buffers) and `WebGPUSkyAtmosphereRenderer.js` (atmosphere vertex + index buffers) to pass the actual typed array data instead of `.byteLength`. Also fixed `createUniformBuffer` in `WebGPUBuffer.ts` to detect when a string label is passed as the `data` parameter (9+ callers had this pattern), treating the string as the label automatically.

### Bug 1.2: `passEncoder.setPipeline is not a function`
- **Files:** `SceneRenderer.js`, `WebGPUSceneRenderer.ts`
- **Root cause:** `renderEnvironment()` executed WebGPU draw commands via `command.execute(context, passState)` — but no WebGPU render pass was active yet (it runs before the WebGPU scene renderer starts). The `context` object was passed where a `GPURenderPassEncoder` was expected.
- **Fix:** Skipped `renderEnvironment()` when the WebGPU alternate scene renderer is active. Added `Pass.ENVIRONMENT` execution to `WebGPUSceneRenderer.ts`'s multi-frustum loop (in the farthest frustum, before the GLOBE pass) so environment commands are properly executed within an active render pass.

### Bug 1.3: Splitscreen Camera Sync
- **File:** `CesiumViewer.js`
- **Fix:** Added bidirectional camera synchronization between WebGL and WebGPU viewers using `camera.changed` events with loop prevention. Wired `syncCameras()` into both the `switchRenderer('split')` and the `main()` initial-load split paths.

### Files Modified (Session 1)
1. `packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts`
2. `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js`
3. `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`
4. `packages/engine/Source/Scene/SceneRenderer.js`
5. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`
6. `Apps/CesiumViewer/CesiumViewer.js`

---

## Session 2: Globe Terrain Rendering Errors

### Bug 2.1: Bind Group Limit Exceeded (5 → 4 groups)
- **Files:** `GlobeTerrain.wgsl`, `GlobeTerrain.js`, `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** WebGPU has a default maximum of 4 bind groups. The globe terrain shader used 5 bind groups (uniforms, imagery, water mask, ocean normal, effects).
- **Fix:** Merged water mask (old group 2) and ocean normal map (old group 3) into a single bind group 2 with 4 entries. Effects group moved from group 4 to group 3. Updated shader @group annotations, renderer bind group layouts, pipeline layout, bind group creation, wireframe commands, and cleanup.

### Bug 2.2: writeBuffer 4-Byte Alignment
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** WebGPU's `writeBuffer` requires 4-byte aligned data. `Uint16Array` index buffers could have non-4-byte-aligned byte lengths.
- **Fix:** Added padding logic in `_getOrCreateTileBuffers` — when `Uint16Array` index buffers have non-4-byte-aligned byte length, the buffer size is rounded up to the next 4-byte boundary and data is zero-padded before writing.

### Bug 2.3: GlobeTerrain.wgsl 404
- **File:** `GlobeSurfaceTileProviderRendering.js`
- **Root cause:** `fetch()`-based shader loading tried multiple relative paths via XHR — all failing with 404 errors.
- **Fix:** Replaced with a direct ES module `import` of the pre-bundled `GlobeTerrain.js` shader string.

### Bug 2.4: Buffer Too Small in WebGLStubBuffer
- **File:** `WebGLStubBuffer.ts`
- **Root cause:** The `bufferData` stub created a default 4096-byte buffer. When incoming data exceeded this, `writeBuffer` failed.
- **Fix:** Added buffer regrow logic — when incoming data exceeds the buffer's current size, the old buffer is destroyed and a new properly-sized buffer is created.

### Bug 2.5: "size is zero" Error
- **Root cause:** Addressed implicitly by buffer alignment fixes (buffer sizes are now always at least 4 bytes and properly aligned).

### Files Modified (Session 2)
1. `packages/engine/Source/Shaders/WebGPU/GlobeTerrain.wgsl`
2. `packages/engine/Source/Shaders/WebGPU/GlobeTerrain.js`
3. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
4. `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js`
5. `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubBuffer.ts`

---

## Session 3: Index Validation & Pipeline Stride

### Bug 3.1: "Index extends beyond limit" — Pipeline Stride Mismatch
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** The terrain pipeline's `arrayStride` was hardcoded (24/28 bytes for uncompressed, 12/16 for quantized), but CesiumJS terrain encoding can have variable strides (e.g., 32 bytes when webMercator texcoords are included alongside normals). When the pipeline's stride was smaller than the actual data stride, WebGPU calculated fewer vertices than actually existed.
- **Fix:**
  - Changed `_pipelines` from a fixed 8-element array to a `Map<string, GPURenderPipeline>` (`_pipelineCache`) for dynamic stride-keyed caching
  - Modified `_selectPipeline()` to accept `strideBytes` and lazily create/cache pipelines keyed by `(isQuantized, hasNormals, isBlend, strideBytes)`
  - Modified `_createPipelineVariant()` to use `Math.max(strideBytes, minRequiredStride)` as the pipeline's `arrayStride`
  - Added `strideFloats` and `strideBytes` to `TileGPUResources` interface, computed from `encoding.stride * 4`
  - Removed `_createAllPipelines()` — pipelines are now created lazily on first use

### Files Modified (Session 3)
1. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`

---

## Session 4: Black Screen → Blue Globe

### Bug 4.1: Black Screen — `clear()` Color Override (ROOT CAUSE)
- **File:** `WebGPUContext.ts`
- **Root cause:** The `clear()` method checked `clearCommand.color !== undefined` to determine whether to clear color. But `WebGPUSceneRenderer._clearDepthStencil()` passed `{ color: false }`, and since `false !== undefined` is `true`, it was inadvertently clearing color to black on every frustum iteration — wiping out all previously rendered content.
- **Fix:** Added `&& clearCommand.color !== false` guards for all three channels (color, depth, stencil).

### Bug 4.2: "size is zero" — Buffer Creation Guards
- **File:** `WebGPUContext.ts`
- **Root cause:** Three buffer creation methods (`getUniformBuffer()`, `getPooledBuffer()`, `createStagingBuffer()`) bypassed `WebGPUBuffer.create()`'s existing size guard and could create zero-size buffers.
- **Fix:** Added `Math.max(size, 4)` guards to all three methods.

### Bug 4.3: Depth/Stencil Clear Values — Booleans vs Numbers
- **File:** `WebGPUSceneRenderer.ts`
- **Root cause:** `_clearDepthStencil` passed `{ depth: true, stencil: true }` (booleans) instead of proper numeric clear values.
- **Fix:** Changed to `{ depth: 1.0, stencil: 0 }` (proper numeric far-plane and stencil reset values).

### Files Modified (Session 4)
1. `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`
2. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`

---

## Session 5: Feature Renderer Destroy & Buffer Errors

### Bug 5.1: Feature Renderer Destroy Crashes
- **File:** `GraphicsContext.ts`
- **Root cause:** `_destroyFeatureRenderers()` called each renderer's `destroy()` with no arguments, but destroy functions expect their owning scene object (e.g., `destroyBillboardResources(collection)`) — causing `TypeError: can't access property "_webgpuCache"` for 20+ renderers during context shutdown.
- **Fix:** Removed the destroy() calls entirely. During GPU device destruction, all GPU resources are automatically released. The method now just nulls out array references.

### Bug 5.2: WebGLStubBuffer Regrow + Zero Guard
- **File:** `WebGLStubBuffer.ts`
- **Root cause:** The `bufferData` stub's padded branch (non-4-byte-aligned data) did NOT check for buffer regrow. Also missing a guard for zero-length data.
- **Fix:** Moved regrow logic BEFORE the padded/non-padded branch so it applies to both paths. Added `byteLength === 0` early return.

### Bug 5.3: Index Validation for Terrain Tiles
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** Some terrain tiles had index buffers referencing vertex indices beyond what the vertex buffer contained.
- **Fix:** Added index validation in `_getOrCreateTileBuffers()` that computes `vertexCount = floor(bufferSize / strideBytes)`, finds the max index value, and clamps to only valid triangles.

### Bug 5.4: Splitscreen Initial Sync
- **File:** `CesiumViewer.js`
- **Fix:** Added initial `copyCamera()` call immediately after setting up camera change listeners, plus an explicit `requestRender()` on the WebGL viewer.

### Files Modified (Session 5)
1. `packages/engine/Source/Renderer/GraphicsContext.ts`
2. `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubBuffer.ts`
3. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
4. `Apps/CesiumViewer/CesiumViewer.js`

---

## Session 6: Diagnostic Page — Pipeline Compilation Failures

### Bug 6.1: GlobeTerrain WGSL Uniform Control Flow
- **File:** `GlobeTerrain.wgsl`
- **Root cause:** `textureSample` and `textureSampleCompare` require uniform control flow in WGSL, but were called after non-uniform `discard`/`return` (clipping planes). This prevented the **entire globe terrain pipeline** from compiling.
- **Fix:**
  - Moved `globeComputeShadowFactor()` (uses `textureSampleCompare`) to top of `fragmentMain`, before any non-uniform branches
  - Replaced ALL 5 `textureSample` calls with `textureSampleLevel(..., 0.0)` which doesn't require uniform control flow

### Bug 6.2: DepthPlane Pipeline Format Mismatch
- **Files:** `WebGPUDepthPlane.ts`, `WebGPUSceneRenderer.ts`
- **Root cause:** Pipeline used `rgba8unorm` but canvas expects `bgra8unorm`, making the entire command buffer invalid.
- **Fix:** Pass `context.presentationFormat` as `colorFormat` parameter.

### Bug 6.3: DepthPlane RTE Encoding Crash
- **File:** `WebGPUDepthPlane.ts`
- **Root cause:** `encodeQuadToRTE` called `EncodedCartesian3.fromCartesian` with wrong parameter type.
- **Fix:** Rewrote to use `EncodedCartesian3.encode` per-component + try-catch guard in SceneRenderer.

### Bug 6.4: Billboard Buffer NaN Size
- **File:** `WebGPUBuffer.ts`
- **Root cause:** `createBuffer` received non-numeric size → crash every frame.
- **Fix:** `Math.max(Number(options.size) || 4, 4)` handles NaN/undefined.

### Bug 6.5: Readback Buffer Zero-Size
- **File:** `WebGPUContext.ts`
- **Root cause:** `readPixelsToPBO` could create zero-size buffer if canvas not ready.
- **Fix:** `Math.max(bytesPerRow * height, 4)`.

### Bug 6.6: Expired Ion Token (Test Page)
- **File:** `webgpu-pipeline-debug.html`
- **Fix:** Removed explicit token, uses CesiumJS built-in default.

### Files Modified (Session 6)
1. `packages/engine/Source/Shaders/WebGPU/GlobeTerrain.wgsl`
2. `packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts`
3. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`
4. `packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts`
5. `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`
6. `Apps/WebGPUTest/webgpu-pipeline-debug.html`

---

## Session 7: Build System Fixes

### Bug 7.1: TypeScript Version Conflict
- **File:** `package.json`
- **Fix:** Updated `typescript-eslint` from `^8.30.1` → `^8.58.0` (supports `<6.1.0`) to resolve conflict with `typescript@6.0.2`.

### Bug 7.2: Build App Asset Path
- **File:** `gulpfile.apps.js`
- **Fix:** Made `buildCesiumViewer` use `Build/CesiumUnminified/` for dev mode (was hardcoded to `Build/Cesium/`).

### Bug 7.3: JSDoc Errors (Multiple Files)
- **Files:** `RenderCommand.js`, `Scene.js`, `WebGPUPointPrimitiveRenderer.js`
- **Fix:** Fixed verbose `@module`, invalid `@returns` types, escaped `@location` WGSL tags.

### Bug 7.4: WebGPU Type Stubs
- **Files:** `Tools/jsdoc/webgpu-stubs.d.ts` (NEW), `Tools/jsdoc/tsconfig.json`, `Specs/TypeScript/tsconfig.json`
- **Fix:** Added type stubs for WebGPU types referenced in generated `Cesium.d.ts`.

### Bug 7.5: `RenderState.releaseCache()` Missing
- **File:** `packages/engine/Source/Renderer/RenderState.js`
- **Fix:** Added new public static method wrapping the private `removeFromCache()`, used by 3 upstream BufferPrimitive files.

### Bug 7.6: Imagery Texture Cache Missing Fields
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Fix:** Added missing `sourceWidth`/`sourceHeight` to imagery texture cache entry.

### Files Modified (Session 7)
1. `package.json`
2. `gulpfile.apps.js`
3. `Tools/jsdoc/tsconfig.json`
4. `Tools/jsdoc/webgpu-stubs.d.ts` (NEW)
5. `Specs/TypeScript/tsconfig.json`
6. `packages/engine/Source/Renderer/RenderState.js`
7. `packages/engine/Source/Renderer/WebGPU/RenderCommand.js`
8. `packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js`
9. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
10. `packages/engine/Source/Scene/Scene.js`

---

## Session 8: Environment Command Injection & Terrain Investigation

### Bug 8.1: Environment Commands Not Reaching WebGPU Render Pass (ROOT CAUSE — Stars Issue)
- **File:** `SceneRenderer.js`
- **Root cause:** `renderEnvironment()` was skipped for WebGPU (line 303), but the environment commands (sky, atmosphere, sun, moon) were stored on `environmentState` properties — NOT in the frustum command list. The WebGPU scene renderer looked for them in `frustumCommands.commands[Pass.ENVIRONMENT]` which was always empty.
- **Fix:** Added environment command injection before handing off to the alternate scene renderer. Commands from `environmentState` (skyBoxCommand, skyAtmosphereCommand, sunDrawCommand, moonCommand, panoramaCommandList) are pushed into the farthest frustum's ENVIRONMENT pass slot. **Only commands with `isWebGPUDrawCommand === true` are injected** — WebGL fallback commands are skipped to prevent TypeErrors.

### Bug 8.2: `setVertexBuffer` TypeError on Environment Commands
- **File:** `WebGPUSceneRenderer.ts`
- **Root cause:** Some environment commands had vertex buffers that were not real `GPUBuffer` objects (likely WebGL stub buffers from feature renderers that create WebGL-style resources). When executed in the WebGPU render pass, `renderPass.setVertexBuffer(0, notAGPUBuffer)` threw a TypeError.
- **Fix:** Added try-catch error handling to `executeBatch()` in `WebGPUSceneRenderer.ts`. Errors are logged once per command type (deduplicated by label + message) and skipped — the rest of the frame continues rendering. This prevents one bad command from crashing the entire frame.

### Terrain Analysis (In Progress)
- **Code flow verified:** WebGPU terrain commands ARE properly created by `addWebGPUDrawCommandsForTile()` with `pass: Pass.GLOBE`, `boundingVolume`, and `isWebGPUDrawCommand: true`
- **Frustum binning verified:** View.js `createPotentiallyVisibleSet()` does NOT filter by `shaderProgram`/`renderState` — WebGPU commands pass through correctly
- **`updateDerivedCommands` safe:** Returns early for WebGPU commands (no `derivedCommands` property)
- **Shader base color:** When no imagery is ready, globe tiles render with `vec3(0.04, 0.04, 0.06)` — very dark blue-gray
- **Placeholder textures:** When imagery not ready, all 4 texture slots get `context.defaultTexture` (1x1 white), and `layerCount = 0` → no texture sampling occurs
- **Debug logging added:** `console.log` on first frame showing command counts per frustum per pass

### Remaining Investigation — What "Blue Globe" Means
The "blue globe" seen by the user likely means:
1. Globe terrain tiles ARE rendering (geometry shows a sphere)
2. The Bing Maps base imagery IS loading (Earth appears blue because 70% is ocean)
3. What's missing is the STAR MAP behind it (which we now have a fix for)
4. And possibly detailed terrain ELEVATION data (mesh heights)

### Files Modified (Session 8)
1. `packages/engine/Source/Scene/SceneRenderer.js` — Environment command injection into farthest frustum
2. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — try-catch in executeBatch, debug logging

### Build Status
- `npx gulp build` — ✅ Passes (19s)
- `npx tsc --noEmit` — ✅ Zero errors
- Puppeteer browser testing unavailable (bundled Chromium doesn't support WebGPU)

---

## Active Issues

### Issue A: Star Map / Space Imagery — FIX APPLIED, NEEDS TESTING
**Status:** Fix applied in Session 8. Environment commands are now injected into the farthest frustum's ENVIRONMENT pass slot. Only WebGPU commands are injected. Try-catch prevents crashes.

**Test required:** Open `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu` in Chrome with WebGPU support and verify stars appear. Check browser console for `[WebGPU] Frustum X: ENVIRONMENT=N` debug messages showing environment commands are present.

### Issue B: Terrain Not Rendering — ANALYSIS COMPLETE, LIKELY WORKING
**Status:** Code analysis shows terrain commands flow correctly through the entire pipeline. The "blue globe" the user saw is likely the Earth WITH imagery (oceans are blue). The real issue may have been the missing stars background making it look wrong.

**If terrain still doesn't show after stars fix:** Check console for command execution warnings (from the new try-catch logging). Look for `Command execution failed` messages that would indicate specific terrain tile commands are crashing.

**Possible remaining causes:**
- Terrain pipeline compilation failure (check for `[CesiumJS:webgpu:*]` warnings)
- Imagery tile fetch errors (check network tab for 401/403 errors on tile requests)
- Vertex buffer type mismatch in `WebGPUGlobeSurfaceRenderer.ts` `_getOrCreateTileBuffers()`

---

## Session 14: WebMercatorT Shader Support & UV Stretching Fix

**Date:** April 4, 2026

### Bug 14.1: UV Stretching — WebMercatorT Not Passed Through Shader
- **Files:** `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** The WebGL shader passes `webMercatorT` as a varying and uses a per-layer `u_dayTextureUseWebMercatorT` boolean to select between geographic V and Mercator T coordinates. The WGSL shader had NO webMercatorT support — it always used geographic V with Mercator-space `translationAndScale`, causing severe UV distortion for all Web Mercator imagery (Bing Maps).
- **Fix:** Added full webMercatorT support matching WebGL:
  - `v_textureCoordinates` changed from `vec2` to `vec3` (u, v_geo, webMercatorT)
  - `processVertex()` accepts webMercatorT parameter
  - 3 uncompressed entry points: `vertexMain`, `vertexMainWebMerc`, `vertexMainWebMercNormals`
  - Per-layer `useWebMercatorTLayer: vec4<f32>` in TileUniforms (offsets 88-91)
  - Fragment shader uses `select()` to pick geographic V or webMercatorT per layer
  - `TILE_UNIFORM_FLOATS` increased from 88 to 92

### Bug 14.2: Quantized Terrain WebMercatorT Decompression
- **Files:** `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** For BITS12 quantized terrain with `hasWebMercatorT=true`, `compressed0.w` stores the COMPRESSED webMercatorT (not the encodedNormal). The shader was treating `.w` as encodedNormal for all quantized tiles, producing wrong normals and wrong webMercatorT=uv.y fallback.
- **Fix:** Added `vertexMainQuantizedWebMerc` entry point that decompresses webMercatorT from `compressed0.w` via `decompressTextureCoordinates()`. Pipeline selects this entry point when `hasWebMercatorT=true`.

### Bug 14.3: Back-Face Culling Regression from octDecode(0.0)
- **Files:** `GlobeTerrain.wgsl`
- **Root cause:** `vertexMainQuantizedWebMerc` passed `0.0` as the encoded normal (since the real normal isn't available without a second attribute). `octDecode(0.0)` produces normal `(0, 0, -1)` — pointing AWAY from the camera. With `cullMode: "back"`, tiles were entirely culled, causing a blank blue globe at orbit view.
- **Fix:** Changed sentinel normal from `0.0` to `32896.0` (oct-encoded approximately-up vector `(0,0,1)`), preventing back-face culling.

### Bug 14.4: Vertex Attribute Format Mismatch for WebMercatorT+Normals
- **Files:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** When `hasWebMercatorT=true AND hasNormals=true`, the uncompressed vertex data layout is `[u, v, webMercatorT, encodedNormal]` (4 floats at location 1). The pipeline was using `float32x3` which only read 3 floats, treating webMercatorT as the normal and missing the actual normal entirely.
- **Fix:** Pipeline now uses `float32x4` for this case with `vertexMainWebMercNormals` entry point that reads normal from `.w` and webMercatorT from `.z`.

### Bug 14.5: 2D Mode SceneMode Check
- **File:** `WebGPUSceneRenderer.ts` line 446
- **Root cause:** Code checked `scene.mode !== 0` intending to detect SCENE2D, but `SceneMode.SCENE2D = 2` (not 0; 0 is MORPHING).
- **Fix:** Changed to `scene.mode !== 2`.

### Bug 14.6: Spammy Per-Tile Diagnostic Logs
- **File:** `GlobeSurfaceTileProviderRendering.js`
- **Root cause:** Per-tile `_diagLogged` flag was set on each new command object (created every frame), causing continuous log spam.
- **Fix:** Removed the per-tile exec diagnostic logging entirely.

### Files Modified
| File | Changes |
|---|---|
| `GlobeTerrain.wgsl` | v_textureCoordinates vec2→vec3, processVertex webMercatorT param, 5 vertex entry points, useWebMercatorTLayer uniform, fragment per-layer UV selection, quantized webMerc entry point |
| `WebGPUGlobeSurfaceRenderer.ts` | hasWebMercatorT in TileGPUResources, TILE_UNIFORM_FLOATS 88→92, pipeline variant for all encoding combos, useWebMercatorT per-layer uniform writes |
| `WebGPUSceneRenderer.ts` | SceneMode.SCENE2D check fix (0→2) |
| `GlobeSurfaceTileProviderRendering.js` | Removed spammy per-tile exec diagnostics |
| `WebGPUImageryReprojection.ts` | Minor: image dimension fallback (naturalWidth/Height) |

### Remaining Issues

- Southern hemisphere tiles render white (imagery not loading or texture upload failing)
- 2D mode still renders as sphere (deeper projection changes needed)
- Stars/skybox not rendering
- Camera jittering at close zoom
- Some UV stretching persists at certain LODs

---

## Session 15: LOD Unlock & TexCoordsRect Alpha Masking

**Date:** April 4, 2026

### Bug 15.1: Vertical Stripes from Incorrect texCoordsRect UV Clamping
- **Files:** `GlobeTerrain.wgsl`
- **Root cause:** The WGSL shader clamped texture UV coordinates to `texCoordsRect` (e.g., `clamp(sUV, rect.xy, rect.zw)`). But in the WebGL shader, `texCoordsRect` is used for **alpha masking** (zeroing alpha outside the rect), NOT for UV clamping. When texCoordsRect was `(0, 0.5, 1, 1)` (northern half of level-0 tile), the clamp forced all southern-half fragments to sample from V=0.5 — the same texture row — creating vertical stripes.
- **Fix:** Removed UV clamping. Added `texCoordsAlpha()` function matching WebGL's `sampleAndBlend` behavior: uses `step()` to zero alpha when tile UV is outside texCoordsRect. The sampler's `clamp-to-edge` handles out-of-range UVs naturally.

### Bug 15.2: Only LOD 0 Tiles Rendered — tile.renderable Gated on vertexArray
- **File:** `GlobeSurfaceTile.js` line 368
- **Root cause:** `tile.renderable = defined(surfaceTile.vertexArray)`. In WebGPU mode, WebGL vertex arrays are never created, so `surfaceTile.vertexArray` is always `undefined`. This made ALL tiles non-renderable, preventing the quadtree from subdividing beyond LOD 0. Result: entire globe rendered with just 2 low-resolution level-0 tiles.
- **Fix:** Added OR condition: `tile.renderable = defined(surfaceTile.vertexArray) || (defined(surfaceTile.mesh) && defined(surfaceTile.mesh.vertices) && defined(surfaceTile.mesh.indices))`. For WebGPU, tiles become renderable when mesh data is available (which the WebGPU renderer reads directly).

### Bug 15.3: Fill Tile Index Buffer Stride Mismatch
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** Fill tiles (TerrainFillMesh) sometimes have vertex data with a different effective stride than `encoding.stride` reports. The computed vertex count (`vbSize / strideBytes`) is lower than the actual vertex count, causing index buffer out-of-bounds errors ("Index N extends beyond limit M").
- **Fix:** Added stride inference: when `maxIdx >= vertexCount`, infer the actual stride from `vertices.length / (maxIdx + 1)`. If the inferred stride produces a valid vertex count, use it instead. Also added diagnostic logging for stride mismatches.

### Bug 15.4: Diagnostic Log Counter Never Stopping
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** `_diagTileCount` was only incremented inside the `if (_diagTileCount < 10)` block. Other code checked `_diagTileCount <= 10` (which was always true since it never exceeded 10), causing perpetual log spam.
- **Fix:** Moved `_diagTileCount++` outside the conditional block so it increments on every call to `createTileCommands`.

### Files Modified

| File | Changes |
|---|---|
| `GlobeTerrain.wgsl` | Removed texCoordsRect UV clamping, added `texCoordsAlpha()` for alpha masking, UV debug mode |
| `GlobeSurfaceTile.js` | `tile.renderable` check includes mesh data availability (WebGPU LOD unlock) |
| `WebGPUGlobeSurfaceRenderer.ts` | Stride inference for fill tiles, enhanced diagnostic logging (transScale, texture dims, vertex UVs), fixed counter |

### Remaining Issues

- Black tears/seams between some tiles (fill tile stride mismatches still partially unresolved)
- WebGL/WebGPU texture Y-flip for some imagery (investigation pending)
- Stars/skybox not rendering
- 2D mode still renders as sphere
- Camera jittering at close zoom

---

## Files Modified Summary (All Sessions)

| File | Sessions | Changes |
|------|----------|---------|
| `WebGPUBuffer.ts` | 1, 6 | String-as-label detection, NaN size guard |
| `WebGPUEnvironmentRenderer.js` | 1 | Sun/Moon vertex buffer fixes |
| `WebGPUSkyAtmosphereRenderer.js` | 1 | Atmosphere buffer fixes |
| `SceneRenderer.js` | 1 | Skip renderEnvironment for WebGPU |
| `WebGPUSceneRenderer.ts` | 1, 3, 4, 6 | ENVIRONMENT pass, stride cache, depth values, depth plane format |
| `CesiumViewer.js` | 1, 5 | Camera sync for split mode |
| `GlobeTerrain.wgsl` | 2, 6, 14, 15 | Bind group merge, uniform control flow, webMercatorT, texCoordsAlpha |
| `GlobeTerrain.js` | 2 | Generated shader wrapper update |
| `WebGPUGlobeSurfaceRenderer.ts` | 2, 3, 5, 7, 14, 15 | Alignment, stride cache, index validation, imagery fields, webMercatorT, stride inference |
| `GlobeSurfaceTileProviderRendering.js` | 2, 14 | ES module import for shader, removed spammy diagnostics |
| `GlobeSurfaceTile.js` | 15 | tile.renderable WebGPU mesh data check |
| `WebGLStubBuffer.ts` | 2, 5 | Buffer regrow, zero guard |
| `WebGPUContext.ts` | 4, 6 | Clear guards, buffer size guards, readback guard |
| `GraphicsContext.ts` | 5 | Simplified feature renderer destroy |
| `WebGPUDepthPlane.ts` | 6 | Format mismatch, RTE encoding |
| `package.json` | 7 | typescript-eslint version |
| `gulpfile.apps.js` | 7 | Dev build asset path |
| `RenderState.js` | 7 | releaseCache() |
| `RenderCommand.js` | 7 | JSDoc fix |
| `Scene.js` | 7 | JSDoc fix |
| `WebGPUPointPrimitiveRenderer.js` | 7 | JSDoc fix |
| `webgpu-stubs.d.ts` | 7 | NEW - type stubs |
| Various tsconfig.json | 7 | Added webgpu stubs |

---

## Bug Pattern Analysis

### Most Common Root Causes
1. **API mismatch** (6 bugs): Callers passing wrong parameter types/order to WebGPU buffer/pipeline creation functions
2. **Silent failures** (5 bugs): Errors swallowed by missing guards, causing cascading downstream failures  
3. **WebGL→WebGPU assumption gaps** (4 bugs): Boolean vs numeric clear values, texture format mismatches, 4-byte alignment
4. **Buffer sizing** (4 bugs): Zero-size, NaN-size, or undersized buffers from various code paths
5. **Architecture gaps** (2 bugs): Environment pass command routing, pipeline stride assumptions

### Most Frequently Modified Files
1. `WebGPUGlobeSurfaceRenderer.ts` — 4 sessions (terrain pipeline is the most complex)
2. `WebGPUSceneRenderer.ts` — 4 sessions (frame orchestration touches many systems)
3. `WebGPUContext.ts` — 2 sessions (core context affects everything)
4. `WebGPUBuffer.ts` — 2 sessions (buffer creation is foundational)

---

## Session 9: Environment Injection Fix (Previous Session)

### Bug 9.1: Environment Commands Bypassed by WebGPU Branch (ROOT CAUSE — Stars)
- **File:** `Scene.js`
- **Root cause:** `Scene.executeCommands()` detects the WebGPU alternate renderer and calls it directly, then returns — completely bypassing `ViewportExecutor.executeCommandsInViewport()` where Session 8's injection code lived. The Session 8 fix was dead code.
- **Fix:** Added `_injectEnvironmentCommandsForWebGPU()` called BEFORE the alternate renderer's `executeCommands()`. Collects environment commands from `environmentState` and injects into the farthest frustum.

### Bug 9.2: Terrain Imagery Diagnosis
- Terrain geometry IS rendering (blue globe = Earth with 70% ocean). Imagery textures likely need WebGPU-compatible path.

---

## Session 10: Imagery & CubeMapPanorama Fixes (Previous Session)

### Bug 10.1: Imagery Image Source Released Before WebGPU Use
- **File:** `ImageryLayer.js`
- **Root cause:** `_createTexture()` set `imagery.image = undefined` after creating a WebGL texture, but WebGPU needs the image source later for GPUTexture creation.
- **Fix:** Added `if (!context.isWebGPU)` guard to preserve `imagery.image` for WebGPU.

### Bug 10.2: First Frustum Color Clear Missing
- **File:** `WebGPUSceneRenderer.ts`
- **Root cause:** Only depth/stencil was cleared between frustums, not color on the first pass.
- **Fix:** First frustum clears color to background color.

### Bug 10.3: SkyAtmosphere Shader Import
- **File:** `WebGPUSkyAtmosphereRenderer.js`
- **Root cause:** Shader loaded via async fetch that could fail.
- **Fix:** Direct import of pre-bundled shader module + class export fix.

---

## Session 11: Imagery Reprojection Crash & CubeMapPanorama Depth-Stencil (Current Session)

### Bug 11.1: `_reprojectTexture` Crash — "This object was destroyed" (CRITICAL FIX)
- **File:** `packages/engine/Source/Scene/ImageryLayer.js`
- **Root cause:** In `_reprojectTexture()`, the WebGPU feature renderer path (`IMAGERY_REPROJECTION`) completed successfully but **did not return** — execution fell through to the WebGL `ComputeCommand` creation code. The `ComputeCommand` tried to use `reprojectToGeographic()` which accesses WebGL-specific APIs (`context._gl`, `ShaderProgram`, `Framebuffer`). On a WebGPU context these don't exist, causing the entire rendering to crash with "This object was destroyed".
- **Fix:** Two changes:
  1. Added `return;` after the successful feature renderer reprojection path (lines 603-604) to prevent fall-through
  2. Added a **backend-agnostic** fallback: if the feature renderer exists but `imagery.image` is not available, mark the imagery as READY with the existing texture and return. This prevents ComputeCommand creation in contexts that have the imagery reprojection FR registered.
- **Architecture note:** The guard uses `if (fr)` (feature renderer existence check) rather than `if (context.isWebGPU)` to maintain backend agnosticism per `.clinerules`. ComputeCommand path only runs when no feature renderer is registered (i.e., WebGL contexts).

### Bug 11.2: CubeMapPanorama Pipeline Depth-Stencil Mismatch (CRITICAL FIX)
- **File:** `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js`
- **Error:** `Incompatible depth-stencil attachment format: the RenderPass uses depth24plus-stencil8 but the RenderPipeline uses None`
- **Root cause:** The render pipeline had `depthStencil: undefined` (line 198), meaning "no depth-stencil", but the render pass it was executed in had a `depth24plus-stencil8` attachment. WebGPU requires these to match.
- **Fix:** Added depth-stencil configuration to the pipeline: `{ format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "always" }`. `depthWriteEnabled: false` ensures the skybox doesn't write to the depth buffer (it should render behind everything). `depthCompare: "always"` ensures it always passes the depth test.

### Bug 11.3: `setVertexBuffer` Type Error (NON-BLOCKING)
- **Error:** `GPURenderPassEncoder.setVertexBuffer: Argument 2 does not implement interface GPUBuffer`
- **Root cause:** Some environment commands have vertex buffers wrapped as `WebGPUBuffer` objects. The `resolveBuffer()` function in `WebGPUDrawCommand.ts` should unwrap these, but edge cases exist where the wrapper doesn't contain a valid `GPUBuffer`.
- **Status:** Caught by the try-catch in `executeBatch()` (Session 8), logged once per unique error, and skipped. Does not crash rendering. Will be resolved as individual feature renderers are tested.

### ImageryLayer.js Full Audit
Performed a comprehensive audit of all methods in `ImageryLayer.js` for dual-renderer compatibility:

| Method | Status | Notes |
|--------|--------|-------|
| `constructor` | ✅ Compatible | No GPU calls |
| `_createTileImagerySkeletons` | ✅ Compatible | Pure math/logic |
| `_createTexture` | ⚠️ Works via stubs | Creates WebGL `Texture` via compatibility stubs on WebGPU; preserves `imagery.image` for later GPUTexture creation |
| `_createTextureWebGL` | ⚠️ WebGL-specific | Called unconditionally by `_createTexture`; works through stubs but creates unused WebGL texture on WebGPU |
| `_finalizeReprojectTexture` | ✅ Guarded | Skipped for WebGPU via `!context.isWebGPU` check; WebGL-specific mipmap/sampler operations |
| `_reprojectTexture` | ✅ **FIXED** | Feature renderer path returns early; ComputeCommand only created when no FR exists |
| `queueReprojectionCommands` | ✅ Compatible | Pushes commands to commandList (empty in WebGPU since FR handles it) |
| `_calculateTextureTranslationAndScale` | ✅ Compatible | Pure math |
| `_requestImagery` | ✅ Compatible | Network request only |

**Remaining `context.isWebGPU` checks** (2): Both at renderer boundary, protecting WebGL-specific operations. Ideally would use capability checks but functional as-is.

**GPGPU Reprojection Parity:** WebGPU has full parity — `IMAGERY_REPROJECTION` feature renderer (key 28) performs Mercator→Geographic reprojection via WGSL render-to-texture pass. Result stored in `imagery._webgpuReprojectedTexture`, consumed by `WebGPUGlobeSurfaceRenderer`.

### Files Modified (Session 11)
1. `packages/engine/Source/Scene/ImageryLayer.js` — Feature renderer early-return + fallback guard
2. `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` — Depth-stencil pipeline config

### Build Status
- `npx gulp build` — ✅ Passes (19s)

---

---

## Session 12: Build System Fix & Shader Debug Deep-Dive

### Bug 12.1: `gulp build` Missing WGSL + TypeScript Compilation (CRITICAL FIX)
- **File:** `gulpfile.js`
- **Root cause:** The `build()` function only ran `buildEngine()`, `buildWidgets()`, and `buildCesium()` — which are esbuild bundling steps. It did NOT convert WGSL shaders to JS modules or compile TypeScript before bundling. This meant:
  1. Editing `.wgsl` files had NO EFFECT on the build output — stale `.js` modules were bundled
  2. Editing `.ts` files required a separate manual `npx gulp tsc` step
  3. The `buildWatch` task DID watch WGSL files, but one-shot `gulp build` did not
- **Fix:** Added two steps at the top of the `build()` function, before bundling:
  ```javascript
  // Convert WGSL shaders to JS modules before bundling
  wgslToJavaScript(minify, "Build/minifyShaders.state", "engine");
  // Compile TypeScript before bundling
  await tsc();
  ```
- **Impact:** ALL subsequent shader and TypeScript changes now take effect with a single `npx gulp build` command.

### Bug 12.2: writeBuffer Size Bug — Floats vs Bytes (Session 13 carryover)
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** `device.queue.writeBuffer()` was called with `gpuData(data), 0, TILE_UNIFORM_FLOATS` — the third argument should be **byte count** but `TILE_UNIFORM_FLOATS = 88` was a float count (only 88 bytes written instead of 352).
- **Fix:** Changed to `data.buffer, data.byteOffset, Math.min(data.byteLength, bufferSize)` — correctly writes all 352 bytes of the uniform buffer.

### Bug 12.3: Diagnostic Property Typo
- **File:** `WebGPUGlobeSurfaceRenderer.ts`
- **Root cause:** Code referenced `this._diagFrameCount` and `this._diagMaxFrames` which don't exist on the class.
- **Fix:** Changed to `this._diagTileCount <= 10` — uses the existing `_diagTileCount` property.

### Investigation 12.4: Shader Version Mismatch Discovery (CRITICAL FINDING)
- **Files:** `GlobeTerrain.wgsl` (two versions exist)
- **Discovery:** There are TWO fundamentally different versions of the GlobeTerrain shader:
  1. **Original enhanced version** (748 lines): Uses `CameraUniforms` with `mvpRelativeToEye`, `modifiedModelView`, `center3D`, `sunDirectionEC`, `enableLighting`, `scaleAndBias`, `minMaxHeight`. Has shadow mapping, clipping planes, enhanced ocean rendering, day/night cycle, fog, atmosphere.
  2. **Simplified version** (earlier sessions): Uses `CameraUniforms` with `viewMatrix`, `projectionMatrix`, `modelViewProjectionRTE`, `encodedCameraPositionMCHigh/Low`. Basic lighting, simple fog, no shadows/clipping.
- **The JS renderer (`WebGPUGlobeSurfaceRenderer.ts`) populates the camera uniform buffer with 68 floats (272 bytes)** — this matches the ORIGINAL enhanced version's `CameraUniforms` struct size. The simplified version's struct is only 56 floats (224 bytes).
- **Current state:** The original enhanced version is on disk (748 lines). The JS renderer was built to match this version.

### Investigation 12.5: Terrain Imagery Debug — layerCount Always 0 in Shader
- **Confirmed facts:**
  1. ✅ JS writes `layerCount=2` at `u32[48]` (byte offset 192) — verified via diagnostic logging
  2. ✅ Buffer size is 352 bytes, `layerCount` at byte 192 is within bounds
  3. ✅ Bind group correctly maps `binding(1)` to the tile uniform buffer (raw `GPUBuffer`, not wrapped)
  4. ✅ Pipeline layout uses same `_bindGroupLayout0` as bind group creation
  5. ✅ Shader module IS the GlobeTerrain shader (FORCE RED test confirmed)
  6. ❌ `tile.layerCount` reads as 0 in shader — debug color visualization shows BLACK globe

- **FORCE RED test (passed):** Added `return vec4<f32>(1.0, 0.0, 0.0, 1.0)` as the first line of `fragmentMain` → globe turned RED. This proves:
  - The GlobeTerrain shader IS being compiled and executed
  - The pipeline IS being used for globe tile rendering
  - The vertex shader IS producing correct geometry

- **dbgCount visualization test:** Added at the very first line of `fragmentMain` (before any uniform reads, texture samples, or shadow/clipping code):
  ```wgsl
  let dbgCount = tile.layerCount;
  let dbgR = f32(dbgCount) / 4.0;
  let dbgG = select(0.0, 1.0, dbgCount >= 1u);
  let dbgB = select(0.0, 1.0, dbgCount >= 2u);
  return vec4<f32>(dbgR, dbgG, dbgB, 1.0);
  ```
  Result: Globe is still BLUE/BLACK — meaning `tile.layerCount` is consistently 0 in the shader.

- **Hypothesis:** The bind group is being created with the correct buffer, BUT the `executeWebGPU()` method on the command object sets bind groups via `passEncoder.setBindGroup(g, desc.bindGroups[g])`. If the render pass encoder rejects the bind groups silently (e.g., due to a layout mismatch between the pipeline's implicit layout expectations and the explicit layout), the uniform data would be zero-initialized.

- **Next steps for Session 13:**
  1. Check if the pipeline is being created with `layout: "auto"` anywhere (which would create implicit layouts that don't match explicit bind groups)
  2. Verify `_pipelineLayout` uses the same `_bindGroupLayout0` that bind groups are created with
  3. Check if bind group 3 (effects) layout mismatch could invalidate the entire bind group set
  4. Try adding `device.pushErrorScope('validation')` / `device.popErrorScope()` around draw calls to capture silent WebGPU validation errors

### Execution Path Traced (Session 12)
The full globe tile rendering path is:
1. `GlobeSurfaceTileProviderRendering.js::addDrawCommandsForTile()` — creates `cmd` with `executeWebGPU(passEncoder)` method
2. `cmd` pushed to `frameState.commandList` with `pass: Pass.GLOBE`
3. `WebGPUSceneRenderer.ts::executeBatch()` calls `context.executeWebGPUDrawCommand(cmd, passState)`
4. `WebGPUContext.ts::executeWebGPUDrawCommand()` detects `typeof command.executeWebGPU === "function"` and calls it
5. `command.executeWebGPU(passEncoder)` sets pipeline, bind groups 0-3, vertex/index buffers, draws

### Files Modified (Session 12)
1. `gulpfile.js` — Added `wgslToJavaScript()` and `await tsc()` to `build()` function
2. `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — Debug visualization code (temporary)
3. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — writeBuffer fix, diagnostic logging, _diagTileCount fix (carryover)

### Build Status
- `npx gulp build` — ✅ Passes (~54s, includes WGSL + TSC)
- TypeScript has non-blocking warnings (module resolution, null assignments) but compilation succeeds

---

## Session 13: Imagery Pipeline Fix, Async Sky Fix, WebGL Stub Logging

### Bug 13.1: Imagery Stuck in TRANSITIONING State — CRITICAL
- **File:** `packages/engine/Source/Scene/Imagery.js`
- **Root cause:** In `processStateMachine()`, if `_reprojectTexture()` threw an error, the catch block left the imagery in `ImageryState.TRANSITIONING`. The comment said "leave as TRANSITIONING so it can be retried", but NO retry logic existed — the reprojection block is only entered when `state === TEXTURE_LOADED` or `(state === READY && !texture)`, neither of which matches TRANSITIONING. The imagery was permanently stuck.
- **Impact:** If ANY imagery tile had a reprojection error (e.g., the first time the WebGPU reprojection pipeline was used), that tile's imagery would never reach READY state. Since most tiles share the same imagery layer, this could cause ALL terrain tiles to render without imagery (layerCount=0).
- **Fix:** Changed the catch block to reset `this.state = ImageryState.TEXTURE_LOADED` so reprojection is retried on the next frame. This allows transient errors (e.g., first-frame pipeline compilation) to self-heal.

### Bug 13.2: SkyAtmosphere First-Frame Async Miss
- **File:** `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js`
- **Root cause:** `updateWebGPUSkyAtmosphere()` was declared `async` and contained `const shaderCode = await getShaderSource()`. But `getShaderSource()` is synchronous (returns an ES module import). The `await` on a non-Promise value still defers the remainder of the function to a microtask, meaning `commandList.push(cache.command)` runs AFTER the current frame's command list has been processed. On the first frame, the sky atmosphere command is missing.
- **Fix:** Removed `async` keyword and `await` — function now runs fully synchronously. Pipeline, geometry, uniforms, and command are all created in the same synchronous call.

### Bug 13.3: ImageryLayer Creating WebGL Textures via Stub on WebGPU
- **File:** `packages/engine/Source/Scene/ImageryLayer.js`
- **Root cause:** `_createTexture()` unconditionally called `_createTextureWebGL()` which routes through the WebGL compatibility stub on WebGPU contexts. The stub's `gl.texImage2D()` is a no-op, so the texture upload doesn't happen. The WebGL Texture object becomes a useless shell that triggers unnecessary stub fallback warnings. The real GPU upload happens later in the reprojection FR or globe surface renderer.
- **Fix:** Added a WebGPU early path at the top of `_createTexture()`. When `context.isWebGPU`, creates a lightweight placeholder with `width`/`height` properties (needed by `_reprojectTexture()` for reprojection math) and preserves `imagery.image` for direct GPU upload later. Completely bypasses `_createTextureWebGL()` and all WebGL stub calls.

### Enhancement 13.4: WebGL Stub Call Logging
- **File:** `packages/engine/Source/Renderer/WebGPU/WebGLCompatibilityStub.ts`
- **Root cause:** The WebGL compatibility stub had a disabled `logUsage` function, making it impossible to identify which WebGL fallbacks were being used during WebGPU rendering.
- **Fix:** Enabled `logUsage` with deduplication (logs once per unique method). Each stub call now produces a `[WebGPU:StubFallback]` warning indicating missing WebGPU functionality. These logs will be removed before release.

### Enhancement 13.5: Environment Command Injection Diagnostics
- **File:** `packages/engine/Source/Scene/SceneRenderer.js`
- **Enhancement:** Added one-time diagnostic logging to the environment command injection code:
  - Reports how many environment commands were injected into the farthest frustum
  - Reports how many were already present from `commandList` (via frustum binning)
  - Shows status of skyBox, skyAtmosphere, sun, moon, and panorama commands
  - Warns when a command is defined but skipped because `isWebGPUDrawCommand` is not true

### Files Modified (Session 13)
1. `packages/engine/Source/Scene/Imagery.js` — TRANSITIONING → TEXTURE_LOADED retry
2. `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` — Remove async/await
3. `packages/engine/Source/Scene/ImageryLayer.js` — WebGPU-native texture path
4. `packages/engine/Source/Renderer/WebGPU/WebGLCompatibilityStub.ts` — Enabled stub logging
5. `packages/engine/Source/Scene/SceneRenderer.js` — Environment injection diagnostics
6. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 13 documentation

### CLAUDE.md Created
- **File:** `CLAUDE.md` (project root)
- Created Claude Code equivalent of `.clinerules` — automatically loaded into every Claude Code conversation. Contains all project rules, architecture patterns, RTE requirements, file placement rules, and build commands.

### Build Status
- `npx gulp build` — ✅ Passes (42s)
- `npx tsc --noEmit` — ✅ Zero errors

### Testing Required
Open `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu` in Chrome and check:

1. **Console diagnostics (one-time):**
   - `[WebGPU:EnvInject] Injected N env commands` — shows environment command injection status
   - `[WebGPU:GlobeTile] tile=... imagery=N ready=M` — shows imagery status per tile
   - `[WebGPU:StubFallback] gl.xxx() called` — shows which WebGL stubs are still being hit
   - `[WebGPU:Imagery] _reprojectTexture failed:` — if this appears, imagery reprojection has errors (but now retries instead of stuck)

2. **Visual checks:**
   - Stars/skybox should appear (CubeMapPanorama has been fixed in earlier sessions)
   - Sky atmosphere should render from frame 1 (async bug fixed)
   - Terrain imagery should start appearing (TRANSITIONING stuck bug fixed + WebGL stub bypassed)

### Bug 13.4: Placeholder Texture Missing destroy() — CRASH
- **File:** `packages/engine/Source/Scene/ImageryLayer.js`
- **Error:** `TypeError: this.texture.destroy is not a function` in `Imagery.releaseReference()`
- **Root cause:** The WebGPU placeholder texture object (created in Bug 13.3 fix) didn't have a `destroy()` method. When CesiumJS trims terrain tiles and frees imagery resources, it calls `imagery.texture.destroy()` which crashed.
- **Fix:** Added a no-op `destroy()` method to the placeholder. The real GPUTexture is managed by the globe surface renderer's texture cache.

### Bug 13.5: `layerCount: u32` Not Readable in WGSL — DATA TYPE ISSUE
- **Root cause:** `tile.layerCount` declared as `u32` in WGSL TileUniforms struct always read as 0 in the shader, despite JavaScript correctly writing the value to byte offset 192 (confirmed via hex diagnostic `0x3F800000` = float 1.0). All other tile uniform data (fog, flags, layers) also read as 0 from the shader when `layerCount` was `u32`.
- **Investigation:** Extensive testing proved:
  1. JS writes correct data to GPU buffer (verified via diagnostic logging)
  2. Bind groups are valid `GPUBindGroup` objects (verified)
  3. No GPU validation errors (verified via `device.pushErrorScope`)
  4. Camera uniforms (binding 0, same bind group) work correctly
  5. Changing `layerCount` from `u32` to `f32` and writing as float FIXED the issue
- **Diagnosis:** The `u32` type in a uniform struct after an `array<ImageryLayer, 4>` was being read incorrectly. Changing to `f32` resolved it. This may be a Firefox/wgpu WGSL struct layout issue with mixed `u32`/`f32` types after arrays.
- **Fix:** Changed `layerCount` from `u32` to `f32` in both the WGSL struct and the JS writer (`data[48] = layerCount` instead of `u32[48] = layerCount`). All comparisons updated to use `u32(tile.layerCount)` cast.

### Bug 13.6: `wgslToJavaScript` Not Awaited — CLEAN BUILD FAILURE
- **File:** `gulpfile.js`
- **Root cause:** `wgslToJavaScript(minify, ...)` was called without `await`. This async function converts `.wgsl` files to `.js` wrapper modules. Without await, TypeScript compilation started before the wrappers were generated. Worked before because cached `.js` files existed; failed after `gulp clean` deleted them all.
- **Fix:** Added `await` before `wgslToJavaScript(...)` call.

### Enhancement 13.7: Texture Y-Flip for WebGPU
- **Files:** `WebGPUGlobeSurfaceRenderer.ts`, `WebGPUImageryReprojection.ts`
- **Root cause:** WebGL `texImage2D` has (0,0) at bottom-left; WebGPU `copyExternalImageToTexture` has (0,0) at top-left. Without correction, imagery textures are vertically flipped.
- **Fix:** Added `flipY: true` to both `copyExternalImageToTexture` calls.

### Enhancement 13.8: Build System Improvements
- **`gulpfile.js`:** Enhanced `clean` task to also remove generated WGSL→JS wrappers (`packages/engine/Source/Shaders/WebGPU/**/*.js`) and package-level build outputs (`packages/engine/Build/**`, `packages/widgets/Build/**`)
- **`package.json`:** Added `npm run restart` script (clean → build → start)

### Current Status After Session 13
**What now works:**
- Imagery compositing pipeline: layerCount reaches shader as f32, textures upload and sample correctly
- Satellite imagery, labels, and land masses ARE visible on terrain tiles
- No GPU validation errors
- WebGL stub logging identifies fallback usage

**What still needs fixing:**
- Terrain tile geometry distorted at higher LODs (tiles appear as small patches instead of draping on globe)
- Root cause hypothesis: vertex stride mismatch when `hasWebMercatorT` flag adds an extra float per vertex, shifting attribute offsets
- Stars/skybox not rendering (environment command injection needs testing)
- Sky atmosphere positioning (rendered as separate sphere)
- GlobeTerrain.wgsl fragment shader simplified to debug-only mode (full effects commented out, preserved for restoration)

### Terrain Encoding Analysis (for next session)
CesiumJS terrain vertex data layout varies by encoding:

**Uncompressed (TerrainQuantization.NONE):**
| Stride variant | Floats | Bytes | Layout |
|---|---|---|---|
| Base | 6 | 24 | pos(3) + height(1) + uv(2) |
| +webMercatorT | 7 | 28 | pos(3) + height(1) + uv(2) + wmT(1) |
| +normals | 7 | 28 | pos(3) + height(1) + uv(2) + normal(1) |
| +webMercatorT +normals | 8 | 32 | pos(3) + height(1) + uv(2) + wmT(1) + normal(1) |

**Key issue:** When `hasWebMercatorT=true`, the encoded normal shifts from float index 6 to 7. Our pipeline reads `textureCoordAndEncodedNormals` as `float32x3` at offset 16 (bytes), expecting `[u, v, normal]`. But with webMercatorT, the data at offset 16 is `[u, v, wmT]` and the normal is at offset 28 — **off by one float**.

### Files Modified (Session 13)
1. `packages/engine/Source/Scene/Imagery.js` — TRANSITIONING → TEXTURE_LOADED retry
2. `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` — Remove async/await
3. `packages/engine/Source/Scene/ImageryLayer.js` — WebGPU-native texture path + placeholder destroy()
4. `packages/engine/Source/Renderer/WebGPU/WebGLCompatibilityStub.ts` — Enabled stub logging
5. `packages/engine/Source/Scene/SceneRenderer.js` — Environment injection diagnostics
6. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — GPU validation error scope
7. `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` — Tile execute diagnostics, remove dead code
8. `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — layerCount u32→f32, simplified fragment (full code preserved commented)
9. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — layerCount as f32, flipY texture upload
10. `packages/engine/Source/Renderer/WebGPU/WebGPUImageryReprojection.ts` — flipY texture upload
11. `gulpfile.js` — await wgslToJavaScript, enhanced clean task
12. `package.json` — npm run restart
13. `Apps/CesiumViewer/CesiumViewer.js` — eslint curly brace fixes
14. `.gitignore` — exclude .mcp.json, CLAUDE.md
15. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 13 documentation

### Build Status
- `npx gulp build` — Passes (42s)
- `npx tsc --noEmit` — Zero errors
- `npm run restart` — Works (clean → build → start)

---

*This document will be updated as additional bugs are found and fixed.*
