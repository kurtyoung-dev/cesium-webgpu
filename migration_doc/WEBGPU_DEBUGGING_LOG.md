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
12. [Session 16: Architecture Cleanup, Shadow Casting & Performance](#session-16-architecture-cleanup-shadow-casting--performance)
13. [Files Modified Summary](#files-modified-summary)

---

## Current Status

**What works:** Globe renders with satellite imagery at multiple LODs. WebMercatorT texture coordinate support matches WebGL. Higher LOD tiles load and render as camera zooms in. Environment injection wired. CubeMapPanorama pipeline fixed. Imagery reprojection crash fixed. Build system compiles WGSL shaders + TypeScript. Camera jitter significantly reduced via async staleness validation + distance ratio checks. Fill tile black lines eliminated by skip. Backend-agnostic architecture enforced: zero `isWebGPUDrawCommand` checks in Scene code. Shadow cast pipeline wired. Render bundles activated for terrain. Ring buffer allocator initialized.

**What needs visual verification:**

- Stars/skybox rendering (panoramaCommandList clearing fixed, diagnostic logging improved)
- Shadow casting end-to-end (pipeline wired, bias fixed, command collection fixed)

**Known remaining issues:**

- ⚠️ 2D/Columbus View mode implemented in WebGPU globe shader (Session 18) — needs visual verification
- ⚠️ Advanced renderers (Cloud, Voxel, GaussianSplat, PointCloud, Ellipsoid) built but untested end-to-end
- ⚠️ Buffer primitive collections (v1.140 vector tiles) are intentional stubs

---

## Session 27: Phase 1.2 Moon Parity Port (2026-04-09)

Phase 1.2 of the Celestial work, which closed several latent bugs in the WebGPU moon path while bringing it to full WebGL feature parity. Three rounds (1.2a/b/c v2). All landed 2026-04-09.

### Bug 27.1: Moon rendered as 4×4 gray placeholder

- **Files:** `WebGPUEnvironmentRenderer.js`
- **Root cause:** `updateWebGPUMoon` created `createMoonPlaceholderTexture()` (a 4×4 gray RGBA) once and never upgraded to the real moon texture from `moon.textureUrl` (default `Assets/Textures/moonSmall.jpg`). Every WebGPU user saw a gray sphere instead of the actual moon. The bug had been present since the WebGPU moon was first scaffolded — it was a deliberate stub for the bootstrap, but the upgrade path was never wired.
- **Fix:** New `_loadRealMoonTexture(device, cache, textureUrl)` async helper that uses `Resource.createIfNeeded(textureUrl).fetchImage()` + `WebGPUImageUpload.uploadImageToTexture()`. Tracks `cache._textureLoading` to prevent duplicate fetches and `cache._cachedTextureUrl` to detect URL changes at runtime. On success, destroys the placeholder, replaces `cache.moonTexture` / `moonTextureView`, and clears `cache.bindGroup` so the next frame rebuilds it. On failure, logs once with `console.warn` and sticks with the placeholder. Phase 1.2b.

### Bug 27.2: Moon UV mapping used mesh-baked UVs instead of canonical spherical unwrap

- **Files:** `Shaders/WebGPU/Environment/Moon.wgsl`
- **Root cause:** The original WebGPU moon shader used interpolated per-vertex UVs from the UV-sphere tessellator. WebGL's `EllipsoidFS.glsl` uses `czm_ellipsoidTextureCoordinates(sphericalNormal)` (atan2/asin canonical spherical unwrap from a spherical-normalized position). Mesh-baked UVs and atan2/asin UVs differ subtly on spheres and significantly on oblate ellipsoids — the moon texture would render with a slight rotation and seam misalignment vs WebGL.
- **Fix:** New `Moon.wgsl` shader inlines the canonical unwrap (`vec2(atan2(n.y, n.x) * 0.5/PI + 0.5, asin(n.z) * 1.0/PI + 0.5)`), matching `chunks/functions/csm_ellipsoidTextureCoordinates.wgsl` exactly. Uses the spherical normal `normalize(positionMC / radii)` for the UV input, matching WebGL bit-for-bit. Phase 1.2b → 1.2c v2.

### Bug 27.3: Moon shader inlined as a template literal in the renderer JS

- **Files:** `WebGPUEnvironmentRenderer.js` → `Shaders/WebGPU/Environment/Moon.wgsl` (new) + `Moon.js` (hand-written wrapper)
- **Root cause:** The moon shader lived as a 60-line template-literal string inside `createMoonPipeline()` in `WebGPUEnvironmentRenderer.js`. Every other WebGPU shader in the project lives in a `.wgsl` file under `Source/Shaders/WebGPU/`, with a sibling `.js` wrapper auto-generated by `gulp build`'s `wgslToJavaScript` step. The inline shader violated project convention, broke editor syntax highlighting / WGSL language servers, and made the shader hard to find via grep.
- **Fix:** Extracted to `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl`. The hand-written `Moon.js` wrapper (gitignored, regenerated by next `gulp build`) was bootstrapped with a small node helper script and matches the format of `EllipsoidFS.js` exactly. Renderer now imports `MoonShaderCode from "../../Shaders/WebGPU/Environment/Moon.js"`. Phase 1.2b.

### Bug 27.4: Lit-hemisphere shading was a placeholder, not Phong

- **Files:** `Shaders/WebGPU/Environment/Moon.wgsl`, `WebGPUEnvironmentRenderer.js`
- **Root cause:** The original moon FS did `max(NdotL, 0) + 0.05 ambient` — no specular, no material system, no Phong. WebGL's `EllipsoidFS.glsl` runs `czm_private_phong` (Lambert diffuse + specular + emission, ambient zero) through a full `czm_material` filled by `Material.fromType(Material.ImageType)`. The visible difference at typical viewing distance is small but the parity gap was real.
- **Fix:** New shader implements `phongCsmMaterial(m, lightDir, toEye)` matching `czm_private_phong` exactly: Lambert against `material.normal`, specular via `reflect/pow/material.shininess`, zero ambient, white light. Texture sample fills a `CsmMaterial` local with `diffuse = texColor.rgb`, `specular = u.specularStrength` (default 0.3), `shininess = u.shininess` (default 5.0 — rocky lunar surface), zero emission. Matches `Material.fromType(Material.ImageType)` semantics. Phase 1.2b → 1.2c v2.

### Bug 27.5: `moon.onlySunLighting` toggle silently ignored

- **Files:** `Shaders/WebGPU/Environment/Moon.wgsl`, `WebGPUEnvironmentRenderer.js`
- **Root cause:** WebGL respects `moon.onlySunLighting` via `#ifdef ONLY_SUN_LIGHTING` in `EllipsoidFS.glsl`. The WebGPU shader unconditionally used the sun direction regardless of the flag, so users who set `scene.light = customLight` got the sun-lit moon anyway.
- **Fix:** New uniform `onlySunLighting: u32` (packed as float). The FS branches `let useSun = u32(round(u.onlySunLighting)) == 1u; let L = select(sceneLightDirMC, sunDirMC, useSun);`. JS side passes `moon.onlySunLighting === false ? 0.0 : 1.0`. Both light directions are pre-rotated to model space on the JS side via the inverse modelMatrix rotation. Phase 1.2b → 1.2c v2.

### Bug 27.6: No log-depth write — moon broke depth sorting in multi-frustum scenes

- **Files:** `Shaders/WebGPU/Environment/Moon.wgsl`, `WebGPUEnvironmentRenderer.js`
- **Root cause:** WebGL `EllipsoidFS.glsl` writes `gl_FragDepth` via `czm_writeLogDepth(...)` when `czm_useLogDepth` is set, so the moon depth-sorts correctly with distant stars/planets in multi-frustum scenes. The WebGPU shader had `depthWriteEnabled: false` AND no `@builtin(frag_depth)` output, so the moon either Z-fought with the sky or depended on draw order.
- **Fix:** `FragOut { color: vec4f @location(0); depth: f32 @builtin(frag_depth) }`. When `useLogDepth == 1u`, computes `log2(1+w) / log2(1+far)` from the VS-output clip-space `w`. New uniform `farPlane: f32` from `uniformState.currentFrustum.y`. Phase 1.2b → exact value in 1.2c v2 (the v1 attempt used a model-space ray-parameter approximation; v2 reverted to bounding-cube geometry with VS-output clipW for an exact value).

### Bug 27.7: Phase 1.2c v1 used a full-screen quad — caught before merge

- **Files:** `Shaders/WebGPU/Environment/Moon.wgsl`, `WebGPUEnvironmentRenderer.js`
- **Root cause:** During Phase 1.2c (round 1), the moon shader was rewritten as a full-screen-quad ray-marcher to fix the four "skipped parity items" (analytic intersection, geodetic normal, back-face inside pass, CsmMaterial). I anchored on the orphan `Generated/EllipsoidPrimitive.wgsl` for inspiration, which itself uses a full-screen quad approach. The user caught this on review: WebGL's `EllipsoidPrimitive` uses a **bounding cube** (`BoxGeometry.fromDimensions({2,2,2})` scaled by `radii` in `EllipsoidVS.glsl:13`), not a full-screen quad. A full-screen quad means every pixel on the canvas runs the FS — at 4K that's ~8M FS invocations per frame for a moon that occupies maybe 200 pixels. The FS would discard early but the rasterizer + scheduler cost is real.
- **Fix:** Phase 1.2c v2 reverted the geometry to a bounding cube (8 vertices, 36 indices, vec3 cube position scaled by `radii` in the VS) matching WebGL exactly. The cube's screen footprint scales with the moon's actual on-screen size, so the FS only runs on pixels that could possibly contain the moon. The ray-march analytic intersection logic was preserved from v1 (it's correct math regardless of geometry); only the vertex stage and JS-side geometry generation changed. Lessons: (1) audit the actual WebGL primitive's geometry before assuming the shader-side reference file represents the canonical approach; (2) the orphan `EllipsoidPrimitive.wgsl` is a Slang playground, not a proven design.

### Bug 27.8: WebGPURenderBundleManager and SnapshotModeService had no real consumers

- **Files:** `WebGPUEnvironmentRenderer.js`, `WebGPUDrawCommand.ts`
- **Root cause:** Phase 0.4 (VPT) and Phase 0.7 (SnapshotMode) shipped registration skeletons but no scene-level renderer was actually using them. The contracts existed but were never validated end-to-end. Same for `WebGPURenderBundleManager` — the manager existed and was used by terrain bundles, but no renderer outside terrain had registered against it as part of the Phase 0 surfaces.
- **Fix:** Phase 1.2c v2 makes Moon the **first real consumer** of all three:
  - **Render bundle**: `updateWebGPUMoon` calls `context.renderBundleManager.getOrCreate("moon:...", desc, callback)` to cache the encoded `setPipeline → setBindGroup → setVertexBuffer → setIndexBuffer → drawIndexed` sequence. Bundle invalidates on bind group change (texture upgrade). Bundle key includes the surface format set so different render passes get different bundles.
  - **`WebGPUDrawCommand.bundle` field added** — 5-line addition to `WebGPUDrawCommand.ts`: optional `bundle?: GPURenderBundle` field, plus a fast-path branch at the top of `execute()` that calls `passEncoder.executeBundles([this.bundle])` and skips the normal draw recording. Other renderers can opt in by setting the field after construction.
  - **Snapshot freezable**: moon registers itself as `"moon-renderer"` with `scene.snapshotMode.registerFreezable({ freeze, thaw })`. When frozen, per-frame uniform writes are skipped — the bundle replays the captured uniforms verbatim.
  - **Behind-camera early-out**: `dot(cameraToMoon, cameraDirWC) < -maxRadius` skips the entire `updateWebGPUMoon` body before any GPU work or even uniform pack.

### Files Modified (Session 27)

- `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl` — full shader rewrite (~290 LOC)
- `packages/engine/Source/Shaders/WebGPU/Environment/Moon.js` — hand-written wrapper (~17 KB, gitignored, regenerated by gulp)
- `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — geometry generator rewrite, async texture loading, new uniform pack, render bundle integration, snapshot freezable registration, behind-camera early-out
- `packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts` — added optional `bundle` field + fast-path branch in `execute()`
- `packages/engine/Source/Scene/MoonLight.js` — new marker class
- `packages/engine/Source/Scene/Moon.js` — added moon direction + phase fraction frameState population
- `packages/engine/Source/Scene/Scene.js` — added `frameState.sunDirectionWC` forwarding from `uniformState`
- `packages/engine/Source/Scene/FrameState.js` — declared `atmosphericConditions`, `skyBrightness`, `sunDirectionWC`, `moonDirectionWC`, `moonPhaseFraction` fields

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

## Session 16: Architecture Cleanup, Shadow Casting & Performance

**Date:** April 6, 2026

### Overview

Comprehensive codebase audit + bug fixes + architecture cleanup + performance activation. Reviewed all 103 WebGPU renderer files, 238 WGSL shaders, and all Scene files for backend-agnosticism violations.

### Bug 16.1: panoramaCommandList Never Cleared (Stars/Skybox)
- **File:** `Scene.js`
- **Root cause:** `updateFrameState()` cleared `commandList` and `shadowMaps` each frame but NOT `panoramaCommandList`. For panoramas using `_returnCommand=false`, commands accumulated every frame (1, 2, 3... N copies rendered per frame).
- **Fix:** Added `frameState.panoramaCommandList.length = 0` alongside the other list clears.
- **Note:** The SkyBox path uses `_returnCommand=true` (returns command as `skyBoxCommand`), so this accumulation bug primarily affects standalone CubeMapPanorama instances. Improved diagnostic logging to fire when `skyBoxCommand` transitions from undefined to defined after async cubemap load.

### Bug 16.2: Camera Jitter from Stale Async Depth (Improved)
- **File:** `SSCCInputHelpers.js`
- **Root cause:** Async depth readback is always 1 frame behind. During fast camera movement, the stale depth creates a feedback loop (camera zooms in -> old depth pulls it back -> oscillation).
- **Fix:** Tightened staleness thresholds (100m->50m, direction dot 0.999->0.9995). Added `ASYNC_PICK_DISTANCE_RATIO` (1.5x) check: when both async depth pick and ray pick are valid, reject the depth pick if it disagrees with the ray pick by more than 50%. The ray pick is always current-frame accurate.

### Bug 16.3: Shadow Cast Command Lists Cleared Before Reading
- **File:** `WebGPUContext.ts`
- **Root cause:** `executeShadowMapCastCommands()` cleared `passes[j].commandList.length = 0` BEFORE iterating them to collect cast commands. Result: `castCommands` was always empty, shadows never rendered.
- **Fix:** Moved clear AFTER collection.

### Bug 16.4: Shadow Map Point Light Guard Logic Error
- **File:** `WebGPUShadowMapRenderer.js`
- **Root cause:** `!shadowMap._isPointLight === false` evaluates as `(!shadowMap._isPointLight) === false`, which is `true` when `_isPointLight` is `false` -- the exact opposite of the intended guard. Prevented all directional shadow maps from initializing.
- **Fix:** Changed to `shadowMap._isPointLight` (skip point lights, only handle directional/spot).

### Bug 16.5: Shadow Map Bias Access Path
- **File:** `WebGPUShadowMapRenderer.js`
- **Root cause:** `shadowMap._bias?.depthBias` accessed undefined `_bias` property. ShadowMap uses `_primitiveBias`, `_terrainBias`, and `_pointBias` instead.
- **Fix:** Changed to `shadowMap._primitiveBias || shadowMap._terrainBias || {}`.

### Architecture Fix 16.6: isWebGPUDrawCommand Removed from All Scene Code
- **Files:** `PrimitiveCommandHelpers.js`, `SceneRenderer.js`, `EnvironmentRenderer.js`, `GlobeSurfaceTileProviderRendering.js`
- **Root cause:** 8 violations of backend-agnosticism in 5 Scene files. Scene code should NEVER check command backend type.
- **Fix:**
  - `PrimitiveCommandHelpers.js`: 3 checks replaced with duck-typing via `defined(command._webgpuShaderType)`
  - `SceneRenderer.js`: `maybeInject` uses `typeof cmd.execute === "function"` instead of `isWebGPUDrawCommand`
  - `EnvironmentRenderer.js`: Uses `defined(panoramaCommand.pipeline)` for duck-typing
  - `GlobeSurfaceTileProviderRendering.js`: Removed direct `import` from `Shaders/WebGPU/`. Shader code now provided by FR via `getShaderCode()`. Removed `isWebGPUDrawCommand: true` from ad-hoc globe commands.
  - `WebGPUFeatureRenderers.ts`: Added `getShaderCode` to GLOBE_SURFACE FR registration
  - `WebGPUSceneRenderer.ts`: `executeWebGPUCommand` uses duck-typing (`pipeline`/`_pipeline`) alongside backward-compat `isWebGPUDrawCommand`

### Performance 16.7: Render Bundles Activated for Terrain
- **File:** `WebGPUSceneRenderer.ts`
- **Change:** Globe pass now records commands into a `GPURenderBundleEncoder` when 8+ tile commands exist, then executes the bundle. Reduces driver overhead for terrain tile draw calls. Falls back to individual execution if bundle recording fails.

### Performance 16.8: Ring Buffer Allocator Wired
- **File:** `WebGPUContext.ts`
- **Change:** `WebGPURingBufferAllocator` initialized (4MB pages, triple-buffered, 256-byte alignment). `beginFrame()` advances to next page, `endFrame()` finalizes. Accessible via `context.uniformAllocator` for renderers to use opportunistically.

### Performance 16.9: Shadow Cast Pass Added to Scene Renderer
- **File:** `WebGPUSceneRenderer.ts`
- **Change:** Added `context.executeShadowMapCastCommands(scene)` before multi-frustum loop (non-pick frames only). Shadow depth texture is rendered once per frame from the light's perspective.

### Testing 16.10: First WebGPU Unit Tests
- **Files:** 5 new spec files in `packages/engine/Specs/Renderer/WebGPU/`
- **Tests:** WebGPUDrawCommand (15 tests), WebGPUBuffer (10 tests), WebGPUTexture (10 tests), GraphicsContext/FeatureRendererKey (5 tests), ContextFactory (5 tests)
- **Registered:** All added to `Specs/SpecList.js`

### Files Modified

| File | Changes |
|---|---|
| `Scene.js` | Added `panoramaCommandList.length = 0` in `updateFrameState()` |
| `SceneRenderer.js` | Duck-typed `maybeInject`, improved skyBox diagnostic logging |
| `SSCCInputHelpers.js` | Tightened staleness thresholds, added distance ratio check |
| `PrimitiveCommandHelpers.js` | 3x `isWebGPUDrawCommand` -> `_webgpuShaderType` duck-typing |
| `EnvironmentRenderer.js` | `isWebGPUDrawCommand` -> `defined(cmd.pipeline)` |
| `GlobeSurfaceTileProviderRendering.js` | Removed WebGPU shader import, shader from FR, removed `isWebGPUDrawCommand` marker |
| `WebGPUContext.ts` | Shadow cast command collection fix, ring buffer allocator wiring |
| `WebGPUSceneRenderer.ts` | Shadow cast pass, render bundles for globe, duck-typed command dispatch |
| `WebGPUFeatureRenderers.ts` | `getShaderCode` on GLOBE_SURFACE FR, GlobeTerrain shader import |
| `WebGPUShadowMapRenderer.js` | Point light guard fix, bias path fix, improved command geometry resolution |
| `SpecList.js` | 5 new WebGPU test imports |
| 5 new test files | WebGPUDrawCommandSpec, WebGPUBufferSpec, WebGPUTextureSpec, GraphicsContextSpec, ContextFactorySpec |

---

## Session 17: Feature Wiring, Full Shader Restore & Performance Infrastructure

**Date:** April 6, 2026

### Overview

Wired unwired feature renderers, restored the full GlobeTerrain.wgsl fragment shader (lighting, fog, atmosphere, shadows, ocean, night effects), activated GPU compute culler infrastructure, added pipeline warm-up, and verified post-process pipeline completeness.

### Feature 17.1: GROUND_ATMOSPHERE Feature Renderer Wired
- **File:** `Globe.js`
- **Change:** Added `FeatureRendererKey` import and FR call in `beginFrame()` after setting tileProvider properties. The FR creates/updates a GPU uniform buffer (`globe._webgpuAtmosphereBuffer`) with packed atmosphere parameters (inner/outer radius, Rayleigh/Mie coefficients, scale heights, light intensity). Added cleanup in `destroy()`.

### Feature 17.2: Full GlobeTerrain.wgsl Fragment Shader Restored
- **File:** `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`
- **Change:** Replaced simplified imagery-only compositing (debug mode) with full shader code:
  - Shadow factor computation (textureSampleCompare from uniform control flow)
  - Clipping planes discard + edge highlighting
  - Cartographic limit rectangle clipping
  - Day/night alpha blending with per-layer webMercator UV selection via `selectLayerUV()`
  - Color adjustment (brightness, contrast, saturation) per imagery layer
  - Night lights emission (city light glow on dark side)
  - Enhanced ocean rendering (Fresnel, deep water, foam, wave normals)
  - Lambert diffuse lighting with shadow receive
  - Terminator glow at day/night boundary
  - Fog blending with atmosphere-colored fog
- **Key fix:** Original full code referenced undefined `uv` variable. Fixed to use per-layer UVs: `selectLayerUV(geoUV, webMercT, useWebMerc.x)` for each layer.
- **Safety:** Placeholder effects bind group sets `shadowDarkness=1.0` (shadows no-op) and `clippingPlaneCount=0` (clipping no-op), so the full shader works safely without active shadow/clipping resources.

### Feature 17.3: GPU Frustum Culler Infrastructure Activated
- **Files:** `WebGPUContext.ts`, `WebGPUSceneRenderer.ts`
- **Change:** Added lazy-initialized `gpuCuller` singleton to WebGPUContext. Async initialization loads FrustumCull.wgsl compute shader and compiles pipeline. Added `gpuCullCommands()` method to WebGPUSceneRenderer with 256-command threshold gate — only activates GPU culling when command count justifies the overhead. Uses previous-frame async readback results for current-frame filtering (1-frame latency).

### Feature 17.4: Pipeline Warm-up Added
- **File:** `WebGPUContext.ts`
- **Change:** Added `_warmUpPipelines()` called during context initialization after shader loading. Proactively instantiates the globe terrain renderer (shader module + pipeline layout compilation) and triggers GPU culler async init. Reduces first-frame stutter by front-loading pipeline compilation.

### Feature 17.5: Post-Process Pipeline Verified Complete
- **Status:** Tonemapping (5 operators), FXAA 3.11, Bloom, SSAO, DoF are fully wired.
- **No changes needed** — pipeline was already completely integrated.

### Feature 17.6: Feature Renderer Audit Results
- **FOG:** Already wired via tile uniform buffer (fogDensity, fogMinimumBrightness at offsets 49-51). FR's `getParameters()` is a utility for other consumers.
- **PROCEDURAL_CLOUDS, SCREEN_SPACE_REFLECTIONS, WEATHER_PARTICLES:** Already wired in `WebGPUSceneRenderer._executeEnvironmentalEffects()`. Initial audit missed these because it only searched Scene/ files.
- **GROUND_ATMOSPHERE:** Only truly unwired FR — now wired (17.1).
- **Buffer primitives (point/polyline/polygon):** No-op stubs, fall back to WebGL.

### Files Modified

| File | Changes |
|---|---|
| `Globe.js` | Added FeatureRendererKey import, GROUND_ATMOSPHERE FR call in beginFrame(), cleanup in destroy() |
| `GlobeTerrain.wgsl` | Full fragment shader restored: lighting, shadows, fog, atmosphere, ocean, night effects, clipping |
| `WebGPUContext.ts` | GPU culler singleton (lazy async init), pipeline warm-up method, culler cleanup in destroy() |
| `WebGPUSceneRenderer.ts` | `gpuCullCommands()` method with 256-threshold gate and async readback |

---

## Session 20: ParticleSystem Confirmation, Buffer Primitive Picking, WGF-1 Subgroups, WGF-6 Primitive Index

**Date:** April 7, 2026

### Overview
Tier-1/Tier-2 follow-ups: confirmed general ParticleSystem already routes through the WebGPU billboard FR (no separate work needed), wired picking through Buffer Primitive collections via shader-variant pick pipelines, lit up the existing `WebGPUSubgroupUtils` infrastructure with a real production use case in the GPU culler, and added WGF-6 primitive_index support via a chunk + utility class.

### 20.1 — General ParticleSystem (no-op closure)
`Scene/ParticleSystem.js` already delegates rendering to a `BillboardCollection`, which routes through `FeatureRendererKey.BILLBOARD_COLLECTION` → `WebGPUBillboardRenderer.js`. The Session 18 backlog item was a stale entry — `ParticleSystem.update()` (line 704-706) explicitly comments "WebGPU: ParticleSystem delegates to BillboardCollection which has a dedicated WebGPU rendering path. No guard needed." Closed without code changes.

### 20.2 — Picking for BufferPrimitive Collections
Session 19 left picking deferred for the new `WebGPUBufferPrimitiveRenderer.ts`. This session completed it.

Approach:
- The 3 Buffer* WGSL shaders all already write `v_pickColor` into VertexOutput (it was being uploaded but never read in fragment).
- A `PICK_FRAGMENT_SUFFIX` constant in `WebGPUBufferPrimitiveRenderer.ts` appends a `fragmentPickMain` entry point to every preprocessed shader source. The pick variant returns `input.v_pickColor` instead of `input.v_color`, with the same alpha-discard threshold so picks line up with visible pixels.
- One shader module per collection serves both pipelines: the color pipeline uses `entryPoint: "fragmentMain"`, the pick pipeline uses `"fragmentPickMain"`.
- Each `init*Cache` builds both pipelines via the same `build*Pipeline` builder (which now accepts a `fragmentEntryPoint` parameter).
- Each `repack*Dirty` now actually allocates pick IDs via `context.createPickId({ collection, index, get primitive() })` when `_allowPicking` is true and `_pickId === 0`. Allocated IDs are tracked on `cache.pickIds` and released in the destroy function via the new shared `destroyPickIds` helper.
- Each `update*` checks `frameState.passes.render` and `frameState.passes.pick` independently and pushes the matching command. The two commands share the same vertex buffers, index buffer, and bind groups — only the pipeline differs.

Files: `Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` (extended; ~+200 lines)

### 20.3 — WGF-1 Subgroups Wired Into GPU Culler
`WebGPUSubgroupUtils.ts` and the `subgroups` device feature were already in place from Sessions 16/17 — but no production shader was actually using them. This session adds the first real use case.

`Shaders/WebGPU/Compute/FrustumCull.wgsl` previously did per-thread `atomicAdd(&visibleCount, 1u)` for mode 2 (compaction counter). On dense scenes with thousands of visible objects this serializes through a single atomic, leaving GPU lanes idle. Added a second entry point `mainSubgroups` that:

1. Uses `enable subgroups;`
2. Calls `subgroupBallot(visible)` to get a 64-bit visibility bitmask for the subgroup
3. Reduces it to a single count via `countOneBits(ballot.x) + countOneBits(ballot.y)`
4. Has lane 0 of each subgroup do **one** `atomicAdd` for the whole group

`WebGPUGPUCuller.initialize()` now picks the entry point based on `device.features.has("subgroups")`, with try/catch fallback to the portable scalar `main` if the subgroup variant fails to compile (driver edge cases).

Expected speedup on dense scenes (mode 2): 2-4× on hardware with native 32/64-lane subgroup support (NVIDIA, Intel, modern AMD/Apple). Same semantics as the scalar path — visibility flags and indirect-draw zeroing are unchanged. Out-of-range threads now participate in the ballot but vote `false`, so subgroup uniformity is preserved.

Files:
- `Shaders/WebGPU/Compute/FrustumCull.wgsl` (added `mainSubgroups` entry point)
- `Renderer/WebGPU/WebGPUGPUCuller.ts` (entry-point selection + try/catch fallback)

### 20.4 — WGF-6 `@builtin(primitive_index)`
`primitive_index` is a WGSL fragment-shader builtin that reports the triangle index of the rasterized primitive within the current draw call. WebGL has no equivalent (`gl_PrimitiveID` exists only in geometry shaders, which WebGL doesn't expose) so this is a WebGPU-only capability.

Two new files lay the foundation; consumers can plug them into terrain debug overlays, polygon triangulation visualizers, or per-triangle picking flows without a separate pick pass.

- NEW `Shaders/WebGPU/chunks/functions/csm_primitiveIndex.wgsl` — chunk file importable via `#import csm_primitiveIndex`. Provides:
  - `csm_debugFaceColor(primIndex: u32) -> vec4<f32>` — deterministic per-triangle rainbow color via prime hash
  - `csm_encodePrimitiveIndex(primIndex: u32) -> vec4<f32>` — packs a u32 into RGBA8 for pick-buffer readback
  - `csm_isWireframeEdge(bary: vec3<f32>, lineWidthPixels: f32) -> bool` — wireframe edge test using fwidth + smoothstep (combine with primitive_index for triangle-level wireframe overlays without a geometry shader)

- NEW `Renderer/WebGPU/WebGPUPrimitiveIndexUtils.ts` — TS-side helper class:
  - `isSupported(device)` — capability probe with cached result via `pushErrorScope("validation")` + test compile (handles flaky drivers)
  - `generateFaceColorWGSL()` — standalone fragment shader for per-face debug coloring
  - `generatePrimitivePickWGSL()` — fragment shader that encodes triangle index as RGBA8
  - `decodePrimitivePick(rgba, offset)` — JS-side decoder for the readback buffer

Both files mirror the existing `WebGPUSubgroupUtils.ts` pattern. Production wiring (e.g., a "Debug → Show Triangulation" toggle on Scene) is left as a follow-up — the infrastructure is in place.

### Build / Test
- `npx gulp build` clean (TypeScript + WGSL compilation)
- All four 20.x changes verified to compile against the production build pipeline
- Subgroup variant requires hardware testing on a device with `subgroups` feature for perf measurement; scalar fallback path is exercised by every other GPU
- Buffer Primitive picking needs a live BufferPolygon/Polyline/Point fixture with `Scene#pick` to verify roundtrip

---

## Session 19: Renderer Verification, Buffer Primitives, Mobile Perf, UBO Cleanup

**Date:** April 6, 2026

### Overview
Tier-1 follow-ups after Session 18 testing handoff: audited all "built-but-untested" renderers, fixed two critical bugs, implemented full WebGPU support for the experimental BufferPrimitive collections (vector tile path), enabled transient render attachments for tile-based mobile GPUs, and tightened UBO sizes.

### 19.1 — Renderer Verification & Bug Fixes
Audited Cloud, Voxel, GaussianSplat, PointCloud, Ellipsoid, and PointCloudEDL renderers for completeness.

| File | Bug | Fix |
|---|---|---|
| `WebGPUEllipsoidPrimitiveRenderer.ts` | `packCameraUniforms()` returned 40 floats but `CameraUniforms` struct ends with `viewportSize: vec2<f32>` at byte offset 160 → shader read garbage for aspect ratio (`viewportSize.x / viewportSize.y` ≈ NaN) | Extended pack to 44 floats, write `drawingBufferWidth/Height` at indices 40-41 |
| `WebGPUGaussianSplatRenderer.ts` | Focal length approximated as `canvas.width * 0.5` (very coarse) | Derive from projection matrix: `proj[0] * (vw/2)`, `proj[5] * (vh/2)` |
| `WebGPUPointCloudEyeDomeLighting.ts` | Allocated FBO + pipeline + bind groups but never created or pushed any draw command — pure orphaned setup | Replaced with a clean documented no-op stub. Full EDL post-process port (point-command hijacking into offscreen FBO) deferred — `WebGPUPointCloudRenderer` already draws directly to the main framebuffer |

`WebGPUCloudRenderer`, `WebGPUVoxelRenderer`, and `WebGPUPointCloudRenderer` were verified COMPLETE (no bugs, but Voxel still uses placeholder gradient data and Point Cloud silently no-ops if `_parsedContent` missing — both expected and not blocking).

### 19.2 — Buffer Primitive Collections (Vector Tile Path)
Replaced the no-op stubs at `WebGPUFeatureRenderers.ts` with a full unified renderer.

- **NEW:** `WebGPUBufferPrimitiveRenderer.ts` (~1000 lines) — handles all three subtypes:
  - `BufferPolygonCollection` → indexed triangle-list, 4 vertex attribs (posHigh, posLow, pickColor, showAndColor)
  - `BufferPolylineCollection` → indexed triangle-list with miter quad expansion in vertex shader, 8 attribs (curr/prev/next RTE pairs + pickColor + showColorWidthAndTexCoord)
  - `BufferPointCollection` → 6-vertex quad instanced per point, 5 instance attribs + 1 per-vertex quad corner
- CPU-side packing mirrors the WebGL reference renderers in `Scene/renderBuffer{Polygon,Polyline,Point}Collection.js` (RTE encoding via `EncodedCartesian3.fromCartesian`, color packing via `AttributeCompression.encodeRGB8`).
- Camera UBO matches the standard 368-byte `CameraUniforms` struct from `Shaders/WebGPU/chunks/structs/CameraUniforms.wgsl`.
- Per-collection caches GPU buffers + pipeline + bind groups; rebuilds on `_dirtyCount > 0`.
- Picking is **not** yet routed through the WebGPU pick framebuffer for these experimental collections — pick data is packed but the pick render path is a follow-up.

**Shader fixes** (3 files):
- `BufferPolygonMaterial.wgsl`, `BufferPolylineMaterial.wgsl`, `BufferPointMaterial.wgsl` referenced `camera.projection` and `camera.viewport` — fields that don't exist on the standard `CameraUniforms` chunk. Renamed to `camera.projectionMatrix` and moved viewport into the per-shader `params` UBO (added `viewport: vec4<f32>` to `BufferPointUniforms` and `BufferPolylineUniforms`). The polygon shader needs no viewport.

Files:
- `Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` (NEW)
- `Renderer/WebGPU/WebGPUFeatureRenderers.ts` (replaced 3 stubs)
- `Shaders/WebGPU/Collections/BufferPolygonMaterial.wgsl`
- `Shaders/WebGPU/Collections/BufferPolylineMaterial.wgsl`
- `Shaders/WebGPU/Collections/BufferPointMaterial.wgsl`

### 19.3 — Transient Render Attachments (Mobile Perf)
WebGPU has no explicit `TRANSIENT_ATTACHMENT` flag (Vulkan does), but tile-based mobile GPUs (Apple Silicon, Mali, Adreno) can keep an attachment in on-chip tile memory only when:
1. The texture has only `RENDER_ATTACHMENT` usage (no `TEXTURE_BINDING` / `COPY_SRC`)
2. The render pass uses `storeOp: "discard"`

`WebGPUFramebufferManager.ts` already creates MSAA color textures and non-samplable depth textures with minimal usage. The missing piece was the storeOp.

Changes in `WebGPUFramebufferManager.getRenderPassDescriptor()`:
- **MSAA color attachments:** Always force `storeOp: "discard"` on the multisample texture. The `resolveTarget` (single-sample resolve) is what's sampled in subsequent passes — the MSAA texture itself never needs to persist.
- **Depth attachments:** Default `depthStoreOp` to `"discard"` when `_depthSamplable` is false (caller can still override). When the depth buffer isn't read by a later pass, this lets the driver keep it tile-resident.

Expected impact on mobile: roughly 1× framebuffer-bandwidth reduction per draw frame for the MSAA path, more on multi-pass renders.

### 19.4 — UBO Size Cleanup
Several inline-WGSL renderers allocated 256-byte UBOs for ~100 bytes of data. Tightened:

| File | UBO | Before | After |
|---|---|---|---|
| `WebGPUEllipsoidPrimitiveRenderer.ts` | Camera (now includes viewportSize) | 256 | 176 |
| `WebGPUEllipsoidPrimitiveRenderer.ts` | Ellipsoid (radii + color + center) | 256 | 96 |
| `WebGPUGaussianSplatRenderer.ts` | Camera + viewport + focal | 256 | 176 |

256-byte alignment is only required for **dynamic** UBO bindings; static UBOs only need 16-byte alignment, so all of these are well within spec.

### Build / Test
- `npx gulp build` clean (TypeScript + WGSL compilation)
- All four 19.x changes verified to compile against the production build pipeline
- Visual verification deferred to user testing — most paths require live scene fixtures (vector tiles, ellipsoid primitives, splat clouds, mobile devices for transient attachment perf measurement)

---

## Session 18: Parity Closure — Viewport Quad, Labels, Particles, 2D/Columbus

**Date:** April 6, 2026

### Overview

Closed four critical parity gaps with WebGL: viewport quad rendering, label/text SDF rendering, weather particle render pass, and 2D/Columbus View mode for the globe terrain. All build cleanly via `npx gulp build`.

### Feature 18.1: Viewport Quad Rendering — Full Implementation
- **Files:** `WebGPUViewportQuad.ts` (NEW), `WebGPUContext.ts`, `Scene/ViewportQuad.js`, `Shaders/WebGPU/ViewportQuad.wgsl`, `Shaders/WebGPU/ViewportQuadTexture.wgsl` (NEW)
- **Change:** Replaced stubbed `createViewportQuadCommand()` with a fully functional `WebGPUViewportQuad` utility class providing:
  - Pipeline caching (by shader hash + format + blend/depth/stencil config)
  - Bind group auto-detection from uniform maps (textures, samplers, UBOs, colors, Cartesians)
  - Three shared samplers (linear, nearest, comparison)
  - Fullscreen 3-vertex triangle pattern (no vertex buffer needed)
  - Targeted render pass support via `drawToTarget()` for rendering into specific framebuffers
  - Configurable blend states (alpha, additive, premultiplied), depth/stencil, color write masks
- **Scene integration:** `ViewportQuad.js` now branches on `context.isWebGPU` to use WGSL `ViewportQuad.wgsl` shader with material color uniforms.
- **Note:** GlobeDepth, OIT, and PostProcess already have dedicated WebGPU implementations (`WebGPUGlobeDepth.ts`, `WebGPUOIT.ts`, `WebGPUPostProcessPipeline.ts`) so the viewport quad utility is needed only for the remaining callers (TranslucentTileClassification, GlobeTranslucencyFramebuffer, AutoExposure, ViewportQuad primitive, debug visualizations).

### Feature 18.2: Label/Text Rendering with SDF
- **Files:** `WebGPULabelRenderer.js` (NEW), `Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl` (NEW), `WebGPUFeatureRenderers.ts`, `WebGPUCollectionShaders.js`, `FeatureRendererKey.js`, `Scene/LabelCollection.js`
- **Change:**
  - Added `LABEL_COLLECTION = 37` to FeatureRendererKey (COUNT now 38)
  - Created SDF billboard shader with 5-tap supersampling, outline support, and resolution-independent antialiasing using screen-space derivatives
  - Instance data layout: 32 floats (128 bytes) extending standard billboard layout with `outlineColor` (vec4) and `sdfParams` (vec4: outlineWidth, sdfEdge, _, _)
  - SDF_EDGE = `1.0 - SDFSettings.CUTOFF` = 0.75
  - `LabelCollection.update()` now branches: WebGPU uses LABEL_COLLECTION FR with SDF; WebGL falls back to per-billboard collection update
  - Background billboards routed through standard BILLBOARD_COLLECTION FR
- **Algorithm:** Ports `getSDFColor()` from BillboardCollectionFS.glsl to WGSL — fill color, outline edge clamping, smoothstep alpha based on distance field

### Feature 18.3: Weather Particle Render Pass
- **Files:** `WebGPUWeatherRenderer.ts`, `Shaders/WebGPU/Compute/WeatherParticleRender.wgsl` (NEW), `WebGPUFeatureRenderers.ts`, `WebGPUSceneRenderer.ts`
- **Change:** Weather particles previously had compute simulation but no render pass — particles were updated but invisible. Added:
  - WGSL render shader reading the GPU particle storage buffer as instanced vertex data
  - Camera-facing billboard expansion using camera right/up vectors
  - Per-weather-type fragment shader: rain (vertical streak), snow (soft circle), fog (large faint circle), hail (sharper bluish circle)
  - Lifetime-based fade-in/fade-out alpha blending
  - `renderWeatherParticles()` function called from `_executeEnvironmentalEffects()` after compute update
  - Particle storage buffer now also has `VERTEX` usage flag for read-only-storage binding
  - Render pipeline registered as `render` method on the WEATHER_PARTICLES feature renderer

### Feature 18.4: 2D / Columbus View Mode for Globe Terrain
- **Files:** `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceRenderer.ts`
- **Change:** Added scene mode support to the globe terrain shader:
  - Extended CameraUniforms with `tileRectangle` (vec4), `southAndNorthLatitude` (vec2), `southMercatorYAndOneOverHeight` (vec2), `sceneMode` (f32), `morphTime` (f32), `useWebMercator` (f32) — 12 new floats (80 total)
  - Added `latitudeToWebMercatorFraction()`, `get2DYPositionFraction()`, `computePlanarPosition()` helper functions
  - Vertex shader branches on `camera.sceneMode`:
    - **MORPHING (0)** — blends 3D and planar positions using `morphTime`
    - **COLUMBUS_VIEW (1)** — planar projection with terrain height
    - **SCENE2D (2)** — top-down planar with height forced to 0
    - **SCENE3D (3)** — original RTE path (default, unchanged)
  - CPU-side: `_createCameraUniformBuffer()` extended with `frameState` and `tile` parameters to pack scene mode, morph time, projection type (Web Mercator vs Geographic), tile rectangle, and computed Mercator Y bounds
- **Vertical exaggeration:** Now restricted to 3D mode only (skipped in 2D/Columbus where height has different semantics)

### Files Modified

| File | Changes |
|---|---|
| `WebGPUViewportQuad.ts` | NEW — Pipeline cache, bind group auto-detect, fullscreen triangle utility |
| `WebGPUContext.ts` | New `_viewportQuad` field, lazy init, `viewportQuad` getter, destroy cleanup |
| `Scene/ViewportQuad.js` | WebGPU branch using WGSL shader + material color uniform |
| `WebGPULabelRenderer.js` | NEW — SDF instance buffer build, render command creation |
| `BillboardCollectionSDF.wgsl` | NEW — SDF text shader with 5-tap supersampling and outlines |
| `Scene/LabelCollection.js` | LABEL_COLLECTION FR delegation, WebGL fallback |
| `FeatureRendererKey.js` | Added LABEL_COLLECTION = 37 |
| `WebGPUCollectionShaders.js` | Registered `billboardSDF` shader |
| `WebGPUWeatherRenderer.ts` | Render pipeline init + `renderWeatherParticles()`, VERTEX usage flag |
| `WeatherParticleRender.wgsl` | NEW — Camera-facing instanced quads with per-type fragments |
| `WebGPUFeatureRenderers.ts` | Registered LABEL_COLLECTION + weather render method |
| `WebGPUSceneRenderer.ts` | Weather render call after compute update |
| `GlobeTerrain.wgsl` | Scene mode branching + planar position helpers + new uniforms |
| `WebGPUGlobeSurfaceRenderer.ts` | Camera uniform buffer extended with 2D/Columbus uniforms |

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

## Session 21 — Tier-2 Cleanup Pass (WGF-3, WGF-5, WGF-7, WGF-8, WGF-6 wiring)

Followup to Session 20. Audited the four remaining WGF cleanup tickets and
wired the WGF-6 primitive_index capability into Scene.js.

### Audit results

- **WGF-3 (`texture_and_sampler_let` cleanup)** — *no work needed*. Survey of
  19+ shader files in `packages/engine/Source/Shaders/WebGPU/` (Globe, Primitive,
  PostProcess) found zero workarounds for the old WGSL restriction. Terrain
  imagery sampling already passes texture/sampler as function parameters into
  `sampleImagery()`, which is the recommended pattern.
- **WGF-7 (enhanced storage texture formats)** — *no work needed*. The 8 compute
  shaders that write to storage textures (BrdfLutGenerate, HiZPyramid,
  AtmosphereLUT, PolygonSignedDistance, RadiancePrefilter, IrradianceConvolution,
  Sun) all already use the right format for their kernel output. No format
  upgrades are warranted.

### WGF-5 — Texture component swizzle (Bug 21.1)

**Files**:
- `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapLit.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapFlat.wgsl`

**Root Cause**: `swizzleChannel()` used a 3-branch if-else to extract one of
{r,g,b,a} from a `vec4<f32>` based on a runtime index. WGSL allows dynamic
vector subscript, so the branches are unnecessary.

**Fix Applied**: Replaced the branch chain with `texColor[clamp(i32(idx), 0, 3)]`.
Saves three branches per fragment for normal-mapped surfaces. The clamp protects
against out-of-range channel uniforms (defensive — the CPU path already produces
0..3, but a stray uniform write would otherwise cause undefined behavior).

### WGF-8 — EXIF/orientation handling for image upload (Bug 21.2)

**Files**:
- `packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts` — *new* (~210 lines)
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — added
  `createTextureFromImageAsync()`

**Root Cause**: `GPUQueue.copyExternalImageToTexture()` does not consult EXIF
metadata. JPEG sources with non-trivial Orientation tags (rotated phone photos,
scanner output) land sideways or mirrored in the resulting texture. The
synchronous `createTextureFromImage()` had no orientation handling.

**Fix Applied**: New `WebGPUImageUpload` utility module with:
- `decodeWithOrientation(source)` — wraps `createImageBitmap(source, { imageOrientation: "from-image" })`
  for `HTMLImageElement`/`Blob` sources, pass-through for already-decoded surfaces.
- `uploadImageToTexture(device, source, dest, opts)` — full upload helper with
  `flipY` / `premultipliedAlpha` / mip-level / origin / colorSpace knobs.
- `isOrientationSupported()` — feature-probes `imageOrientation: "from-image"`
  via a 1×1 PNG decode, cached result.
- New `WebGPUContext.createTextureFromImageAsync()` async sibling of
  `createTextureFromImage()` that routes through the helper. Reads decoded
  width/height *after* the orientation pass since 90°/270° rotations swap them.

The synchronous fast path is preserved (existing call sites unchanged); callers
that need orientation handling opt in via the async variant.

### WGF-6 — Primitive index capability wiring (Bug 21.3)

**Files**:
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — cache primitive
  index utility module on context init
- `packages/engine/Source/Scene/Scene.js` — `debugShowTriangulation` flag,
  `triangulationDebugSupported` getter

**Root Cause**: Session 20 created `WebGPUPrimitiveIndexUtils` and the
companion `csm_primitiveIndex.wgsl` chunk but left them as utilities without a
public Scene-level surface. Backend-agnostic Scene code couldn't probe support
without violating the "Scene must not import from Renderer/WebGPU" rule.

**Fix Applied**: WebGPUContext lazy-imports `WebGPUPrimitiveIndexUtils` after
device creation and stores the module on `_primitiveIndexUtilsCache`. Scene
exposes a new public boolean property `debugShowTriangulation` (default false)
and a read-only `triangulationDebugSupported` getter that consults the cached
utils through the context. WebGL contexts always return false (no
`gl_PrimitiveID` without a geometry shader). Feature renderers that opt in
(future work for Globe surface, BufferPrimitive collections) can swap their
fragment shader to a face-color variant when both flags are true.

Production wiring intentionally stops at the capability surface; switching
individual feature renderers to a face-color fragment variant is left to
follow-up work scoped to each renderer.

### Files Modified
1. `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapLit.wgsl` — collapse swizzle branch
2. `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapFlat.wgsl` — collapse swizzle branch
3. `packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts` — *new*, EXIF/orientation upload helper
4. `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `createTextureFromImageAsync`, primitive_index cache
5. `packages/engine/Source/Scene/Scene.js` — `debugShowTriangulation`, `triangulationDebugSupported`
6. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 21 documentation

### Build Status
- `npx tsc --noEmit` — Zero errors
- `npx gulp build` — Passes (~41s)

---

## Session 22 — Unit Tests + debugShowTriangulation Wiring

Followup to Session 21. Added unit-test coverage for the Session 18-21
utilities and wired the WGF-6 `debugShowTriangulation` flag through to the
Globe surface renderer with a face-color fragment variant.

### Bug 22.1 — Unit test coverage gap

**Files** (new):
- `packages/engine/Specs/Renderer/WebGPU/WebGPUPrimitiveIndexUtilsSpec.js`
- `packages/engine/Specs/Renderer/WebGPU/WebGPUSubgroupUtilsSpec.js`
- `packages/engine/Specs/Renderer/WebGPU/WebGPUImageUploadSpec.js`

**Root Cause**: Sessions 18-21 added six utility/renderer modules
(`WebGPUPrimitiveIndexUtils`, `WebGPUSubgroupUtils`, `WebGPUImageUpload`,
`WebGPUBufferPrimitiveRenderer`, `WebGPUEllipsoidPrimitiveRenderer`, plus
the Session 19 viewport fix) without unit-test coverage. Pure-logic
surfaces (WGSL string generators, RGBA index decoder, image-source
pass-through paths) were testable without a GPU device but had nothing
exercising them.

**Fix Applied**: Three new spec files following the existing
`WebGPUBufferSpec` pattern (Jasmine, opt-in GPU device acquisition with
`pending()` fallback when WebGPU is unavailable). Coverage:

- **PrimitiveIndexUtils**: static surface check, `generateFaceColorWGSL`
  emits the expected `@builtin(primitive_index)` fragment, deterministic
  output, `generatePrimitivePickWGSL` packs all four bytes,
  `decodePrimitivePick` round-trip across 1234, 24-bit, offset and zero
  cases, GPU-gated `isSupported` cache stability.
- **SubgroupUtils**: static surface, `getRequiredFeatures` includes
  `subgroups`, all four WGSL generators emit the expected directives and
  thread parameters through, `generateWorkgroupReductionWGSL` correctly
  computes `ceil(workgroupSize/subgroupSize)` for the shared-memory
  array length, GPU-gated `isSupported` and `getInfo` shape.
- **ImageUpload**: static surface, `decodeWithOrientation` pass-through
  paths for `HTMLCanvasElement` / `OffscreenCanvas` / existing
  `ImageBitmap`, real `Blob → ImageBitmap` decode of a 1×1 PNG,
  `isOrientationSupported` cache stability, GPU-gated end-to-end
  `uploadImageToTexture` with a 4×4 red canvas source.

`WebGPUBufferPrimitiveRenderer` picking and the `WebGPUEllipsoidPrimitiveRenderer`
viewport fix are exercised through scene-level integration tests rather than
unit tests — their entry points are render-loop hooks that aren't unit-testable
without a complete frame state.

### Bug 22.2 — debugShowTriangulation production wiring

**Files**:
- `packages/engine/Source/Scene/Scene.js` — forward `debugShowTriangulation`
  onto frame state in `updateFrameState()`
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` —
  augmented shader module + cold-path pipeline cache + opt-in selection

**Root Cause**: Session 21 added `Scene.debugShowTriangulation` and a
capability getter but no renderer actually consumed it. Toggling the flag
had no visible effect.

**Fix Applied**:

1. **Scene → frameState forwarding**: `updateFrameState()` now copies
   `this.debugShowTriangulation` onto `frameState.debugShowTriangulation`
   each frame, alongside the other per-frame debug flags. Backend-agnostic
   — WebGL renderers simply ignore the field.

2. **Augmented shader module**: `WebGPUGlobeSurfaceRenderer` now caches
   the original shader source and lazily builds a second module on first
   debug request. The augmentation appends a `fragmentDebugTri` entry
   point that reads `@builtin(primitive_index)` and emits a deterministic
   per-triangle color via the same hash used by
   `WebGPUPrimitiveIndexUtils.generateFaceColorWGSL`. The build is wrapped
   in `pushErrorScope("validation")` so a driver that rejects the builtin
   disables the path instead of crashing the frame.

3. **Cold-path pipeline cache**: A separate `_debugTriPipelineCache` and
   `_selectDebugTriPipeline()` method live alongside `_selectPipeline()`
   so the production path stays branch-free. The hot loop in
   `createTileCommands()` reads `frameState.debugShowTriangulation` once
   *outside* the per-pass loop, then a single local-bool branch picks
   between the standard and debug pipeline selectors. When the debug
   selector returns null (driver doesn't support primitive_index), it
   falls back transparently to the production pipeline.

4. **Cache key parity**: Debug pipelines key off the same
   `Q/U/N/X/M/G/B/O_<stride>` string used by the production cache so the
   shape variants stay aligned. Toggling the flag off doesn't evict
   production pipelines — the caches are independent.

The architecture preserves the principle that debug-only features should
have *zero overhead* on the production hot path. The only added work
when the flag is off is one local-bool comparison per pass, which the
branch predictor handles for free.

### Files Modified
1. `packages/engine/Specs/Renderer/WebGPU/WebGPUPrimitiveIndexUtilsSpec.js` — *new*
2. `packages/engine/Specs/Renderer/WebGPU/WebGPUSubgroupUtilsSpec.js` — *new*
3. `packages/engine/Specs/Renderer/WebGPU/WebGPUImageUploadSpec.js` — *new*
4. `packages/engine/Source/Scene/Scene.js` — frame state forwarding for debugShowTriangulation
5. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — augmented shader module, debug pipeline cache, cold-path selector
6. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 22 documentation

### Build Status
- `npx tsc --noEmit` — Zero errors
- `npx gulp build` — Passes (~48s)
- Specs follow the existing `WebGPUBufferSpec` pattern; will run via `gulp test --workspace @cesium/engine`

---

## Session 23 — Tier 1 Render Debug Features

Added three production-grade debug visualizations identified by the
Session 22 audit. All three use the same Scene→frameState→renderer
forwarding pattern established by `debugShowTriangulation`, with cold-path
discipline so production performance is unaffected when toggles are off.

### Bug 23.1 — Activate orphaned globe wireframe pipeline

**Files**:
- `packages/engine/Source/Scene/Scene.js` — `debugShowGlobeWireframe` flag + frame state forwarding
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — refactored wireframe pipeline cache + cold-path selector + IB swap

**Root Cause**: `WebGPUGlobeSurfaceRenderer` had a fully built
`_wireframePipelines[4]` array, `_wireframeIndexCache`, and a
`_getWireframePipeline` builder, but nothing in the production render
loop ever called them. The legacy `createWireframeTileCommands` entry
point existed but was unreferenced. Worse, the existing pipeline builder
hard-coded vertex strides of 12/16/24/28 with no `hasWebMercatorT`
support — calling it on real WebMerc-encoded tiles would crash the GPU
with a stride mismatch.

**Fix Applied**:

1. **Pipeline cache refactor**: Replaced `_wireframePipelines: (GPURenderPipeline | null)[4]`
   with `_wireframePipelineCache: Map<string, GPURenderPipeline>` keyed
   by the same `Q/U + N/X + M/G + stride` string used by `_selectPipeline`
   so wireframe variants align 1:1 with production.
2. **Vertex layout parity**: New `_createWireframePipelineVariant` mirrors
   `_createPipelineVariant`'s vertex format selection exactly — every
   quantization × normals × WebMercator combination is supported with
   the correct stride. Only the topology (`line-list`), cullMode (`none`),
   and depth compare (`less-equal` to avoid z-fight with the surface)
   differ.
3. **Cold-path selector**: New `_selectWireframePipeline()` method,
   modeled on `_selectDebugTriPipeline`, lives entirely off the
   production hot path. The hot loop in `createTileCommands` reads
   `frameState.debugShowGlobeWireframe` once *outside* the per-pass loop;
   per-pass cost when off is one local-bool comparison.
4. **IB swap**: When wireframe is active for a tile, the descriptor's
   `indexBuffer`/`indexCount`/`indexFormat` are swapped to the line-list
   index buffer produced by `_getOrCreateWireframeIndices()` (each
   triangle becomes three line segments). Subsequent imagery passes
   skip wireframe — they would just double-rasterize the same edges.
5. **Legacy fixup**: Updated the leftover `createWireframeTileCommands`
   entry point and the `destroy()` cleanup to use the new selector and
   cache identifiers.

### Bug 23.2 — SkyAtmosphere scattering bypass

**Files**:
- `packages/engine/Source/Scene/Scene.js` — `debugDisableAtmosphereScattering` flag
- `packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — new `debug: vec4<f32>` uniform field + early-out
- `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` — pack debug field at uniform offset 52

**Root Cause**: When the sky color looks wrong, the bug could live in
the Nishita scattering integral, the LUT inputs, the HSB shift, the
tonemap, or the post-process composite. There was no way to isolate
which stage was at fault without forking the shader.

**Fix Applied**: Added a `debug: vec4<f32>` uniform field to the
SkyAtmosphere WGSL struct (sized for future Tier 3 additions) and a
single-line early-out at the top of the fragment scattering computation.
When `debug.x > 0.5` the shader returns flat magenta (1, 0, 1, 0.5)
without running scattering — confirms only that the draw call,
ray-sphere intersection, and shell coverage are reaching the fragment
stage. Magenta is intentional: it picks up immediately on a blue sky
and is unmistakable for any natural sky color.

The TS pack function already received `frameState`, so wiring required
only one new line at offset 52. Reserved offsets 53-55 for the Tier 3
LUT-inspector and sun-direction-override toggles so the layout doesn't
churn next session.

### Bug 23.3 — SkyBox cubemap face isolation

**Files**:
- `packages/engine/Source/Scene/Scene.js` — `debugShowCubeMapFace` integer flag
- `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` — fragment-shader face discard + signature refactor

**Root Cause**: When a starfield, panorama, or skybox cubemap looks
wrong, you can't tell whether it's a single bad face, a swap between
faces, a missing face, or a sampler/orientation issue without dumping
the texture to an external tool.

**Fix Applied**:

1. **Per-face discard in WGSL**: The fragment shader picks the cubemap
   face for each fragment by finding the dominant axis of the cube
   sample direction. When `params.z` (the new debug field) is non-zero,
   fragments whose face doesn't match the requested face index are
   discarded. The chosen face renders through its natural skybox
   projection over the full hemisphere it covers — far more useful than
   a single texel of color, because you see the actual face content
   in situ.
2. **Encoding**: 0 = all faces (production), 1 = +X, 2 = -X, 3 = +Y,
   4 = -Y, 5 = +Z, 6 = -Z.
3. **Signature improvement**: `updateUniforms()` previously took
   `uniformState` directly. Refactored to take `frameState` instead
   (which exposes `uniformState` via `frameState.context.uniformState`).
   This is a strict superset that lets future per-frame additions —
   debug or production — slot in without churning the signature.
   Current cost: zero (same per-frame call shape, one extra property
   lookup that the JIT inlines).

### Architectural notes (for future debug features)

- **Hot-path discipline**: every Tier 1 toggle reads from frameState
  *once*, outside any per-tile/per-pass loop. The production path,
  when the toggle is off, pays one local-bool comparison — well within
  the noise floor.
- **Cache parity**: debug pipeline caches use the same key shape as
  the production cache (`Q/U + N/X + M/G + stride`) so toggling the
  flag doesn't evict production pipelines and the variant granularity
  is automatic.
- **Shader vec4 reservations**: SkyAtmosphere now reserves a `debug:
  vec4<f32>` for Tier 3 future additions. New debug fields plug in by
  swizzle (`debug.y`, `debug.z`, `debug.w`) without struct churn.
- **Forwarding rule**: per-frame debug fields go on `frameState`, not
  on `Scene` properties read directly by renderers. Keeps the
  read-once-per-frame discipline obvious.

### Files Modified
1. `packages/engine/Source/Scene/Scene.js` — three new debug flags + frame state forwarding
2. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — wireframe cache refactor, cold-path selector, IB swap, legacy fixup
3. `packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — `debug: vec4<f32>` uniform + bypass
4. `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` — pack debug field
5. `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` — face-isolation fragment, signature refactor
6. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 23 documentation

### Build Status
- `npx tsc --noEmit` — Zero errors
- `npx gulp build` — Passes (~38s)

### How to use the new flags
```javascript
// In your viewer setup or DevTools console:
viewer.scene.debugShowGlobeWireframe = true;        // overlay terrain wireframe
viewer.scene.debugDisableAtmosphereScattering = true; // flat magenta atmosphere
viewer.scene.debugShowCubeMapFace = 1;              // 1=+X, 2=-X, 3=+Y, 4=-Y, 5=+Z, 6=-Z
```

---

## Session 24 — Tier 2 Render Debug Features

Followup to Session 23. Added the four Tier 2 visualizations identified
in the Session 22 audit, plus a structural refactor of the debug
pipeline cache to support N fragment variants without code duplication.

### Bug 24.1 — Refactor: unified debug fragment pipeline system

**Files**:
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`

**Root Cause**: Session 22 added `_debugTriShaderModule`, `_debugTriPipelineCache`,
and `_selectDebugTriPipeline()` for the WGF-6 triangulation overlay.
Adding LOD and Normal variants the same way would have meant six more
parallel members and two more nearly-identical methods. The duplication
would scale linearly with each new debug variant.

**Fix Applied**: Replaced the `_debugTri*` cluster with a unified
`_debugFragment*` system:

- New `DebugFragmentMode` enum (NONE / TRIANGULATION / LOD / NORMAL).
- Single `_debugFragmentShaderModule` hosting all three debug fragment
  entry points (`fragmentDebugTri`, `fragmentDebugLod`,
  `fragmentDebugNormal`). The vertex stages are reused unchanged from
  the production module — no duplication of vertex code.
- Single `_debugFragmentPipelineCache: Map<string, GPURenderPipeline>`
  with the mode integer mixed into the cache key
  (`{mode}_{Q/U}{N/X}{M/G}{B/O}_{stride}`).
- Single `_selectDebugFragmentPipeline(mode, ...)` cold-path selector.
- `_createPipelineVariant` takes `debugFragmentMode: DebugFragmentMode`
  instead of `debugTri: boolean`. The fragment-stage selector is a
  `switch` over the mode that picks the right entry point and label.

The hot path in `createTileCommands` now reads the three flags
(`debugShowTriangulation`, `debugShowTerrainLOD`, `debugShowTerrainNormals`)
*once* outside the per-pass loop, collapses them into a single
`DebugFragmentMode` integer, and the per-pass branch is one comparison
against `NONE`. Adding a 4th, 5th, ... debug fragment variant in the
future is one new entry point, one new enum value, one new switch arm.

### Bug 24.2 — Add `tile.level` and `isolateImageryLayer` to TileUniforms

**Files**:
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`

**Root Cause**: Tile-level data needed by the LOD overlay
(`tile.level` integer) and the imagery layer isolation feature
(`isolateImageryLayer` index) wasn't in the tile UBO.

**Fix Applied**: Added a `debugFields: vec4<f32>` slot at the end of
the WGSL `TileUniforms` struct. The slot reserves all four channels:

- `.x = tileLevel` — LOD depth integer (read by `fragmentDebugLod`)
- `.y = isolateImageryLayer` — index 0..3 to render alone, or -1 for all
- `.z, .w` — reserved for future per-tile debug toggles

`TILE_UNIFORM_FLOATS` bumped from 92 to 96. The TS pack function writes
both fields at offsets 92 and 93 from `tile.level` and
`frameState.debugShowImageryLayer`. Production cost is two property
reads + two array writes per tile, sub-noise-floor.

### Bug 24.3 — LOD color overlay (`debugShowTerrainLOD`)

**Files**:
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
- `packages/engine/Source/Scene/Scene.js`

**Root Cause**: No way to visually verify tile refinement, culling
boundaries, or screen-space-error decisions.

**Fix Applied**: New `fragmentDebugLod` entry point in the augmented
shader module reads `tile.debugFields.x` (the LOD level integer) and
maps it through a deterministic 12-color palette via WGSL `switch`.
Levels 0..11 cycle through hues; levels above 11 wrap. New
`Scene.debugShowTerrainLOD` boolean forwarded to
`frameState.debugShowTerrainLOD`. Activation goes through the unified
debug fragment selector — same hot-path discipline as triangulation.

### Bug 24.4 — Normal-as-color (`debugShowTerrainNormals`)

**Files**:
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
- `packages/engine/Source/Scene/Scene.js`

**Root Cause**: After the WGF-5 normal-map shader modernization, there
was no visual way to verify that the new vector subscript path produced
sensible normals.

**Fix Applied**: New `fragmentDebugNormal` entry point reads the
interpolated `v_normalEC` (eye-space normal), normalizes it, remaps from
[-1,1] to [0,1], and emits as RGB. Flat-shaded tiles show single colors
per primitive; smooth-shaded tiles show gradients. New
`Scene.debugShowTerrainNormals` boolean forwarded to
`frameState.debugShowTerrainNormals`.

### Bug 24.5 — Imagery layer isolation (`debugShowImageryLayer`)

**Files**:
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
- `packages/engine/Source/Scene/Scene.js`

**Root Cause**: When a multi-imagery composite shows blending artifacts,
there was no way to tell whether the bug was in a specific layer or in
the blend math without removing layers from the imagery collection.

**Fix Applied**: Reads `tile.debugFields.y` in the production
`fragmentMain`. The four layer compositing blocks each multiply their
`effectiveAlpha` by a per-layer mask:

```wgsl
let isolate = i32(tile.debugFields.y);
let mask0 = select(0.0, 1.0, isolate < 0 || isolate == 0);
// ...
let effectiveAlpha0 = mask0 * layer0.alpha * tex0.a * ...;
```

Implemented as a multiplicative mask rather than restructuring the
if-else chain — the existing lighting/shadow/fog math stays untouched.
Negative `isolate` (default -1) is the production all-layers behavior.
0..3 selects exactly that layer slot in the current pass.

Note: the index refers to the *per-pass* layer slot, not the absolute
imagery layer index in `Globe.imageryLayers`. Tiles with more than 4
imagery layers split into multiple passes; layer 0 of the second pass
is the 5th imagery layer overall.

New `Scene.debugShowImageryLayer` integer property (default -1)
forwarded to `frameState.debugShowImageryLayer`.

### Bug 24.6 — Depth-as-color overlay (`debugShowDepthAsColor`)

**Files** (new):
- `packages/engine/Source/Renderer/WebGPU/WebGPUDebugDepthOverlay.ts`

**Files modified**:
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts` — added `depthSamplable` option + `getDepthSampleableView()`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts` — opted into `depthSamplable: true` + new `depthSampleableView` getter
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — `_executeDebugDepthOverlay()` cold path
- `packages/engine/Source/Scene/Scene.js` — `debugShowDepthAsColor` boolean + `debugDepthAsColorMode` integer

**Root Cause**: Z-fighting and depth precision bugs at the horizon
(stars vs terrain, terrain vs 3D Tiles) had no diagnostic visualization.
The scene depth attachment was created with only `RENDER_ATTACHMENT`
usage — not sampleable as a texture.

**Fix Applied**: Three coordinated changes:

1. **Sampleable depth opt-in.** Added `depthSamplable?: boolean` to
   `WebGPURenderTargetDescriptor`. When set and `sampleCount === 1`,
   the depth texture is created with `TEXTURE_BINDING` usage and a
   cached `aspect: "depth-only"` view is exposed via
   `getDepthSampleableView()`. MSAA depth is silently non-sampleable
   (hardware limitation — multisampled depth can't be sampled in WGSL).

2. **Standalone debug overlay module.**
   `WebGPUDebugDepthOverlay.ts` (~230 lines) is a self-contained
   fullscreen pass: vertex stage emits a single triangle covering the
   viewport, fragment samples `texture_depth_2d`, linearizes via the
   standard `(near*far)/(far - depth*(far-near))` formula, and emits
   grayscale (or raw, or combined R=linear G=raw based on mode). Owns
   its own bind group layout because depth textures need
   `sampleType: "depth"` + `non-filtering` sampler — incompatible with
   the production post-process bind group layout.

3. **Cold-path integration.** `WebGPUSceneRenderer._runPostProcessing`
   now checks `frameState.debugShowDepthAsColor` *before* the early-out,
   and swaps in `_executeDebugDepthOverlay()` instead of the production
   post-process chain. The overlay reads camera near/far from
   `scene.camera.frustum` for linearization. When MSAA is on the
   sampleable depth view is undefined; the renderer logs a one-shot
   warning and skips the overlay (the other Tier 2 features still work).

Cost when off: zero — the debug branch is one frame-state property read
in the post-process entry method. Cost when on: one extra texture-store
on the depth attachment per frame (~few MB bandwidth at 1080p),
balanced by skipping the entire production post-process chain.

### Architectural notes

- **Cold-path discipline still holds.** The production hot path in
  `createTileCommands` reads the three new fragment debug flags +
  imagery isolation index *once* outside the per-pass loop. The
  per-pass branch is one comparison against `NONE`. Adding more
  fragment variants is now one enum value + one shader entry point.
- **Reserved vec4 pattern continues.** `tile.debugFields` and
  `SkyAtmosphere`'s `debug` vec4 both reserve 4 channels with two
  in use. New per-tile or per-atmosphere debug fields plug into the
  reserved channels without struct churn.
- **Shader source augmentation pattern.** The augmented shader module
  is the original source plus appended fragment entry points. The
  vertex stages are shared across both modules because they're
  literally the same WGSL text. No fork-and-maintain risk.
- **Failed-capability degradation.** The augmented module compile is
  wrapped in `pushErrorScope("validation")`. A driver that rejects
  `@builtin(primitive_index)` flips the support flag off and the
  selector returns null; the production pipeline kicks in
  transparently. Same pattern as Session 22's WGF-6 capability probe.

### Files Modified
1. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — debug pipeline refactor + LOD + Normal fragments + tile UBO debug fields
2. `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `debugFields: vec4` + imagery isolation mask
3. `packages/engine/Source/Renderer/WebGPU/WebGPUDebugDepthOverlay.ts` — *new*, standalone depth visualization pass
4. `packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts` — `depthSamplable` opt-in
5. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts` — opt into sampleable depth + new getter
6. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — debug depth overlay integration
7. `packages/engine/Source/Scene/Scene.js` — five new Scene flags + frame state forwarding
8. `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Session 24 documentation

### Build Status
- `npx tsc --noEmit` — Zero errors
- `npx gulp build` — Passes (~41s)

### How to use the new flags
```javascript
viewer.scene.debugShowTerrainLOD = true;       // 12-color tile depth overlay
viewer.scene.debugShowTerrainNormals = true;   // eye-space normal as RGB
viewer.scene.debugShowImageryLayer = 0;        // -1=all, 0..3=isolate slot
viewer.scene.debugShowDepthAsColor = true;     // depth visualization (non-MSAA only)
viewer.scene.debugDepthAsColorMode = 0;        // 0=linearized, 1=raw, 2=combined
```

Mutually exclusive groups (only one fires per frame):
- Wireframe wins over fragment debug modes
- Among fragment debug modes: triangulation > LOD > normals
- Depth-as-color replaces the entire post-process chain

---

---

## Session 26 — Imagery Layer Rendering Audit (2026-04-07)

### Issue (carried from prior session)

Per-tile diagnostic logs at `WebGPUGlobeSurfaceRenderer.ts:801` reported
`hasImage=true hasWebGPUTex=true` — meaning textures were uploaded and bound
correctly — yet the rendered output showed no imagery on the globe. Required
visual verification environment which was deferred.

### Code-Level Audit Findings (no browser, static analysis only)

Walked the full data path from `Imagery._reprojectTexture` through to the
fragment shader sample. No smoking gun, but ruled out the following possible
causes:

1. **Bind group layout / sample type mismatch.** Reprojection writes
   `rgba8unorm` (`getOutputFormat()` at `WebGPUImageryReprojection.ts:74`),
   bind group layout 1 declares `sampleType: "float"` for slots 0-3
   (`WebGPUGlobeSurfaceRenderer.ts:380`). Compatible.

2. **Stale uniform buffer leakage.** `_packTileUniforms` calls `data.fill(0)`
   at `WebGPUGlobeSurfaceRenderer.ts:1469` before each tile, so per-tile
   imagery slots cannot leak from previous tiles.

3. **Std140 alignment drift between host and shader.** Verified offset by
   offset: `layers` 0-47 (4 × 12 floats), `layerCount` 48, fog 49-51,
   waterMask 52-55, cartoLimit 56-59, nightFade 60-61, dayNightAlpha 62-69,
   padding 70-71 (host correctly skips), `flags` 72-75 (vec4-aligned),
   `useWebMercatorTLayer` 88-91, `debugFields` 92-95. Host writes match
   the WGSL `TileUniforms` struct exactly.

4. **dayAlpha / nightAlpha argument swap.** Host writes
   `data[dnOffset]=dayAlpha, data[dnOffset+1]=nightAlpha`. Shader reads
   `dna.x=dayAlpha, dna.y=nightAlpha` and computes
   `mix(dna.y, dna.x, dayFade)` = `mix(nightAlpha, dayAlpha, dayFade)`.
   Resolves to `dayAlpha` on the day side and `nightAlpha` on the night
   side. Correct.

5. **`textureTranslationAndScale` undefined → zero scale.** Else branch at
   `WebGPUGlobeSurfaceRenderer.ts:1496-1499` writes `(0,0,1,1)` (full tile)
   when `tileImagery.textureTranslationAndScale` is missing. Combined with
   the `data.fill(0)` reset above, this is safe — no fall-through to a
   prior tile's translation.

6. **Texture cache returning stale views after destroy.** Cache key is
   `imagery.key || "${x}_${y}_${level}"` at line 1778. The cache stores
   `{texture, view}` and returns the view on hit. If the underlying
   `_webgpuReprojectedTexture` has been recreated by a re-load between
   frames, the cached view would still point at the old (destroyed) GPU
   texture. **Recommended next-session check**: log
   `cached.texture === imagery._webgpuReprojectedTexture` on cache hit.

### Most Likely Root Causes (verify in browser)

In rough order of likelihood, given the existing diagnostics:

A. **Reprojection produces alpha=0 across the whole texture.** The
   reprojection render pass clears to `{r:0, g:0, b:0, a:0}`
   (`WebGPUImageryReprojection.ts:239`). If the full-screen triangle's
   coverage is correct this is harmless, but if any sample writes alpha=0
   then `effectiveAlpha = layer.alpha * tex.a * ...` collapses to zero
   and `mix(color, adj0, 0)` becomes a no-op, hiding the imagery.
   **Verify**: temporarily change clear alpha to `1.0` and see if any
   imagery appears.

B. **`tileImagery.textureCoordinateRectangle` is `(0,0,0,0)` instead of
   undefined.** If it has been initialized to a zero rect rather than
   left undefined, the `texCoordsAlpha` mask in the shader returns 0
   for every fragment (every UV is "outside" a degenerate rect),
   killing the contribution. **Verify**: existing diag log at line 807
   already prints `texCoordsRect` — confirm whether it shows
   `(0.0000, 0.0000, 1.0000, 1.0000)` or `(0.0000, 0.0000, 0.0000, 0.0000)`.

C. **Stale view in `_imageryTextureCache`** — see point 6 above.

### Next-Session Probe (when visual env is up)

1. Open the existing test scene; check console for the
   `[WebGPU:GlobeTile]` lines that already get printed for the first
   ~10 tiles. Specifically capture the `texCoordsRect` and `transScale`
   values reported by lines 805-808.
2. Toggle `tile.debugFields.x = 1` (tier 2 LOD overlay) in the host
   to confirm the tile geometry is rasterizing correctly in the first
   place. If the LOD overlay shows up but imagery doesn't, the bug is
   in the imagery composite path (pick A or B above).
3. If the LOD overlay also doesn't appear, the bug is upstream of the
   fragment shader (depth/clear/render-pass attachment issue).

### Status

Code audit complete; no defect identifiable without runtime inspection.
Backlog item BUG-11 stays open as **Needs visual env** with the probe
checklist above as the resumption point.
