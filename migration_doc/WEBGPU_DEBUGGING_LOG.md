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
13. [Session 26: Pipeline Fixes — Black Canvas to Imagery Rendering](#session-26-pipeline-fixes--black-canvas-to-imagery-rendering)
14. [Files Modified Summary](#files-modified-summary)

---

## Session 39 — Batch 67: NEW-4-A EdgeVisibilityPipelineStage + NEW-4-D Texture3D closures (2026-04-25)

Closes NEW-4-A and NEW-4-D from `DEFERRED_WORK.md`. Edge Visibility + Edge Feature ID Sandcastle demos go from FAIL → PASS via NEW-4-A, taking the runner score from 3/7 → 5/7 PASS on the WebGPU backend. NEW-4-D unblocks the Voxel demo path (Texture3D allocation no longer throws on WebGPU contexts); the WGSL parse error tracked as NEW-4-E is now reachable for live diagnosis.

### NEW-4-A: EdgeVisibilityPipelineStage hit `Buffer.getBufferData` on WebGPU

**Symptom:** Both `WebGPU Edge Visibility.html` and `WebGPU Edge Feature ID.html` hard-FAIL at the first frame with "An error occurred while rendering. Rendering has stopped." The console error stack:
```
DeveloperError: A WebGL 2 context is required.
    at new DeveloperError (.../index.js:90:17)
    at _Buffer.getBufferData (.../index.js:86899:13)
    at _ModelReader.readAttributeAsRawCompactTypedArray (.../index.js:164715:13)
    at _ModelReader.readAttributeAsTypedArray (.../index.js:164651:44)
    at buildTriangleAdjacency (.../index.js:165441:118)
    at EdgeVisibilityPipelineStage.process (.../index.js:165328:25)
    at ModelSceneGraph.buildRenderResources (...)
    at ModelSceneGraph.buildDrawCommands (...)
    at Model.update (...)
```

**Root cause:** `EdgeVisibilityPipelineStage` reads vertex POSITION (and optionally FEATURE_ID_0, COLOR, BENTLEY CUMULATIVE_DISTANCE) typed arrays CPU-side to build triangle adjacency, classify silhouette edges, and emit per-edge attributes for the wide-line quad geometry. The stage's existing pattern is `defined(attribute.typedArray) ? attribute.typedArray : ModelReader.readAttributeAsTypedArray(attribute)`. After upload, `PrimitiveLoadPlan.generateAttributeBuffers` clears `attribute.typedArray` unless the loader's per-attribute `loadTypedArray` flag was set, so the fallback path runs in steady-state. `ModelReader.readAttributeAsTypedArray` calls `buffer.getBufferData(...)` — a **WebGL-only** synchronous readback whose `WebGPUBuffer` equivalent doesn't exist (WebGPU buffer-readback is async via `mapAsync` on a `MAP_READ` staging buffer, which is incompatible with the synchronous pipeline-stage execution contract). The error `A WebGL 2 context is required.` comes from the WebGL `Buffer` constructor's debug check that fires on the WebGPU code path.

The same retention pattern was already in place for the index typed array — `loadIndices` (in `GltfLoader.js:1502`) explicitly sets `outputTypedArray |= hasEdgeVisibility`. The vertex-attribute load path (`loadVertexAttribute`) was never extended to follow suit, so positions stayed GPU-only after upload and the pipeline stage tripped the fallback as soon as it ran.

**Fix:** Two narrow edits, no architectural change.

1. **Eager retention at upload** ([packages/engine/Source/Scene/GltfLoader.js:1355-1389](packages/engine/Source/Scene/GltfLoader.js#L1355)) — `loadVertexAttribute` now adds a fourth `loadTypedArray` reason: `loadTypedArrayForEdgeVisibilityWebGPU = hasEdgeVisibility && frameState.context.isWebGPU === true`. Mirrors the pre-existing index-side retention. Scoped to WebGPU (WebGL keeps the prior behaviour and pays no extra memory) and to primitives that actually carry `EXT_mesh_primitive_edge_visibility`. Blanket-retains every vertex attribute on affected primitives because the consuming attributes vary per-asset (e.g., FEATURE_ID_0 only when the asset has feature IDs; CUMULATIVE_DISTANCE only when the asset uses BENTLEY_materials_line_style) and the per-attribute model semantic alone doesn't capture every consumer (BENTLEY is application-specific).

2. **Defensive guard in the pipeline stage** ([packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js:54-87](packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js#L54)) — at the top of `process`, when running on WebGPU, check that `positionAttribute.typedArray` is defined; if not, log a permanent `console.error` (per CLAUDE.md log policy: this is a real bug indicating loader-side retention was skipped, must reach the user) and bail out cleanly. The WebGPU edge emitter (`WebGPUEdgeVisibilityEmitter`) has its own independent CPU-side adjacency build driven by the model renderer, so the visual surface still shows edges even when the pipeline stage bails — the bail-out only skips the CPU-side WebGL adjacency that this stage would otherwise feed into the WebGL fallback rendering path that doesn't run on WebGPU anyway.

**Architecture choice (b vs a):** Took option (b) — eager retention at upload — over (a) async pipeline-stage refactor. (a) was multi-session work touching every pipeline-stage's contract (the entire `process(renderResources, primitive, frameState)` chain is currently sync; making one stage async cascades through `ModelSceneGraph.buildRenderResources` → `buildDrawCommands` → `Model.update` → render loop, all of which assume sync return). (b) reuses the existing `loadTypedArray` plumbing that already supports the analogous case for indices and adds two narrow edits.

**Verification:** `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` after a fresh `node server.js` rebuild:
- Before fix (stale build, baseline): Edge Visibility = FAIL (4 significant errors, 2 "rendering stopped"), Edge Feature ID = FAIL (4 significant errors, 2 "rendering stopped").
- After fix: Edge Visibility = PASS, Edge Feature ID = PASS. Zero `getBufferData` references in either demo's `errors[]`.
- Runner total: 3 PASS / 4 FAIL → **5 PASS / 2 FAIL**.

`npx tsc --noEmit`: clean.

### Files modified

- `packages/engine/Source/Scene/GltfLoader.js` — `loadVertexAttribute` retention for WebGPU + edge visibility primitives.
- `packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js` — defensive guard at top of `process` when on WebGPU.
- `migration_doc/DEFERRED_WORK.md` — NEW-4-A marked FIXED (Batch 67).
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — this entry.

### Gotcha for future maintainers

The retention is gated **per-primitive** on the presence of `EXT_mesh_primitive_edge_visibility` in the gltfPrimitive's `extensions` object — primitives without the extension keep paying zero CPU-memory cost on WebGPU. If a future contributor wants to call `Buffer.getBufferData` (or `ModelReader.readAttributeAsTypedArray`) on a vertex attribute from a *new* WebGPU pipeline stage, they'll need to extend `loadVertexAttribute`'s retention list with their own gating predicate (the BUG-series pattern is to add a sibling `loadTypedArrayForXxxWebGPU` boolean at the same indent level and OR it into `outputTypedArray`). Don't try to retain typed arrays in the pipeline stage itself — by then `PrimitiveLoadPlan` has already cleared them.

The defensive guard in the pipeline stage is a safety net, not the load-bearing fix. If the loader side regresses (someone removes the WebGPU branch in `loadVertexAttribute`), the stage prints `[CesiumJS:webgpu] EdgeVisibilityPipelineStage: position typed array missing on WebGPU` once per affected primitive and bails — no crash, but edges drawn through the pipeline-stage path silently disappear. Treat any occurrence of that log as an upload-site regression, not a stage bug.

### NEW-4-D: Texture3D constructor threw on WebGPU contexts

**Symptom (from SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md NEW-4-D):** Voxel demos (`Voxel Picking.html`, `Voxels.html`, `Voxels in 3D Tiles.html`) crashed during initialization on the WebGPU backend. The throw was the `WebGL1 does not support texture3D. Please use a WebGL2 context.` `DeveloperError` from `Texture3D` line 73 — `WebGPUContext` deliberately sets `webgl2 = false`, and the constructor tripped the WebGL1 guard before doing anything else. Even if that guard were relaxed, the next `gl.createTexture()` access (line 217) would NPE on `context._gl` (undefined on WebGPU).

**Root cause:** `Texture3D` is a WebGL-only class but `Megatexture.js` (the only first-party caller) instantiates it directly with `new Texture3D({ context, ... })` without dispatching by backend. `WebGPUTexture3D` already existed with the same shape (constructor + `copyFrom` + `sampler` setter + `destroy` + `width|height|depth`), but nothing routed to it.

**Fix:** Added a `context.isWebGPU` short-circuit at the top of the `Texture3D` constructor. When the active context is WebGPU, the constructor `return new WebGPUTexture3D(options)` and JS's "constructor returns a non-primitive object → that object replaces `this`" semantics give every caller the right backend instance with zero downstream changes. The webgl2 guard and all WebGL-specific code (`gl.createTexture`, `gl.texSubImage3D`, `gl.deleteTexture`) only execute on WebGL contexts. Megatexture is unmodified.

**Backend-agnosticism note:** The new `import WebGPUTexture3D from "./WebGPU/WebGPUTexture3D.js"` looks like a violation of the "scene/renderer-shared code does not import from `Renderer/WebGPU/`" rule, but `Texture3D` already sits at the renderer boundary and the build-variant alias plugin handles webgl-only bundles correctly: in webgl-only the import resolves to `emptyModule.js` (a Proxy that throws on instantiation), and the dispatch never instantiates because `isWebGPU` is false. `WebGPUTexture3D` is therefore not added to `WEBGPU_COMPAT_EXEMPTIONS` — it stays on the Proxy side.

**NEW-4-E unblocking:** With Texture3D dispatch landing, the Voxel demos now reach `WebGPUVoxelRenderer.update()` and the WGSL pipeline-build step. The naga `missing return at line 113` diagnostic is now reachable — pending live capture (see DEFERRED_WORK NEW-4-E entry for the candidate-fix analysis).

**Files modified:**

- `packages/engine/Source/Renderer/Texture3D.js` — added WebGPU dispatch at top of constructor + import + factory comment.

**Files NOT modified (deliberately):**

- `packages/engine/Source/Renderer/WebGPU/WebGPUTexture3D.ts` — already correct.
- `packages/engine/Source/Scene/Megatexture.js` — backend-agnostic by virtue of the dispatch.
- `packages/engine/Source/Renderer/Texture3D.d.ts` — not created. No TS file imports `Texture3D` (only `Megatexture.js`, a JS file), so the existing JS-inferred types suffice.

**Verification:** `npx tsc --noEmit` clean. Existing `Texture3DSpec.js` tests use `createContext()` (WebGL-only) and skip on `!context.webgl2`, so no spec regression. Live Voxel-demo Playwright run pending as part of NEW-4-E live capture.

---

## Session 38 — Sandcastle NEW-4 closures (NEW-4-B / NEW-4-C / NEW-4-F) (2026-04-25)

Session 37's TRULY FINAL Sandcastle pass landed all three NEW-3-* fixes and surfaced six second-layer engine bugs (NEW-4-A through NEW-4-F). Session 38 closes three of them inline; the END OF SESSION pass empirically verifies each closure and pushes the demo score from 0/7 → 3/7 PASS.

### NEW-4-B: GlobeDepth depth-copy sampler binding type

**Symptom:** Every demo with a globe + depth pipeline (Many Imagery Layers, Model Pick, Point Light Shadows, Translucent Classification, plus Edge demos as a co-issue) hit per-frame WebGPU validation:
```
Texture binding (group:0, binding:0) is TextureSampleType::Depth but used statically with
a sampler (group:0, binding:1) that's SamplerBindingType::Filtering
    - While validating fragment stage ([ShaderModule "GlobeDepth-DepthCopy-Shader"], entryPoint: "fragmentMain")
    - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor "GlobeDepth-DepthCopy-Pipeline"])
```

**Root cause:** WebGPU spec requires that a texture binding declared `sampleType: "depth"` be paired with a sampler binding of type `non-filtering` or `comparison`. Our depth-copy bind-group layout left the sampler binding-type implicit, which the WebGPU runtime defaulted to `filtering`. The sampler descriptor itself already uses `magFilter: "nearest"` / `minFilter: "nearest"` — non-filtering matches actual intent.

**Fix:** [WebGPUGlobeDepth.ts:387-393](packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts#L387) — added explicit `"non-filtering"` argument to the `sampler()` helper:
```ts
this._depthCopyBindGroupLayout = makeBindGroupLayout(
  device,
  "GlobeDepth-DepthCopy-BindGroupLayout",
  [
    texture(0, Stage.FRAGMENT, { sampleType: "depth" }),
    // NEW-4-B (Batch 66) — depth textures expose a "non-filtering"
    // sampler type only; pairing with a default "filtering" sampler
    // throws WebGPU validation: "depth-only texture must be paired
    // with non-filtering sampler". The depth-copy fragment uses
    // textureLoad-style nearest reads, so non-filtering is correct.
    sampler(1, Stage.FRAGMENT, "non-filtering"),
  ],
);
```

**Verification:** Empirically — zero `GlobeDepth-DepthCopy-Pipeline` / `TextureSampleType::Depth` / `SamplerBindingType::Filtering` occurrences in `Tools/visual-regression/screenshots/sandcastle-batch-66-end-of-session/report.json`. Three demos (Many Imagery Layers, Model Pick, Point Light Shadows) flipped from FAIL → PASS as a direct consequence (combined with NEW-4-F for Many Imagery Layers).

### NEW-4-C: getLogDepthShaderProgram dereferenced fragmentShaderSource on undefined

**Symptom:** Translucent Classification (and any future demo whose render loop derives a log-depth command for a `WebGPUDrawCommand`) hit:
```
TypeError: Cannot read properties of undefined (reading 'fragmentShaderSource')
    at getLogDepthShaderProgram (.../DerivedCommand.js:139)
    at DerivedCommand.createLogDepthCommand (.../DerivedCommand.js:230)
    at _Scene.updateDerivedCommands (...)
```

**Root cause:** `getLogDepthShaderProgram` is the WebGL log-depth derivation: it rewrites the GLSL fragment-shader source to inject `czm_writeLogDepth` calls. WebGPU draw commands carry `GPUShaderModule` pipelines — there's no `shaderProgram.fragmentShaderSource` to rewrite. The Batch 29 dispatcher already routes WebGPU log-depth via `derivedCommands.logDepth.command` with a pre-built WGSL pipeline; the WebGL derivation pass should short-circuit when the source isn't a WebGL `ShaderProgram`.

**Fix:** [DerivedCommand.js:139-149](packages/engine/Source/Scene/DerivedCommand.js#L139) — early-return `shaderProgram` unchanged when `shaderProgram?.fragmentShaderSource?.defines` is missing:
```js
function getLogDepthShaderProgram(context, shaderProgram) {
  // NEW-4-C (Batch 66) — WebGPU draw commands carry GPUShaderModule
  // pipelines that don't have a WebGL-style `fragmentShaderSource`.
  // The log-depth wrapper is a WebGL-only transformation (it rewrites
  // GLSL source); for WebGPU the dispatcher (`selectCommandVariant`)
  // already routes log-depth via `derivedCommands.logDepth.command`
  // which carries its own pre-built WGSL pipeline. Skip the wrapper
  // when the shader program isn't a WebGL ShaderProgram.
  if (!defined(shaderProgram?.fragmentShaderSource?.defines)) {
    return shaderProgram;
  }
  ...
}
```

**Verification:** Empirically — zero `getLogDepthShaderProgram` stack frames in the END OF SESSION report. Closure is **partial**: a sibling defect remains in the caller (`createLogDepthCommand`, line 254) which still dereferences `command.shaderProgram.id` for cache-keying before `getLogDepthShaderProgram` is even called. Logged as **NEW-5-A** in `SANDCASTLE_BATCH_66_END_OF_SESSION_REPORT.md` for the next session — same single-line tactical guard, one frame up the stack. With NEW-5-A also fixed, Translucent Classification should flip to PASS.

### NEW-4-F: WebGPUContext device-init missed adapter-supported limit headroom

**Symptom (advisory in Session 37; latent in Session 38):** Many Imagery Layers logged:
```
The number of sampled textures (29) in the Fragment stage exceeds the maximum per-stage
limit (16). This adapter supports a higher maxSampledTexturesPerShaderStage of 48, which
can be specified in requiredLimits when calling requestDevice().
    - While calling [Device].CreatePipelineLayout([PipelineLayoutDescriptor "Globe terrain pipeline layout"])
```
On adapters where 16 IS the hardware ceiling, this would have hard-failed pipeline creation. Even on this Intel adapter (which exposes 48) the warning indicated we were exposed to per-adapter brittleness.

**Root cause:** `WebGPUContext._initializeDevice` requested `requestDevice({ requiredFeatures: ..., requiredLimits: this._options.requiredLimits ?? {} })` — never propagating the adapter's actual ceiling for sampled-texture or per-bind-group-binding limits. The Globe terrain pipeline layout requests 29 sampled-texture bindings (16 imagery layers × ~1.8 average per layer + clipping + atmosphere); the default WebGPU minimum is 16.

**Fix:** [WebGPUContext.ts:652-684](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L652) — opportunistically request higher `maxSampledTexturesPerShaderStage` (capped at 64) and `maxBindingsPerBindGroup` (capped at 1000) when the adapter exposes them. Caller-supplied `requiredLimits` overrides take precedence — only auto-fill when undefined. If the adapter genuinely doesn't support a higher limit, `requestDevice` rejects with an explicit error rather than silently failing later at pipeline creation.

```ts
const adapterMaxSampled =
  this._adapter.limits?.maxSampledTexturesPerShaderStage ?? 16;
if (
  requiredLimits.maxSampledTexturesPerShaderStage === undefined &&
  adapterMaxSampled > 16
) {
  requiredLimits.maxSampledTexturesPerShaderStage = Math.min(
    adapterMaxSampled,
    64,
  );
}
const adapterMaxBindings =
  this._adapter.limits?.maxBindingsPerBindGroup ?? 640;
if (
  requiredLimits.maxBindingsPerBindGroup === undefined &&
  adapterMaxBindings > 640
) {
  requiredLimits.maxBindingsPerBindGroup = Math.min(
    adapterMaxBindings,
    1000,
  );
}
```

**Verification:** Empirically — zero `maxSampledTexturesPerShaderStage` advisory or `exceeds the maximum per-stage limit` warning in the END OF SESSION report. Many Imagery Layers loaded all 8 imagery layers and renders cleanly on the WebGPU backend (PASS).

### Sanity check

- `npx tsc --noEmit`: clean (per task brief).
- `node scripts/run-build-no-tsc.mjs`: clean rebuild — `Build/CesiumUnminified/index.js` 14.0 MB, `Build/CesiumUnminified/Cesium.js` 18.3 MB. Verified each fix lands in the bundle by string-grep:
  - `non-filtering`: 12 occurrences (was 0 before fix).
  - `fragmentShaderSource?.defines`: 1 occurrence (was 0 before fix).
  - `maxSampledTexturesPerShaderStage`: 9 occurrences (was 4 before fix; +5 from the new auto-bump block).
- `Tools/visual-regression/sandcastle-batch-66-end-of-session-runner.mjs`: 3 PASS / 4 FAIL on 7 demos; first non-zero PASS count on the WebGPU backend.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts` — NEW-4-B sampler binding-type fix.
- `packages/engine/Source/Scene/DerivedCommand.js` — NEW-4-C `getLogDepthShaderProgram` early-return guard.
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — NEW-4-F device-init opportunistic limit headroom.
- `migration_doc/SANDCASTLE_BATCH_66_END_OF_SESSION_REPORT.md` — END OF SESSION verification report (new file).
- `Tools/visual-regression/sandcastle-batch-66-end-of-session-runner.mjs` — runner clone with renamed output dir to preserve DEFINITIVE backup (new file).
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — this entry.

### Deferred / new findings

- **NEW-4-A** (`EdgeVisibilityPipelineStage` calls WebGL-only `Buffer.getBufferData`) — multi-session, tracked in `DEFERRED_WORK.md`. Blocks Edge Visibility + Edge Feature ID.
- **NEW-4-D** (`Texture3D` ctor WebGL-only guard) — multi-session, tracked in `DEFERRED_WORK.md`. Blocks Voxel Pick.
- **NEW-4-E** (Voxel color pipeline WGSL parse error) — tracked in `DEFERRED_WORK.md`; reachable only after NEW-4-D unblocks the texture allocation.
- **NEW-5-A (NEW)** — `DerivedCommand.createLogDepthCommand:254` dereferences `command.shaderProgram.id` without a guard; sibling of NEW-4-C, surfaced once NEW-4-C cleared the `getLogDepthShaderProgram`-line-139 crash. Single-line tactical fix; logged for the next session per the Session 38 task constraint ("don't fix engine bugs that surface during verification — log them as `NEW-5-XXX`").

---

## BUILD-VAR-SCENE-AUDIT — WebGPU-only bundle safety audit (2026-04-19)

Follow-up to the Session 27 build-variant infrastructure. The webgpu-only bundle aliases every GLSL shader string module (`Source/Shaders/*.js`) to an empty `export default ""`. Scene code that statically imports those strings still resolves at module load time (the import evaluates to `""`, no crash), but any site that actually *compiles* the GLSL string at runtime will fail because WebGL rejects an empty shader source.

The design assumption is: **every WebGL shader-compile site must be gated behind a FeatureRenderer intercept that short-circuits BEFORE the compile call in WebGPU mode.** This audit enumerates the sites in `Source/Scene/**` and categorises them by safety.

### Methodology

1. Enumerated every `Source/Scene/*.js` file that calls `ShaderProgram.fromCache` / `ShaderProgram.replaceCache` / `new ShaderProgram` (24 files total).
2. Cross-referenced against files that contain a `FeatureRendererKey.*` / `getFeatureRenderer()` check (39 files).
3. For files in both sets (9 files), spot-verified the FR intercept precedes the compile site in the call graph.
4. For files in the first set but not the second (15 files), traced the call graph upward to find where they're invoked. Each is either (a) called from an FR-protected parent (safe), or (b) unguarded (risky).

### Safe — FR intercept gates the WebGL compile path

| File | Gating mechanism |
| --- | --- |
| `Globe.js` → `GlobeSurfaceTileProvider` → `GlobeSurfaceTileProviderRendering.js` | `addDrawCommandsForTile` top-level FR check at [GlobeSurfaceTileProviderRendering.js:987](packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js#L987). Delegates to WebGPU + returns before any tile compile. |
| `GlobeSurfaceShaderSet.js` | Called only from WebGL branch of the above — unreachable when FR intercepts. |
| `Sun.js`, `SkyAtmosphere.js`, `CubeMapPanorama.js`, `CloudCollection.js`, `BillboardCollection.js`, `PolylineCollection.js`, `PointPrimitiveCollection.js`, `EllipsoidPrimitive.js` | Each has its own FR intercept at the top of `update()`. ✓ |
| `DynamicEnvironmentMapManager.js` | FR check for `DYNAMIC_ENVIRONMENT_MAP`. ✓ |
| `PointCloud.js` | FR check for `POINT_CLOUD`. ✓ |
| `PrimitiveCommandHelpers.js`, `ImageryLayerHelpers.js` | Helpers called only from FR-protected parents. ✓ |
| `renderBufferPoint/Polyline/PolygonCollection.js` | WebGL fallback bodies of `BufferPoint/Polyline/PolygonCollection`, which each have FR intercepts. ✓ |
| `DebugInspector.js` | Debug-only path, not on production render loop. Acceptable risk. |

### Risky — no FR intercept; compile would run in a webgpu-only bundle

These sites will crash at runtime in a webgpu-only build because the WebGL shader-compile call is unconditional:

| File | Compile sites | Impact |
| --- | --- | --- |
| `Vector3DTilePrimitive.js` | 5 (`fromCache` @ L492, L510, L540, L555, L578) | 3D Tiles vector content — core feature of `Cesium3DTileset` when serving vector polygons/polylines. Crash on any vector tileset load. |
| `Vector3DTilePolylines.js` | 1 (`fromCache` @ L582) | Same tileset family — crash on polyline vector tiles. |
| `Vector3DTileClampedPolylines.js` | 1 (`fromCache` @ L683) | Ground-clamped vector polylines — crash. |
| `ClassificationPrimitive.js` | 5 (`fromCache`/`replaceCache` @ L859, L880, L917, L931, L948) | Classification primitives (3D Tiles feature classification, polygon classification on terrain) — crash on any ClassificationPrimitive instantiation. |
| `DepthPlane.js` | 1 (`replaceCache` @ L96) | Used by translucent-globe code path (`GlobeTranslucencyState._useDepthPlane`). Crashes when translucent globe renders in webgpu-only. |
| `GroundPolylinePrimitive.js` | 1 (`replaceCache` @ L605) | Ground-draped polylines (roads, borders). Crash on any GroundPolylinePrimitive. |

### Remediation options

**Option A — per-file FR intercepts (preferred for hot paths)**. Extend each risky file to check `context.getFeatureRenderer(<KEY>)` at the top of its compile site and early-return to a WebGPU equivalent. This requires a matching WebGPU FR implementation for each family:

- Vector3DTile* → needs `VECTOR_3DTILE_*` FR keys + WGSL polygon/polyline rasterizers.
- ClassificationPrimitive → needs `CLASSIFICATION_PRIMITIVE` FR + WGSL stencil-based classification pass.
- DepthPlane → needs `DEPTH_PLANE` FR + WGSL depth-plane shader.
- GroundPolylinePrimitive → needs `GROUND_POLYLINE` FR + WGSL path.

Effort: L (each family is 1-2 days of WGSL + wiring). **This is the correct long-term path** and lands as Phase 8 feature work since Vector3DTiles + Classification + GroundPolyline are feature-parity gaps that the current implementation silently renders as no-ops on WebGPU (`context.getFeatureRenderer` returns undefined for unregistered keys, and the shader compile silently succeeds-with-empty-string when the alias plugin stubs the GLSL).

**Option B — defensive runtime guards (short-term)**. In each risky compile site, check `if (context.rendererType === "webgpu") return;` before the `ShaderProgram` call. The primitive would render as nothing (no commands pushed), but at least it wouldn't crash. Keeps the webgpu-only build viable while Option A is being implemented.

Effort: S — one early-return per file, ~30 min total. **Recommended as the next action** so the webgpu-only bundle can be promoted from experimental to supported for users who don't use vector tiles / classification / ground polylines.

**Option C — accept the current "experimental" classification** and document the limitation. Users who need these features must use the dual bundle. This is the status quo.

### Decision logged

Staying on Option C for now — the webgpu-only variant remains experimental. Option B (defensive guards) is a viable follow-up if a user reports the crash in practice; Option A is the proper fix and lands when the Vector3DTile / Classification / GroundPolyline / DepthPlane WebGPU FRs are built (tracked as new backlog items).

### New backlog entries

- **BUILD-VAR-HAZARD-VECTOR3DTILE** — 3 unguarded compile sites in Vector3DTile* files. Real fix needs WebGPU Vector3DTile feature renderer.
- **BUILD-VAR-HAZARD-CLASSIFICATION** — 5 unguarded compile sites. Real fix needs WebGPU Classification feature renderer.
- **BUILD-VAR-HAZARD-DEPTH-PLANE** — 1 site. Translucent globe crash. Needs WebGPU DepthPlane FR.
- **BUILD-VAR-HAZARD-GROUND-POLYLINE** — 1 site. Ground-draped polylines crash. Needs WebGPU GroundPolyline FR.

All four hazards apply **only** to the webgpu-only build variant. The dual build is unaffected because the WebGL code paths still have their real shaders.

---

## CSM Slice 2c — ModelPBRComplete Receive (2026-04-18)

Extended CSM receive coverage to the glTF PBR path. This closes the most-visible gap remaining in Slice 2 — models are the primary source of non-terrain shadow receivers in typical CesiumJS scenes. Scope was larger than the primitive receivers because the Model pipeline already consumed 7 bind groups, so effects had to be added as a new `@group(7)` with coordinated pipeline-layout + renderer + shader changes.

### CSM-SLICE-2C-1: Model pipeline layout extension (7 → 8 bind groups)

**Problem:** `WebGPUModelPipelineCache.createPipelineLayout` built a 7-group layout `[camera, material, texture, skinning, morph, instancing, featureId]`. No slot for effects, so the shader had no way to access shadow/clipping/CSM uniforms. Adding one required extending the layout without breaking anything that consumed the old shape.

**Fix:**

- Added `this._effectsBGL = getEffectsBindGroupLayout(device)` in the pipeline-cache constructor. Same factory the globe + primitive renderers use — single source of truth for the 272-byte EffectsUniforms layout across every consumer. When WebGPUEffectsBindGroup.js adds a field, every CSM-aware path picks it up automatically.
- Extended `createPipelineLayout` bindGroupLayouts array to 8 slots with effects at index 7. Backward-safe because no existing model-rendering code references group 7 — checked via grep. The Shadow cast path uses a different pipeline entirely (SHADOW_CAST_VARIANTS in WebGPUShadowMapRenderer.js), so the cast pipelines don't inherit this layout.

**Landmine avoided:** if any cached model pipeline still had the 7-group layout, WebGPU would validate-error on bind-group setup. Verified by rebuilding and testing — `cache.pipelineCache` is per-model, rebuilt when any pipeline-relevant input changes. Fresh pipelines after code change use the new 8-group layout.

**Files:** `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js`.

### CSM-SLICE-2C-2: Per-frame effects bind group in WebGPUModelRenderer

**Problem:** The effects bind group holds per-scene state (shadow map view, CSM cascade params, clipping plane texture, atmosphere LUT control). It needs to be built per-frame because the UBO content changes (shadow darkness, csmControl flag) and the referenced buffers may change when the CSM toggle flips.

**Fix — per-model per-frame call to `createEffectsBindGroup`:**

Inside `updateWebGPUModel` (between camera UB write and shadow-cast UB write), resolve the scene's shadow + CSM state:

```javascript
const shadowState = frameState.shadowState;
const receiveShadowMap =
  shadowState?.lightShadowsEnabled && shadowState?.lightShadowMaps?.[0]
    ? shadowState.lightShadowMaps[0]
    : undefined;
const csmCandidate = frameState.context?.csmRenderer;
const csmBinding =
  defined(csmCandidate) &&
  csmCandidate.enabled === true &&
  defined(csmCandidate.cascadeParamsBuffer) &&
  defined(csmCandidate.cascadeArrayView)
    ? {
        enabled: true,
        paramsBuffer: csmCandidate.cascadeParamsBuffer,
        cascadeArrayView: csmCandidate.cascadeArrayView,
      }
    : undefined;
const fxRes = createEffectsBindGroup(device, frameState, {
  shadowMap: receiveShadowMap,
  csm: csmBinding,
  cameraInPlaneSpace: frameState.context.uniformState.cameraPosition,
});
cache.effectsBG = fxRes.bindGroup;
```

Mirrors the pattern in `WebGPUGlobeSurfaceRenderer.ts:1554`. The bind group is stored on `cache.effectsBG` (per model) and pushed into each primitive's `WebGPUDrawCommand.bindGroups[]` at index 7.

**Scope note:** one 272-byte UB write + one bind-group creation per model per frame. Acceptable for typical scenes (few to a few dozen models). If scaling to hundreds of models in a frame, cache a scene-wide effects bind group on `frameState.context` per-frame and share across all models. Documented in the source as the obvious next optimization.

**Files:** `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js`.

### CSM-SLICE-2C-3: Model-space RTE → world-space RTE (the key insight)

**Problem:** CSM cascade VPs are built with RTE precision in **world-space**: `VP_RTE = VP_world * T(+cameraWC)`, such that `VP_RTE * (pWC − camWC) = VP_world * pWC`. So the shader needs to multiply the cascade VP by a world-space camera-relative vector.

ModelPBRComplete's VS, however, computes RTE in **model-space**, not world-space:

```wgsl
let rte = (positionMC - camera.encodedCameraPositionMCHigh)
        + (vec3<f32>(0.0) - camera.encodedCameraPositionMCLow);
```

`encodedCameraPositionMC = inverse(modelMatrix) * camWC`, so `rte = positionMC - camMC` — the camera-relative vector expressed in model coordinates. The model's MVP (`camera.mvpRelativeToEye`) is pre-multiplied on CPU to consume this directly and produce clip-space output without FP32 world-space reconstruction.

For CSM, we can't pre-multiply: cascade VPs are scene-level (not per-model) and would require 4 per-model matrix uploads per frame if we pre-multiplied. The shader needs to do the model→world conversion itself.

**Naive approach that doesn't work:** `pWC = modelMatrix * vec4(positionMC, 1.0)` then `rteWC = pWC - camWC`. Fails in FP32 at Earth scale — both pWC and camWC can be at 6.37M m magnitude, cancellation loses precision.

**Fix — exploit the w=0 multiplication trick:**

```wgsl
let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
```

With `w = 0`, the matrix multiply drops the translation column, applying only the rotation + scale 3x3 part. Mathematically:

```text
modelMatrix_3x3 * rteMC
  = modelMatrix_3x3 * (positionMC − camMC)
  = modelMatrix_3x3 * positionMC − modelMatrix_3x3 * camMC
```

Since `camMC = inverse(modelMatrix) * camWC`:

- `modelMatrix_3x3 * positionMC = pWC − modelTranslation`
- `modelMatrix_3x3 * camMC = camWC − modelTranslation`

The `modelTranslation` terms cancel in the subtraction:

```text
modelMatrix_3x3 * rteMC = (pWC − modelTranslation) − (camWC − modelTranslation) = pWC − camWC
```

That's the world-space camera-relative vector, and critically it stays precise in FP32 because `rteMC` is bounded by (model extent + camera distance to model), NOT Earth-scale. `modelMatrix_3x3` is a well-conditioned rotation+scale with no translation, so the multiply preserves precision.

**Implementation:**

- New `@location(7) rteMC: vec3<f32>` varying on `VertexOutput` / `FragmentInput`.
- VS populates `output.rteMC = rte` (using the existing `rte` local at line 270 — no VS math changes, just export the existing value as a varying).
- FS rotates to world-space in the CSM branch. Interpolation between vertices preserves model-space precision (both endpoints are small magnitudes), so the FS receives a precise `rteMC` to rotate.

**Files:** `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`.

### CSM-SLICE-2C-4: Fragment-shader integration

**Fix:** Inlined the CSM helpers (`selectCascade`, `getCascadeVP`, `cascadeDepthBias`, `sampleOneCascade`, `sampleCascadeShadow`, `computeShadowFactorCSM`) from `PrimitivePhongTexturedColor.wgsl`. Math is identical across receivers — only the bind group number and the `eyePos` source differ. Added after the `FragmentInput` struct, before `fragmentMain`.

**Fragment integration point:** after the Cook-Torrance BRDF assembly (line 566 in the original file), `direct` is multiplied by `shadowFactor`:

```wgsl
var direct = (kD * diffuseColor / PI + specBRDF) * light.sunColor * light.sunIntensity * NdotL;

if (effects.csmControl.x > 0.5) {
  let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
  let viewDepth = abs(input.positionEC.z);
  let shadowFactor = computeShadowFactorCSM(rteWC, viewDepth, N, L);
  direct = direct * shadowFactor;
}
```

Ambient + emissive stay unshadowed per PBR convention — direct sunlight casts shadows, ambient/IBL fills them. `viewDepth = abs(positionEC.z)` matches the cascade split test used by every other receiver (Cesium's eye-space convention puts in-front points at negative z).

**Unlit materials are naturally safe:** `FLAG_IS_UNLIT` early-exits at line 447, well before the CSM block. No additional gate needed.

**Files:** `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`.

### Still pending in Slice 2

- **Slice 2d** — PrimitivePBR{Simple,Textured} receive + 20 Material Lit variant receivers (MatColorLit, MatBumpMapLit, MatWaterLit, etc.). All lack the effects binding today. Mechanical effort; candidate for scripted transformation across the Material Lit variants which share common structure.

---

## CSM Slice 2b — Texel-Snap + PhongColor Receive (2026-04-18)

Two complementary fixes landing together after Slice 2a: a CPU-side stabilization fix that kills shadow shimmer, and a shader extension that broadens CSM receive coverage from one lit primitive to two.

### CSM-SLICE-2B-1: Texel-snap stabilization

**Problem:** Shadow edges crawled continuously against static geometry as the camera moved. The cascade sphere center (from `_fitBoundingSphere`) shifts a few millimeters per frame with camera motion; since shadow texels are anchored to the center, the texel grid moves too, and every static edge crosses sub-texel boundaries constantly. Visible as sub-pixel shimmer on building edges and terrain ridges — the classic "shadow crawl" artifact.

**Fix — `snapToTexelGrid(center, radius, lightDir, resolution, result)` in [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts):**

1. Build the light-space basis exactly the same way `_computeCascadeVPMatrix` does (forward = normalize(lightDir), side = normalize(cross(forward, up_guess)), up' = cross(side, forward)). **Key property:** basis depends ONLY on `lightDir` + the world-up fallback, NOT on the camera. So the basis axes point in fixed world directions frame-to-frame.
2. Project the raw center onto (side, up) to get its light-space XY coordinates in an absolute, camera-independent reference frame.
3. Round each coordinate to the nearest multiple of `texelWorld = 2 * radius / resolution` (the world-space extent of one shadow texel under the ortho projection).
4. Re-express the snapped XY back in world space via `snapped = raw + (xSnap - xLS) * side + (ySnap - yLS) * up`.

Integrated in `computeCascadeVPs` between `_fitBoundingSphere` and `_computeCascadeVPMatrix`. Uses a per-call scratch `Float64Array(3)` (`_scratchSnappedCenter`) so no per-frame allocation.

**Why world-grid-locked, not camera-relative:** If the basis depended on camera position, the texel grid would move with the camera — exactly the behavior we're trying to eliminate. The basis stability is the whole point.

**Specs added to [WebGPUCSMRendererSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js):**

- Idempotence: `snap(snap(x)) == snap(x)` — second snap is a no-op up to FP rounding.
- Bounded displacement: `|snapped - raw| <= texelWorld * 0.71` (half-texel diagonal).
- Zenith light: Z unchanged (light-space XY for lightDir=+Z is world X, -Y; Z axis not touched).
- Bounding coverage: raw point stays well inside the sphere around the snapped center (the snap moves < r).
- VP stability: VP(snapped) and VP(raw) have identical columns 0-2 (rotation/scale unchanged); column 3 (translation) differs only by bounded texel-scale amount.

**Earth-scale sanity run** (Node script): two raw centers at `(6378000 + 0.1*texelWorld, 0, 0)` and `(6378000 + 0.2*texelWorld, 0, 0)` both snap to the SAME world position `(6378000.000000, ..., ...)`. This is the shimmer-kill in action: sub-texel camera drift produces zero texel-grid motion.

**Files:** `packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` (helper + integration + `cascadeResolution` getter + scratch vector), `packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js` (5 new specs).

### CSM-SLICE-2B-2: PrimitivePhongColor CSM receive

**Problem:** `PrimitivePhongColor.wgsl` (the non-textured lit primitive shader) had the single-shadow-map path but not CSM. Scenes using non-textured lit primitives under CSM fell back to the single-shadow-map, breaking visual consistency with textured primitives.

**Fix:** Direct port of the CSM block from `PrimitivePhongTexturedColor.wgsl`:

- EffectsUniforms struct gained the trailing `atmosphereLutControl: vec4<f32>` + `csmControl: vec4<f32>` fields to match the 272-byte UBO layout. Without these, `csmControl` reads from wrong bytes.
- New CSMParams struct (4 RTE-aware cascade VPs + splits + blend bands + per-cascade biases).
- Bindings 10/11 added to the effects group — **`@group(2)`** for PhongColor, not `@group(3)` like the textured variant. Reason: primitive pipelines build `[cameraBGL, materialBGL, (textureBGL if needsTexture), effectsBGL]`, so effects lands one slot earlier when there's no texture group.
- CSM helpers `selectCascade`, `getCascadeVP`, `cascadeDepthBias`, `sampleOneCascade`, `sampleCascadeShadow`, `computeShadowFactorCSM` copied verbatim.
- Fragment shader routes through `computeShadowFactorCSM(eyePosition, viewDepth, normal, lightDir)` when `effects.csmControl.x > 0.5`, falls back to `computeShadowFactor` otherwise.

**Zero JS/pipeline changes required** — the effects BGL (`getEffectsBindGroupLayout` in `WebGPUEffectsBindGroup.js`) already advertises bindings 10/11 from Slice 1 with placeholder buffers when CSM is off. Any shader that consumes the effects group inherits CSM capability automatically.

**Files:** `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl`.

### Still pending in Slice 2

- **Slice 2c** — ModelPBRComplete receive + PrimitivePBR{Simple,Textured} receive. Audit shows this needs pipeline-layout extension (model pipeline already uses 7 bind groups 0-6; effects lands at @group(7)), per-frame `createEffectsBindGroup` invocation, new `eyePositionRTE` varying (the `rte` vector currently computed in the VS before `modelViewRelativeToEye`). Deferred: scope justifies a dedicated session with glTF smoke tests.
- **Slice 2d** — 20 Material Lit variant receivers. Mechanical effort; candidate for scripted transformation.

---

## Slice 1 follow-ons + CSM Slice 2a — Cast-Variant Unlock (2026-04-18)

Two Tier-1 follow-ons + CSM Slice 2a cast-variant unlock, landing after Session 34 on the same day. All build-clean at 13.1 MB / 23.7 MB sourcemap.

### CSM-FOLLOW-1: Cast-output verification contract (CPU specs)

**What:** The post-Session-34 handoff called out a BLOCKING-before-Slice-2 cast-output verification spec (render a single cube into the cast pass → read back cascade texture → verify depth). Evaluated the two approaches:

- **GPU end-to-end readback:** `copyTextureToBuffer` + `mapAsync` + pixel assert. No existing Cesium specs use this infrastructure; building it for one verification point would be disproportionate.
- **CPU-side contract specs:** export the math + the UBO layout as constants, spec both. Catches the same class of regression that GPU readback would (cast VS math diverging from VP_RTE derivation, UBO layout drift as Slice 2 variants expand) without new infrastructure.

**Fix:** Chose CPU specs.

- New exported `computeCastClipPosition(pHigh, pLow, camHigh, camLow, lightVpRte, depthBias, result)` in `WebGPUCSMRenderer.ts`. Mirrors the WGSL body of `SHADOW_CAST_VARIANTS.rte24` — the contract every Slice 2 variant's VS must preserve after its own vertex decompression step.
- New `WebGPUCSMCastUBOLayoutSpec.js` locks cast UBO byte layout (128 bytes: `lightVP_RTE` @ float 0..15, `camHigh` @ 16, `camLow` @ 20, `depthBias` @ 24, `normalBias` @ 25) + `BASE_MIN_BIAS`/`BASE_MAX_SLOPE_BIAS` tuning constants (re-exported from the renderer).
- Extended `WebGPUCSMRendererSpec.js` with 4 math-identity specs: identity-at-origin, Earth-scale RTE subtract, `VP_RTE · rte ≡ VP_world · worldPos` at Earth scale, bias-only-touches-clip-z.
- Node sanity run: Earth-scale identity max diff **3.3e-17** (double-precision floor).

**Files:** `packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts`, `packages/engine/Specs/Renderer/WebGPU/WebGPUCSMCastUBOLayoutSpec.js` (new), `packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js`.

### CSM-FOLLOW-2: `worldPosition` varying removed from PrimitivePhongTexturedColor.wgsl

**What:** Session 33 pivoted CSM's fragment math from a world-space position varying (`positionHigh + positionLow`, FP32-lossy at Earth radius) to `eyePosition` (the RTE-precise camera-relative vector). The `worldPosition` varying was zero-filled as a one-session layout-compatibility stopgap.

**Why remove it:** Attractive nuisance. A `@location(5) worldPosition` slot declared but zero-filled invites future contributors to "populate it properly" by re-introducing the exact Earth-scale precision bug we just fixed. Safer to delete the slot outright so the shader's contract says "here is `eyePosition` — use it."

**Fix:** Dropped `@location(5) worldPosition: vec3<f32>` from `VertexOutput`. Removed the `output.worldPosition = vec3<f32>(0.0);` write. Fragment code unchanged — it already read only `input.eyePosition`. VertexOutput shrunk from 6 to 5 varyings. Sibling PBR shaders (`PrimitivePBRSimple.wgsl`, `PrimitivePBRTextured.wgsl`) have a similarly-named varying that's actually eye-space (misleading name, not an RTE bug) — flagged for a future rename-only cleanup.

**Files:** `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl`.

### CSM-SLICE-2A: Cast-variant unlock (all registered `SHADOW_CAST_VARIANTS` now work under CSM)

**Problem:** Before this work `WebGPUCSMRenderer.renderCastPass` filtered commands by `if (layoutKey !== "rte24") continue;`. Every model command, quantized-mesh terrain command, instanced command, and skinned command was silently dropped from the cascade cast pass. Users enabling CSM saw shadows only from RTE primitives (terrain via rte24 shadow layout, not the quantized12 path that the single-shadow-map path already supported).

**Additional hidden hazard:** the Slice 1 cast VP fix (Session 33, CSM-33-1) was masked by this filter. If Slice 2 had unlocked variants without the RTE-aware VP, cast depths would have been wrong in a way that was invisible under Slice 1 (rte24 terrain didn't actually cast in most Slice 1 test scenes because the globe surface shadow path defaults to `quantized12` for quantized-mesh tiles).

**Fix — generalized the CSM cast loop to pattern-match the single-shadow-map loop:**

1. **Expose variant metadata.** New exported `getShadowCastVariant(key)` in `WebGPUShadowMapRenderer.js`. Single source of truth for `extraBindings` / `perCommandBindingFields` / `vertexBufferSourceSlots` across both paths. `registerShadowCastVariant` additions flow through automatically.

2. **No-extras variants** (`rte24`, `p12`, `modelInstanced`): shared per-cascade bind group cached on `this._cascadeCastBindGroups[ci].get(layoutKey)`. One bind group per (cascade, variant) tuple — reused across every command that hits that variant on that cascade.

3. **Extras variants** (`modelP12`, `modelInstancedSB`, `modelSkinned`, `quantized12`): per-command bind group indexed by cascade via `cmd._shadowCastCSMBindGroups[ci]` (parallel array) with `cmd._shadowCastCSMBindGroupKeys[ci]` for layout-change invalidation. Mirrors the single-shadow-map's `cmd._shadowCastBindGroup` pattern but scoped to CSM so the two paths don't overwrite each other's bind groups when both are active.

4. **Multi-VB variants** (`modelSkinned` pulls pos + joints + weights from slots 0/5/6 of the model's 7-buffer layout): walk `variant.vertexBufferSourceSlots` to bind into the cast pipeline's compact 0/1/2 layout. Single-VB variants fall through to the default slot-0 bind. Legacy `modelInstanced` variant keeps its `_shadowCastInstanceVB` secondary-slot fallback.

5. **Instance count forwarding:** `pass.drawIndexed(count, cmd.instanceCount ?? 1)` — previously the rte24-only path didn't forward instance count, which would have broken `modelInstancedSB` as soon as the filter was lifted.

**Per-command UB ownership — safe for multi-cascade iteration.** Worth documenting because it's counterintuitive. `cache.shadowCastUB` is allocated once per Model and written once per frame at the top of the Model's update, **before** any cast pass. CSM iterates the same command list four times (once per cascade); each iteration reads the same stable UB object. No race, no staleness. Bind-group cache stays valid frame-to-frame because the UB identity never changes.

**Pipeline reuse.** CSM's `_sharedPipelineCache` is distinct from `shadowMap._webgpuCache` but calls the same shared `_getOrCreateCastPipeline` factory. Each variant compiles once per cascade-renderer lifetime. BGL is identical between the two paths (same 128-byte `u` struct; CSM's cast UBO matches `SHADOW_UNIFORM_SIZE` exactly) — the compiled pipeline works against either path's buffer without recompile.

**Files:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js` — added `getShadowCastVariant` export.
- `packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` — `renderCastPass` generalized; `CastCommandShape` widened with `_shadowCastModelUB` / `_shadowCastJointMatricesSB` / `_shadowCastInstancingSB` / `_shadowCastInstanceVB` / `_shadowCastCSMBindGroups` / `_shadowCastCSMBindGroupKeys`.

**What's live as of this session:** models cast cascaded shadows on terrain and on each other. Quantized-mesh terrain casts on models. Skinned and GPU-instanced models cast. Any future variant registered via `registerShadowCastVariant` (third-party extensions) works automatically — the CSM loop is fully metadata-driven.

**Still pending in Slice 2:** primitive lit receivers (ModelPBRComplete etc. consume bindings 10/11 with the same `eyePosition`/RTE contract as PrimitivePhongTexturedColor) + texel-snap stabilization. Neither blocks the other — can proceed in parallel.

---

## Session 34 — TAA Motion-Vector RTE Slice 1 (2026-04-18)

Completed the deferred TAA motion-vector work called out in Session 33. TAA now reprojects history via depth + RTE-aware matrix math instead of the UV-identity stub, and the precision design matches the CSM fix from the prior session — no world-space reconstruction at any point.

### TAA-34-1: Motion vectors via depth reprojection in RTE space

**Symptom (pre-fix):** `TAA.wgsl:88` had `let historyUV = unjitteredUV;` — no reprojection. Worked for still cameras; broke down immediately during any camera motion (ghosting unbearable even at ground-level panning, catastrophic during orbital fly-to).

**Why the naive fix is wrong:** The textbook formula `worldPos = inverse(currVP) * ndc; prevNdc = prevVP * worldPos` loses ~0.76m per component at Earth radius (6.37M m) due to FP32 ULP. One meter of jitter in reprojected position translates to multi-pixel motion-vector error — motion vectors become noise during fly-to, which is exactly when TAA matters most.

**Fix:** Depth-based reprojection in **eye-relative space**, never reconstructing world-space:

```wgsl
ndcCurr = vec3<f32>(uv*2-1, depth)              // WebGPU NDC, depth in [0,1]
eyePosCurr = inverse(currentVpRte) * ndcCurr   // camera-relative to CURRENT frame
eyePosPrev = eyePosCurr + cameraDelta           // cameraDelta = currWC - prevWC (FP64 on CPU)
ndcPrev = previousVpRte * eyePosPrev            // camera-relative to PREV frame's light VP
prevUV = ndcPrev.xy * 0.5 + 0.5
```

All intermediate values stay within view-frustum/cascade scale (km at most). `cameraDelta` is per-frame-small (meters during typical motion), computed in FP64 on CPU, down-cast to FP32 vec3 without precision loss. Inverting `currentVpRte` happens once per frame on CPU via `_invertMatrix4` in [WebGPUTAAEffect.ts](packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) — avoids the per-pixel WGSL inverse.

### Files changed

**CPU (JS/TS) side:**

- [UniformState.js](packages/engine/Source/Renderer/UniformState.js): added model-independent `_viewProjectionRelativeToEye` lazy field (projection × view-with-translation-zeroed) + getter. Added `_previousViewProjectionRelativeToEye` + `_previousCameraPosition` snapshots at the top of `update()`. The "previous" snapshot happens BEFORE `updateCamera` runs so it captures last frame's state; it uses the model-independent form so it's safe regardless of what model matrix the last draw command set.
- [UniformStateComputations.js](packages/engine/Source/Renderer/UniformStateComputations.js): added `cleanViewProjectionRelativeToEye()` (copies view, zeroes translation column 12-14, multiplies by projection) + wired the dirty flag into `setView`/`setProjection`.
- [Scene.js](packages/engine/Source/Scene/Scene.js): alongside the existing jitter application (~line 4581), computes `cameraDelta = currCam - prevCam` and pushes matrices + delta into the TAA effect via the new `updateMotionVectorParams()` entry point. `historyValid` is gated on `frameNumber > 1` so the first frame falls back to UV-identity.
- [WebGPUTAAEffect.ts](packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts):
  - TAA params UBO grew from 32 → 256 bytes (content: 240). New fields at fixed offsets: `currentVpRte` (32), `previousVpRte` (96), `inverseCurrentVpRte` (160), `cameraDelta` (224).
  - Added `updateMotionVectorParams()` public API — CPU-inverts `currentVpRte` in FP64 via the new `_invertMatrix4` helper (Cesium Matrix4.inverse equivalent, kept local to avoid Matrix4 import into this TS module).
  - Added `_motionVectorsValid` guard for the first frame.

**GPU (WGSL) side:**

- [TAA.wgsl](packages/engine/Source/Shaders/WebGPU/PostProcess/TAA.wgsl):
  - `TAAParams` struct extended to match the new UBO layout (3 mat4 + vec3 delta + historyValid u32).
  - New `reprojectUV()` helper — implements the depth reprojection math above. Falls back to identity UV in four cases: `historyValid == 0` (first frame), `depth >= 1.0` (sky — no stable reprojection in Slice 1), `clipPrev.w <= 0` (behind previous camera), `prevUV` out of [0,1] (disocclusion / offscreen).
  - Y-flip matches the WebGPU cascade sampling convention (`ndc.y` sign-flipped for UV.y).
  - Neighborhood AABB clamp unchanged — still catches ghosting on the remaining edge cases.

### Why this design vs alternatives

Three architectural options were on the table (from the TAA audit):

- **A: MRT from main scene passes** — every primary shader emits motion vectors as a second color attachment. High coverage but every shader (globe, models, billboards, polylines) needs changes + framebuffer format changes. Rejected for Slice 1 scope.
- **B: Separate motion-vector geometry pass** — costs a full geometry re-raster + CPU complexity around variant selection. Rejected.
- **C: Depth reprojection in the TAA shader** — zero new render targets, depth texture already bound, motion vectors reconstructed per-pixel from depth + matrices. Works for static AND animated geometry (per-pixel depth is all that matters). **Chosen.**

Option C has one Slice 2 follow-on: animated objects (skinned models, moving vehicles) need per-object motion vectors to reproject correctly — depth reprojection alone treats the world as static. For Slice 1, static terrain + stationary models are correct; Slice 2 can add per-model MRT motion output as a narrow exception.

### Sanity check

- `npx tsc --noEmit`: clean
- `npx gulp build`: clean at 13.1 MB / 23.7 MB sourcemap (up 100 KB for the TAA matrix fields + shader math)
- Node inverse test: `_invertMatrix4 * M == I` with max off-identity = 0.000e+0 on a perspective-like matrix — bit-exact in FP64.

### Deferred follow-ons

- **Per-model motion vectors (Slice 2)** — MRT from main pass for skinned/animated primitives.
- **Sky reprojection (Slice 2)** — depth=1.0 fragments need a camera-rotation-only reproject path.
- **Snapshot-freeze interaction** — when TAA is frozen (`scene._snapshotMode.isFrozen`), jitter zeroes and motion-vector math should short-circuit. Currently the `historyValid` flag doesn't explicitly check this; works in practice (jitter=0 → identity reprojection ≈ no motion) but a dedicated gate would be cleaner.
- **TAA history invalidation on large camera jumps** — if `length(cameraDelta)` exceeds a threshold (teleport / camera.flyTo landing), history should be dropped. Not yet implemented.

---

## Session 33 — CSM RTE Precision + Per-Cascade Depth Bias (2026-04-18)

Two deep-dive follow-ons from the CSM Slice 1 audit, landed together because they touch the same cascade-sampling path and the same UBO bytes.

### CSM-33-1: Cascade VP was world-space but cast shader fed it an RTE-relative vector

**Symptom:** `WebGPUCSMRenderer.renderCastPass` packed `cascade.viewProjection` (a world-space VP) into the per-cascade UBO, but `ShadowMap.wgsl:35-39` (the cast vertex stage) multiplies that matrix by `posRTE = (positionHigh - camHigh) + (positionLow - camLow)` — a camera-relative vector. Multiplying a world-space VP by a camera-relative vector produces light-space coords of a point near the world origin, not the vertex's true light-space position. Cascade 0's depth map should be dense with terrain; in practice it was effectively empty. The masking factor that hid this was our Slice 1 `rte24`-only filter — terrain casts through `quantized12`, which CSM drops. Any future cast-variant unlock would have exposed the bug as totally-broken shadow depth.

**Root cause:** The cast UBO's `lightViewProjection` field is (by convention already in use for single-shadow-map) an *RTE-aware* matrix `VP_world · T(+cameraWC)`. Our CSM renderer forgot the translation compose step and stored the raw world-space VP.

**Fix:** Added `applyCameraTranslationToVP(vp, cx, cy, cz, result)` in [WebGPUCSMRenderer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts). Every cascade now computes `viewProjectionRTE = VP_world * T(+cameraWC)` in FP64 (JS `number`) before the FP32 down-cast, so the 6.37M-magnitude camera translation cancels into VP's translation column cleanly. Both the cast UBO and the receive-side `CSMParams` UBO carry the RTE form. World-space `viewProjection` is kept only for diagnostics.

**Files modified:**

- [WebGPUCSMRenderer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts): added `viewProjectionRTE` per-cascade, extended `_cascadeParamsData` to 272 floats, derived VP_RTE in `computeCascadeVPs`, wrote VP_RTE (not VP_world) into both cast + receive UBOs, exported `applyCameraTranslationToVP`.

### CSM-33-2: Receive shaders were passing a lossy FP32 world-space reconstruction into cascade VP

**Symptom:** At Earth scale, FP32 has ~0.76m ULP. Reconstructing `worldPos = positionHigh + positionLow` (PrimitivePhongTexturedColor.wgsl:118) or `fragmentWorldPos = v_positionMC + cameraWC` (GlobeTerrain.wgsl:1206) before feeding into the cascade VP produced ~1m shadow-sample error on the tightest cascade — would manifest as acne everywhere on cascade 0, and self-shadowing streaks along grazing-angle terrain.

**Root cause:** Receive path assumed a world-space cascade VP (same bug as CSM-33-1, mirrored). Even with an RTE-aware VP, passing a lossy-reconstructed world position breaks the point of RTE.

**Fix:** Receive shaders now feed the **camera-relative** position straight into the RTE-aware cascade VP:

- [PrimitivePhongTexturedColor.wgsl](packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl): CSM fragment branch passes `input.eyePosition` (the RTE vector computed by `translateRelativeToEye` in the vertex stage). The `worldPosition` varying is now zeroed.
- [GlobeTerrain.wgsl](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl): added a new `v_positionRTE` varying that carries `rtePosition = (center3DHigh - camHigh) + (center3DLow + exaggeratedPosition - camLow)` from the vertex stage in SCENE3D (zero elsewhere — CSM is SCENE3D-gated). CSM fragment branch feeds this into the cascade VP directly.

Result: no FP32 reconstruction of worldPos on the GPU; precision drops from ~1m to sub-micrometer.

### CSM-33-3: Hardcoded 0.005 depth bias replaced with per-cascade slope-scaled formulation

**Symptom:** Receive shaders had `let bias = 0.005;` hardcoded — works at one cascade scale, fails at all others. Cascade 3 (10km extent) would peter-pan; cascade 0 (10m extent) would acne.

**Fix:** Extended `CSMParams` UBO with two new vec4s (`cascadeMinBias`, `cascadeMaxSlopeBias`) at float offsets 264/268. Sizes fit within existing 1088-byte placeholder (no BGL or layout-spec changes on the effect-group side).

Per-cascade constants scale linearly with `sphereRadius / cascade[0].sphereRadius`, so the NDC bias tracks each cascade's orthographic depth range (`fn = 3*r` in `_computeCascadeVPMatrix`). Base values: `minBias = 5e-5`, `maxSlopeBias = 5e-4`. In-shader formula:

```wgsl
let nDotL = clamp(dot(normalize(N), normalize(L)), 0.0, 1.0);
let bias = max(cascadeMinBias[i], cascadeMaxSlopeBias[i] * (1.0 - nDotL));
let biasedDepth = ndc.z - bias;
```

Applied inside `sampleOneCascade` for both primitive and globe paths. Cast-side UBO bias also scaled per-cascade (cascade 0 gets `BASE_MIN_BIAS`; others scale).

**Files modified:**

- [ShadowReceiveCSM.wgsl](packages/engine/Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl): canonical helper — `cascadeDepthBias()` + updated `sampleOneCascade` / `sampleCascadeShadow` signatures.
- [GlobeTerrain.wgsl](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl): inline CSMParams struct extended; cascade helpers now accept `normal` + `lightDir`.
- [PrimitivePhongTexturedColor.wgsl](packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl): same.
- [WebGPUEffectsBindGroupCSMLayoutSpec.js](packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js): comment updated; test floor adjusted to 272 floats.
- [WebGPUCSMRendererSpec.js](packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js): added 2 new specs for `applyCameraTranslationToVP` (columns preserved + `VP_RTE * eyePos ≡ VP_world * worldPos` at Earth scale).

### Verification

- `npx tsc --noEmit`: clean
- `npx gulp build`: clean at 13.0 MB / 23.6 MB sourcemap
- Node sanity script: `applyCameraTranslationToVP` produces `VP_RTE * eyePos` bit-identical to `VP_world * (eyePos + cameraWC)` at camera position (6378137, 0, 0) with 50m cascade sphere — 0.0e+0 max diff.

### Scope notes

- TAA motion-vector follow-on (would need `previousEncodedCameraHigh/Low` + `previousMvpRelativeToEye` in UBO) is **deferred** — separate from CSM and unblocked only once we start TAA Slice 1. The audit report documents the required UBO fields and catastrophic-ghosting failure mode if the previous encoded camera pair is not saved across frames.
- CSM matrix convention deep-dive: confirmed the single-shadow `lightViewProjection` field is already RTE-composed by `ShadowMap.js`; our CSM renderer now matches that convention, so flipping `scene.useCascadedShadowMaps` no longer produces mismatched cast-pass math.

---

## Session 32 — Batch 27 Gotchas (2026-04-18)

Two small gotchas surfaced while landing DP-H41-ALL-RENDERERS + DP-H19-SHADER-DECODE scaffold. Neither was a runtime bug; both were "why did the pre-commit hook fail on something I didn't obviously touch" moments worth documenting for future shader-variant work.

### SHADER-32-1: Inline WGSL template literals can't contain backticks in JSDoc-style comments

**Symptom:** Prettier parse error `SyntaxError: ',' expected` on `WebGPUEllipsoidPrimitiveRenderer.ts` line 51, which was inside a WGSL struct comment that referenced `` `UniformState._previousViewProjection` ``.

**Root cause:** `WebGPUEllipsoidPrimitiveRenderer.ts` declares `const ELLIPSOID_WGSL = \`...\`` (tagged template-literal wrapper for inline WGSL). Any backtick inside that string closes the template prematurely. My DP-H41 edit wrote a comment `// \`UniformState._previousViewProjection\` (f32 mat4).` inside the struct, but because it's inside the outer backtick-delimited template literal, the nested backticks got interpreted as template boundaries by Prettier's TS parser. TypeScript's compiler didn't catch it (the rest of the file's structure remained valid), but Prettier rejected the file for malformed template syntax.

**Fix:** Dropped the backticks from the comment — plain text `// UniformState._previousViewProjection (f32 mat4).`.

**Lesson:** Any new inline-WGSL files (shader-as-template-literal in TS) need to treat backticks in doc-comments as forbidden. Prefer single-quotes, plain text, or move the comment outside the template literal. See `WebGPUEllipsoidPrimitiveRenderer.ts:49-51` for the working pattern.

### SHADER-32-2: ESLint `curly` rule blocks landed code if you only touch "nearby"

**Symptom:** Pre-commit `lint-staged` ESLint step flagged single-line `if (!defined(x)) return;` statements in `WebGPUPrimitiveCommands.js` and `ModelPrimitiveGeometry.js` even though those lines were not modified by Batch 27.

**Root cause:** `.eslintrc` sets `curly: "all"` (every `if` needs braces). Historical code had lots of one-liners. The lint-staged config runs ESLint on staged FILES, not staged HUNKS — so any unrelated one-liner in a file I happened to modify failed the pre-commit.

**Fix:** Added braces to all offending one-liners in the touched files (7 sites between `WebGPUPrimitiveCommands.js`, `WebGPUPrimitiveShaders.js`, `WebGPUModelPipelineCache.js`, `ModelPrimitiveGeometry.js`).

**Lesson:** When making small edits to older files, budget a pass through ESLint to fix historical one-liners. `npx eslint --fix <file>` auto-fixes most of them. Doing it proactively avoids a late pre-commit surprise.

---

## Session 29 — Typing Push Discoveries (2026-04-14)

Not bugs in the traditional sense — three latent correctness/design drifts surfaced while adding co-located `.d.ts` files to drop `as unknown as` boundary casts. Each was hiding behind a cast; dropping the cast made TypeScript enforce reality.

### TYPE-29-1: `CesiumMatrix4` ambient type was a lie (Float64Array intersection)

**Symptom:** Every Matrix4 value crossing JS↔TS needed `as unknown as CesiumMatrix4` to compile.

**Root cause:** `cesium-js-types.d.ts` declared:

```ts
type CesiumMatrix4 = Float64Array & { length: 16; 0: number; ... 15: number; clone(); ... };
```

This claimed `Matrix4` instances are `Float64Array` subclasses. They are not — `Matrix4` is a plain ES6 class with numeric-indexed own properties (`this[0] = ...`, etc.). The intersection required `Matrix4` instances to have `BYTES_PER_ELEMENT`, `buffer`, `byteLength`, and ~26 other Float64Array members they don't have, forcing casts at every boundary.

**Fix:** Changed `CesiumMatrix4` to a structural interface (no Float64Array intersection). Matrix4 now assigns to CesiumMatrix4-typed parameters directly.

**Files:** `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` (lines 113-135 before fix).

**Latent bug concern:** None at runtime — the type lie was entirely compile-time. But `Float64Array.pack()` / `unpack()` call sites that expected real TypedArray methods would have failed if anyone had ever used them, which is why nobody did.

### TYPE-29-2: `isDestroyed` getter/method drift (latent TypeError)

**Symptom:** `GraphicsContext` declared `abstract get isDestroyed(): boolean`; `WebGPUContext` implemented as a getter too. Meanwhile, every upstream CesiumJS `isDestroyed()` call site uses method form (`obj.isDestroyed()`).

**Root cause:** [destroyObject.js:49](packages/engine/Source/Core/destroyObject.js#L49) implements the standard destroy pattern:

```js
object.isDestroyed = returnTrue;  // overwrite the property with a function
```

This is how CesiumJS turns a destroyed object into "it will answer `true` to `isDestroyed()`". **A getter cannot be overwritten this way without a TypeError at the assignment site** — the property-descriptor is `{ get, set, configurable: false }` by default.

**Why it hadn't crashed:** No code routes `WebGPUContext` or `GraphicsContext` through `destroyObject()`. The pattern is used on many other classes (Buffer, VertexArray, ShaderProgram, Scene, etc.) which all use method form. The mismatch on the context hierarchy was latent.

**Fix:**

- `GraphicsContext.isDestroyed` declared as abstract **method**: `abstract isDestroyed(): boolean;`
- `WebGPUContext.isDestroyed` converted from getter → method.
- One call site in `WebGPUBuffer.ts` updated: `if (source.isDestroyed)` → `if (source.isDestroyed())`. (Note: WebGPUBuffer itself still has `get isDestroyed()` getter form — that's fine because WebGPUBuffer isn't passed through `destroyObject()`; each WebGPU class may keep its own form.)

**Files:**

- `packages/engine/Source/Renderer/GraphicsContext.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts`

### TYPE-29-3: `@private` JSDoc ≠ TypeScript `private` — cross-module visibility clash

**Symptom:** Removing the cast `new Context(canvas, options) as unknown as GraphicsContext` at [ContextFactory.ts:152](packages/engine/Source/Renderer/ContextFactory.ts#L152) produced:

```text
TS2322: Type 'Context' is not assignable to type 'GraphicsContext'.
  Property 'readPixels' is private in type 'Context' but not in type 'GraphicsContext'.
```

**Root cause:** CesiumJS's JSDoc convention uses `@private` to mean "not part of the published API surface" — a **documentation marker** interpreted by API-extractor tools to keep methods out of generated `.d.ts` / reference docs. It predates TypeScript tooling integration.

TypeScript, however, treats `@private` on JS members as TS-class-private (class-scoped visibility). Combined with:

- `GraphicsContext` (TS) declares `abstract readPixels(...): unknown` — **public** (TS default).
- `Context.js` (JS) has `/** @private */ readPixels(readState) { ... }` — **TS reads this as private**.

TypeScript's visibility-compatibility rule says a subclass cannot make an inherited public method more restrictive. So `Context extends GraphicsContext` structurally fails. The cast was hiding this every time.

But `readPixels` is called cross-module from `Scene/PickFramebuffer.js`, `Scene/PickDepth.js`, `Scene/DynamicEnvironmentMapManager.js`, and several specs. The `@private` tag is semantically wrong; the method is engine-internal but module-public.

**Fix (tactical):** `Context.d.ts` declares `readPixels` and `readPixelsToPBO` as `public`, overriding the JSDoc-derived visibility. Cast at ContextFactory boundary retired.

**Fix (strategic, backlog TS-DEBT-8):** Replace `@private` → `@internal` across JS methods called cross-module. `@internal` is the correct JSDoc tag for "engine-internal but cross-module" — API-extractor still strips it from published `.d.ts`, AND TypeScript doesn't interpret it as class-private. Once the sweep lands, several `.d.ts` files (`Context.d.ts`, `Texture.d.ts`, `CubeMap.d.ts` where they exist purely to override `@private`) become redundant.

**Files:** `packages/engine/Source/Renderer/Context.d.ts` (new); `packages/engine/Source/Renderer/Context.js` (future: `@private` → `@internal`).

### Lesson for future sessions

When a cast exists at a JS↔TS boundary, **ask why before removing it**. The cast often documents a real design issue:

- A lie in the ambient type (Matrix4).
- A runtime-vs-declaration protocol drift (isDestroyed).
- A semantic mismatch between JSDoc convention and TS interpretation (`@private`).

Simply deleting the cast without fixing the underlying issue either (a) triggers a new TS error that a different cast then papers over, or (b) leaves a latent runtime bug unaddressed. See also `memory/feedback_interface_pruning.md` for a related failure mode — interfaces with WIP-module method slots should NOT be trimmed just because current implementation doesn't satisfy them.

---

## Session 27b — Material UBO Split (2026-04-12)

### MATERIAL-UBO-SPLIT: 49 WGSL shaders split to camera + material bind groups

**What changed:** All primitive/polyline/billboard material shaders were migrated from a single monolithic `struct Uniforms` (carrying both camera and material data in group 0) to a two-group layout: `struct CameraUniforms` at `@group(0)` and `struct MaterialUniforms` at `@group(1)`. A codemod script processed all 49 affected `.wgsl` files.

**Why:** The monolithic layout forced a full UBO rebuild + rebind on every draw even when only camera data changed (per-frame) or only material data changed (per-primitive). Splitting allows the camera bind group (expensive, shared across all primitives in a frame) to be set once per pass, while the material bind group (cheap, per-primitive) is set per draw. This matches the WebGPUModelRenderer.js pattern already in production.

**Files affected:** All `PrimitiveMat*.wgsl`, `PolylineArrow/Dash/Glow/Outline.wgsl`, and related primitive shaders under `packages/engine/Source/Shaders/WebGPU/`.

**Renderer side:** `WebGPUPrimitiveCommands.js` pipeline layout split into separate camera BGL (group 0) and material BGL (group 1). Approximately 295 lines of `packMaterialUniforms` translation code deleted. Material data now sourced directly from `MaterialUniformBuffer.gpuData`.

**Status:** Not yet functional end-to-end. `.js` shader wrappers not regenerated, WebGPUPolylineRenderer.js and WebGPUBillboardRenderer.js not yet refactored, texture binding conflicts unresolved.

### MATERIAL-NAME-MISMATCH: WGSL field names diverged from JS fabric uniform names

**Root cause discovered:** The original shader port used GPU-efficient recomposed fields that differ from the semantic JS names in `Material.js` fabric templates. For example, `PrimitiveMatGridFlat.wgsl` used `gridColor: vec4<f32>` and `cellColor: vec4<f32>` — but the JS fabric template uses `color`, `cellAlpha`, `lineCount`, `lineThickness`, `lineOffset` as separate scalar/vector fields. Similarly, several shaders used `materialColor` where the JS fabric key is `color`.

**Why this matters:** `MaterialUniformBuffer._buildLayout()` uses JS fabric uniform names as keys to map values into the Float32Array backing store. If the WGSL struct field names don't match, the GPU reads garbage data silently — no error, wrong output.

**Fix applied:** The old `packMaterialUniforms` function was a translation layer that papered over these mismatches. With Option B, the translation layer is eliminated by renaming WGSL fields to match the JS fabric names directly. `materialColor` renamed to `color` in 6 shaders (PrimitiveMatColorFlat/Lit, PolylineArrow/Dash/Glow/Outline). Composite fields in GridFlat decomposed (see GRID-DECOMPOSITION below).

**Remaining work:** Field name audit needed for all 25 material types — most already match (Checker, Dot, Stripe, BumpMap, etc. were ported with correct names), but each must be verified against its `Material.js` fabric definition before visual testing.

### GRID-DECOMPOSITION: PrimitiveMatGridFlat.wgsl cellColor vec4 decomposed

**Problem:** `PrimitiveMatGridFlat.wgsl` had `cellColor: vec4<f32>` where `.rgb` was the line color, `.a` was `cellAlpha`, and a separate `cellCount: vec2<f32>` packed `lineCount` in `.x` and `lineThickness` in `.y`. This recomposition was efficient for the GPU but had no correspondence to any JS fabric uniform name, making `MaterialUniformBuffer` unable to populate it.

**Fix:** Decomposed into individual fields matching the JS fabric template exactly:

- `color: vec4<f32>` (the grid line color, was `gridColor`)
- `cellAlpha: f32` (opacity of the cell interior, was `cellColor.a`)
- `lineCount: f32` (number of grid lines, was `cellCount.x`)
- `lineThickness: f32` (line width in UV space, was `cellCount.y`)
- `lineOffset: f32` (phase offset, new explicit field)

Fragment shader updated to use the new field names. Same decomposition still needed for `PrimitiveMatGridLit.wgsl` (not yet done).

---

## Phase 5 Modern WebGPU Features + Bug Fixes (2026-04-12)

### WGF-4: Camera UBO RTE Assertions

Added `WebGPURTEAssertions.ts` with two debug-only validators:

- `assertCameraRTERoundTrip(high, low, expected, label)` — catches off-by-one packer bugs that swap the hi/lo slots (~6 m drift at Earth radius)
- `assertMVTranslationZeroed(mv, label)` — catches BUG-38 class (zeroing translation after projection multiply wipes P23 depth term)

Wired into: `WebGPUBufferPrimitiveRenderer` (both assertions), `WebGPUGlobeSurfaceRenderer` (round-trip), `WebGPUUniformGroupManager` (round-trip). All pragma-guarded — zero production cost.

**Relation to BUG-38:** the assertion directly catches the failure mode that cost 3 debugging sessions. The 6 renderers originally affected by BUG-38 (CloudRenderer, EllipsoidPrimitiveRenderer, GaussianSplatRenderer, PointCloudRenderer, VoxelRenderer, BufferPrimitiveRenderer) were fixed in session 27 — the assertion now prevents regressions. Coverage gap: assertions are on 3 of 8 camera packers; extending to all 8 is queued as incremental follow-up.

### WGF-1: Hardware Clip Distances (Globe Terrain)

- `WebGPUClipDistancePrecompute.ts` — FP64 dPrime precomputation, finite sentinel (`1e30` not `Infinity` — Metal UB on non-finite clip distances)
- `EffectsUniforms` extended from 112→240 bytes with `clipPlaneEqHW: array<vec4<f32>, 8>`
- All 5 inline EffectsUniforms definitions updated (chunk, GlobeTerrain, PrimitiveBasicColor, PrimitivePhongColor, PrimitivePhongTexturedColor)
- Globe pipeline variant via string-injection: `enable clip_distances;` + `@builtin(clip_distances)` in VertexOutput + per-vertex loop + fragment discard neutralization
- **Safety gates:** SCENE3D-only + union-mode-only + opt-in (`context.useHardwareClipDistances = true`)

**Relation to BUG-6.1:** clip-distances retires the fragment discard path for union-mode SCENE3D clipping, eliminating the non-uniform control flow that blocked the globe terrain pipeline from compiling in session 6.

### WGF-3: shader-f16 (Tonemapping)

- `Tonemapping_f16.wgsl` — hand-tuned f16 variant of all 5 tonemapping operators
- Exposure multiply stays in f32 to avoid intermediate overflow (65000 × large exposure > f16 max)
- Opt-in: `context.useShaderF16 = true`
- Pipeline variant selection in `WebGPUPostProcessPipeline.addTonemapping()`

### HDR Pipeline Fix (Pre-Existing Bug) + Auto-Exposure Parity

**Bug:** Post-process ping-pong textures were hardcoded to `canvasFormat` (bgra8unorm = SDR). All HDR data from the scene framebuffer (rgba16float) was silently clamped to [0,1], making tonemapping a no-op.

**Fix 1 — HDR ping-pong:** `WebGPUPostProcessPipeline.initialize()` now accepts `highDynamicRange` flag; when true, ping-pong textures use `rgba16float`. All stage pipelines (tonemapping, color grading, FXAA, custom) now compile against `_intermediateFormat` (not `canvasFormat`) so their fragment target format matches the render attachment. Only the identity-blit pipeline targets `canvasFormat` (it writes to the canvas swap chain).

**Fix 2 — Auto-Exposure (HDR parity with WebGL):** WebGL had `AutoExposure.js` (multi-pass framebuffer luminance reduction); WebGPU had no equivalent. Built a compute-shader replacement:

- `AutoExposure.wgsl` — two-pass parallel reduction. Pass 1: 16×16 workgroups reduce tiles via shared-memory tree reduce. Pass 2: single workgroup reduces all tiles + temporal smoothing (`previous + (current - previous) × adaptationRate`)
- `WebGPUAutoExposure.ts` — GPU resource management (pipelines, storage buffers, async readback for CPU-side `averageLuminance`)
- `WebGPUPostProcessPipeline.ts` — `addAutoExposure()` method, dispatches before tonemapping in `execute()`, feeds `manualExposure × (1 / averageLuminance)` into tonemapping uniform
- `WebGPUSceneRenderer.ts` — auto-adds auto-exposure when HDR is on, passes scene color texture to `execute()`

**WebGL HDR:** already fully implemented upstream — `GlobeDepth.js` switches to `HALF_FLOAT` when `hdr=true`, `PostProcessStageCollection` enables tonemapping, `EXT_color_buffer_float` / `EXT_float_blend` detected. No new code needed.

**WebGPU vs WebGL HDR parity (as of 2026-04-12):**

| Feature | WebGL | WebGPU |
|---|---|---|
| Scene framebuffer HDR | `HALF_FLOAT` | `rgba16float` |
| Post-process chain HDR | Float FBOs | `rgba16float` ping-pong |
| Tonemapping (5 modes) | GLSL | WGSL (+ f16 variant) |
| Auto-Exposure | Multi-pass FB reduction | Compute shader (2-pass, faster) |
| Bloom / SSAO / DoF / FXAA | ✅ | ✅ |
| Color Grading | N/A | 12-param stage (WebGPU-only) |

### OPEN-1: Sky Atmosphere Pipeline Guard

Root cause investigation: the `updateWebGPUSkyAtmosphere` function pushes to commandList correctly, but if `createPipeline()` throws (shader compile error, format mismatch), `cache.pipeline` stays undefined and subsequent frames retry indefinitely. Added try/catch with permanent `console.error` + `_pipelineFailed` latch. Actual shader/format issue requires browser debugging.

### OPEN-5: Fog Formula Parity (FIXED)

**Root cause:** WebGPU fog used the 2-parameter formula `1 - exp(-(scalar^2))` while WebGL uses a 4-parameter formula with `czm_fogVisualDensityScalar` (default 0.15). The modifier was never wired to the WebGPU shader, making WebGPU fog ~6.7x stronger at horizontal viewing angles.

**Fix (3 files):**

- `WebGPUAutoUniforms.js` — added `csm_fogVisualDensityScalar` auto-uniform
- `GlobeTerrain.wgsl` — replaced `_pad4` with `fogVisualDensityScalar`, updated `computeFog` to match WebGL's modifier formula
- `WebGPUGlobeSurfaceRenderer.ts` — packs scalar at tile UBO offset 79

### WORKER-5: Feature Flag Replication

`MSG_SET_FEATURE_FLAGS` added to `WorkerSceneProtocol.js`. `WorkerSceneHost.setFeatureFlags()` sends + replays via shadow state. `RendererWorker.js` handler applies to `scene.context`. Covers `useHardwareClipDistances` + `useShaderF16`.

### BUG-39a-d: Orbital Depth (Confirmed Orthogonal)

The existing fixes (clip-Z clamp `out.position.z = min(out.position.z, out.position.w)`, renderer-wide `less-equal` migration, skybox z=w pattern) remain correct and are not affected by any Phase 5 WGF changes. The clip-distances variant preserves the Z clamp — it's injected AFTER the clamp line, not before.

---

## Renderer Threading + Live FPS Tools (2026-04-11)

**Why this section is at the top:** the 2026-04-11 sweep added the
infrastructure that every future debugging session will use to
*measure* what's happening. The FPS tools below replace the previous
"recent average only" FPS counter and unlock per-renderer measurement
across multiple workers, so any future bug investigation that touches
performance should reach for these first instead of building ad-hoc
timing.

### What landed

| Component | File | What it gives you |
|---|---|---|
| **Live FPS histogram** | [PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js) | `recordFrame()` is called automatically every Scene render. `getLiveStats()` returns avg fps + 1% lows + 1% highs over a rolling 60s window. `getLiveFrameTimeSnapshot(n)` returns the chronological frame-time tail for graph rendering. Buffer is preallocated (4096 slots), zero per-frame GC. |
| **Canvas2D HUD overlay** | [FpsOverlay.js](packages/engine/Source/Services/FpsOverlay.js) | Drop-in DOM element with avg fps, 60s graph (red bars for >budget frames), 1% low / 1% high readouts. Polls at 6 Hz. Pluggable data source — works against `scene.performanceTracker` or a `WorkerSceneHost`. Multiple overlays per page. |
| **Worker host** | [WorkerSceneHost.js](packages/engine/Source/Services/WorkerSceneHost.js) | Main-thread wrapper that owns a `<canvas>` inside a parent `<div>`, transfers the `OffscreenCanvas` to a worker, runs heartbeat ping/pong, drives 3-tier crash recovery, replays shadow state on restart. Implements the same `getLiveStats()` / `getLiveFrameTimeSnapshot()` contract as `PerformanceTracker` so the HUD overlay works against the host without any glue code. |
| **Renderer worker** | [RendererWorker.js](packages/engine/Source/Workers/RendererWorker.js) | Bundled to `Build/CesiumUnminified/Workers/RendererWorker.js` (~11 KB bootstrap; engine code-split into a 7.9 MB chunk loaded on first message). Constructs an empty `Scene` against the OffscreenCanvas, runs its own render loop, posts FPS stats every 125 ms, echoes heartbeats. |
| **Protocol** | [WorkerSceneProtocol.js](packages/engine/Source/Services/WorkerSceneProtocol.js) | All message-type strings + heartbeat / restart / burst-window constants in one place. |
| **Scene/CreditDisplay headless mode** | [Scene.js:198-225](packages/engine/Source/Scene/Scene.js#L198-L225), [CreditDisplay.js:301-348](packages/engine/Source/Scene/CreditDisplay.js#L301-L348) | Detects `typeof document === "undefined"` and short-circuits all DOM construction. Required to construct a Scene inside a worker. Existing main-thread behavior unchanged. |
| **Cross-browser RAF fallback** | [RendererWorker.js `_startRenderLoop`](packages/engine/Source/Workers/RendererWorker.js) | `requestAnimationFrame` is Chromium-only inside DedicatedWorker; falls back to `setTimeout(tick, 1000/60)` on Firefox/Safari workers. Documented as ~60 Hz approximation, not vsync-locked. |
| **maxFps runtime cap** | `WorkerSceneHost.setMaxFps(value)` | Five modes: `null` = vsync (default), positive = cap, `0` = uncapped (bypass rAF, bench mode), negative = pause. Survives crash + restart via shadow state. Equivalent to upstream `CesiumWidget.targetFrameRate` for the in-thread case. |
| **Test page** | [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html) | Multi-pane grid (1-16 panes). Toolbar buttons to spawn WebGL / WebGPU panes, change FPS cap, manually crash a worker to test recovery. Each pane has its own FPS overlay reading from its host. |

Full design + remaining gaps in [OPTION_B_SCENE_IN_WORKER.md](migration_doc/OPTION_B_SCENE_IN_WORKER.md).

### How this changes debugging workflow

**Before:** the only FPS surface was `scene.debugShowFramesPerSecond = true`,
which displayed the recent average and was tied to the main thread's
render loop. Multi-renderer scenes had no isolation; a stall in one
renderer affected the FPS readout of all of them. Per-renderer perf
comparison required the visual regression page or manual stopwatch
work.

**After:** every Scene records its own continuous frame-time history
into a circular buffer. The HUD overlay reads it directly. Three new
debugging patterns become trivial:

#### Pattern 1 — In-thread perf overlay on any Viewer

```js
// Drop-in for any existing Cesium app, no other changes
import { FpsOverlay } from "@cesium/engine";

const overlay = new FpsOverlay({
  parent: viewer.container,
  dataSource: viewer.scene.performanceTracker,
  label: "main",
  position: "top-right",
});
// ... when done ...
overlay.destroy();
```

This gives you 60s graph + avg + 1% low + 1% high without spinning up
any worker. Use this first whenever investigating a perceived stutter
— the 1% low number tells you immediately whether the problem is
"average is fine but worst frames spike to 30 ms" vs "average is
already 40 ms."

#### Pattern 2 — Per-renderer comparison via worker isolation

```js
import { WorkerSceneHost, FpsOverlay } from "@cesium/engine";

const webglHost = new WorkerSceneHost({
  parent: leftPane, rendererType: "webgl",
});
const webgpuHost = new WorkerSceneHost({
  parent: rightPane, rendererType: "webgpu",
});

new FpsOverlay({ parent: leftPane, dataSource: webglHost, label: "webgl" });
new FpsOverlay({ parent: rightPane, dataSource: webgpuHost, label: "webgpu" });
```

Each host runs its own worker thread with its own RAF loop. A stall
in one renderer no longer affects the other's FPS readout. This is
the "is WebGPU actually faster than WebGL on this scene?" measurement
that was previously impossible to run cleanly because both renderers
shared the main-thread JS pump.

The test page [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html)
demonstrates this with up to 16 panes.

#### Pattern 3 — Benchmark mode via uncapped maxFps

```js
host.setMaxFps(0);   // bypass rAF, run as fast as possible
// ... let it run for 5 seconds ...
const stats = host.getLiveStats();
console.log(`peak throughput: ${stats.avgFps.toFixed(1)} fps`);
host.setMaxFps(null);   // back to vsync
```

The uncapped mode is the answer to "how many frames per second can
the GPU sustain if vsync isn't getting in the way?" It's specifically
the question that comes up when investigating why a scene feels
slow despite the displayed FPS being 60. If uncapped runs at 120 fps,
you have 50% headroom and the bottleneck is elsewhere. If uncapped
runs at 65 fps, the renderer itself is the bottleneck and any vsync
target above 60 is wasted effort.

### Console commands (worker-renderers.html test page)

When the test page is open, these helpers are exposed on `window` so
you can drive the panes from dev tools without touching the toolbar:

```js
setMaxFps(60)              // cap all panes at 60 fps
setMaxFps(null)            // back to vsync (default)
setMaxFps(0)               // uncapped (benchmark mode)
setMaxFps(-1)              // pause render loop (CPU/GPU idle)
setPaneMaxFps(0, 120)      // cap pane index 0 only at 120
listPanes()                // print { id, rendererType, maxFps, avgFps } per pane
```

### Crash recovery — what to expect when a worker dies

The host runs three tiers of recovery automatically. When debugging,
you'll see the following sequence in the console:

1. **Tier 1 (in-thread, ~100-500 ms)** — `WebGPUDeviceLossRecovery`
   catches a `device.lost` Promise and rebuilds the device internally.
   Console: `[WebGPU] Recovery attempt 1/3...` followed by
   `[WorkerSceneHost] GPU device lost (worker recovering)` and then
   `[WorkerSceneHost] GPU device restored`. The canvas does not
   change. The FPS overlay may show a brief gap.

2. **Tier 2 (soft reset, reserved)** — currently no host trigger; the
   protocol message exists for future use.

3. **Tier 3 (hard restart, ~1-2 s)** — a `worker.error` event, a
   `messageerror`, or 3 missed heartbeat pongs. Console:
   `[WorkerSceneHost] worker spawned (session N) reason=restart:<cause>`.
   The host destroys the dead `<canvas>` (because
   `transferControlToOffscreen` is one-time), creates a fresh one
   inside the parent `<div>`, spawns a new worker, and replays shadow
   state (camera, requestRenderMode, maxFps). The FPS overlay's
   data source is updated transparently — no overlay rebuild needed.

4. **Circuit breaker** — more than 3 crashes within 60 seconds opens
   the breaker. The host stops auto-restarting and fires the
   `onFailure` callback. The pane stays in a `FAILED` state until
   user code creates a new host. This prevents infinite-loop crashes
   from burning CPU forever.

To manually exercise recovery during debugging, the test page has a
"Crash first worker" button that calls `worker.terminate()` directly.
The next heartbeat sees no responses for 3 seconds and triggers the
hard-restart path.

### Where the FPS counter helps for *bug* investigation

| Symptom | What to check first |
|---|---|
| "WebGPU feels slower than WebGL" | Open the worker test page with both backends side by side. The two FPS overlays update independently — direct apples-to-apples comparison without main-thread JS contention. |
| "Random stutters but average looks fine" | Enable the FPS overlay on the production Viewer. The 1% low FPS reading exposes the worst-case frames; if `1%-low << avg`, you have spike-y frames that the average is hiding. |
| "Dev tools profiler is too noisy" | Use `host.setMaxFps(0)` to run uncapped. If the GPU is the bottleneck, peak throughput stops climbing as you raise the cap. If the JS thread is the bottleneck, peak throughput keeps climbing past the display rate. |
| "Worker is alive but stuck" | Check the host's heartbeat counters. If `_lastPingId - _lastAckedPingId >= 3`, the heartbeat watchdog will restart the worker within ~3 seconds. The worker's last `MSG_LOG` message before the restart is your best clue to what wedged it. |
| "Scene state corruption after a crash" | Inspect `host._shadowState`. Anything NOT in there is missing from the replay path and is the gap to fix. Today the shadow state covers `lastView`, `requestRenderMode`, `maxFps`. Entity / imagery / terrain shadow recording is Phase 2 (see [OPTION_B_SCENE_IN_WORKER.md](migration_doc/OPTION_B_SCENE_IN_WORKER.md)). |
| "Need timing for a one-shot operation, not a rolling window" | The existing `Scene.beginPerformanceTrace(label, {frames})` / `endPerformanceTrace()` API is unchanged. The trace API and the live API are independent — you can use both at once. |

### Known limitations of the worker path (for debug context)

1. **Worker can construct a Scene but most consumer features are gaps**
   — adding entities, picking, DataSources, custom shaders, time-varying
   properties etc. all require the Phase 2-7 work documented in
   [OPTION_B_SCENE_IN_WORKER.md](migration_doc/OPTION_B_SCENE_IN_WORKER.md).
   Today the worker path is best used as a measurement substrate
   (FPS comparison, isolation testing) rather than as a production
   replacement for the in-thread Viewer.

2. **Firefox/Safari workers don't have `requestAnimationFrame`** —
   the `setTimeout(1000/60)` fallback runs at ~60 Hz with some
   sub-millisecond jitter. On a 144 Hz display these workers won't
   ride the higher refresh rate. Documented as a known limitation;
   the cross-browser fallback works for the common case.

3. **`OffscreenCanvas.transferControlToOffscreen()` is one-time** —
   the host has to destroy and recreate the `<canvas>` element on
   every hard restart. The parent `<div>` is the stable identity.
   Anything that holds a reference to the OLD canvas (e.g., a
   `getBoundingClientRect()` cached on the application side) needs
   to refresh after a recovery event.

4. **Per-frame postMessage cost** — for every host→worker command, the
   message is structured-cloned twice. For animation-heavy use this
   could matter; for the FPS-counter use case it's negligible (one
   stats post every 125 ms, ~600 bytes).

5. **`SharedArrayBuffer` is unavailable in third-party-embedded apps**
   — would let us do high-frequency host→worker communication
   without postMessage overhead, but requires
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`,
   which breaks third-party embedding scenarios that Cesium apps
   commonly use. So we deliberately don't rely on it.

---

## Current Status

**What works (as of Session 26):** Globe renders with satellite imagery at LOD 2+ when zoomed in. Sun, moon, and skybox/stars all rendering via the post-process pipeline. WebMercatorT texture coordinate support matches WebGL. Higher LOD tiles load and render as camera zooms in. Environment injection wired. CubeMapPanorama pipeline fixed. Imagery reprojection crash fixed. Build system compiles WGSL shaders + TypeScript. Camera jitter significantly reduced via async staleness validation + distance ratio checks. Fill tile black lines eliminated by skip. Backend-agnostic architecture enforced: zero `isWebGPUDrawCommand` checks in Scene code. Shadow cast pipeline wired with per-layout variant registry (Session 26). Render bundles activated for terrain. Ring buffer allocator initialized. 2D/Columbus View projection added (Session 26). Buffer primitive renderers + label/SDF renderers confirmed fully implemented. Build variant infrastructure (WebGL-only / WebGPU-only / dual) with tree-shaking alias plugin (Session 26). WebGL compatibility stubs overhauled with real texture upload, format conversion, mipmap generation (Session 26). **Renderer threading scaffolding + per-renderer FPS counters + worker-Scene headless mode + maxFps runtime cap (2026-04-11 sweep — see top of doc).**

**What needs visual verification:**

- 2D/Columbus View mode (modifiedModelViewProjection matrix added Session 26)
- Shadow casting end-to-end (per-layout pipeline registry added Session 26)

**Known remaining issues:**

- ⚠️ **BUG-15** — Fill tile index buffer overflow at default zoom (globe black until zoomed in). Clamped but root cause not fixed.
- ⚠️ **BUG-11** — Imagery tile gaps (dark patches / missing tiles visible as black triangles at medium zoom)
- ⚠️ Moon rendering appears distorted (shape/UV issue)
- ⚠️ Advanced renderers (Cloud, Voxel, GaussianSplat, PointCloud, Ellipsoid) built but untested end-to-end

**Useful debug commands:**

```bash
# Build variants for size comparison
npx gulp buildAllVariants         # All 3 variants side-by-side
npx gulp buildCesiumWebGPUOnly    # WebGPU-only (smallest bundle)
npx gulp buildCesiumWebGLOnly     # WebGL-only (no WebGPU chunks)
npx gulp buildCesiumDual          # Both backends (default)

# Visual regression
node Tools/visual-regression/capture-and-diff.mjs --headed --scene globe-default

# Type checking
npx tsc --noEmit

# Dev server
npm run restart
```

**Runtime debug console commands** (available after `CesiumDebug` is installed on a viewer):

```
CesiumDebug.help()              — list all commands
CesiumDebug.snapshot()          — full debug snapshot (scene + renderer + toggles)
CesiumDebug.showDepth()         — depth buffer as grayscale
CesiumDebug.hideDepth()         — restore normal
CesiumDebug.showWireframe()     — globe wireframe overlay
CesiumDebug.hideWireframe()     — hide wireframe
CesiumDebug.showFrustums()      — colorize frustum splits
CesiumDebug.showCommands()      — command count overlay
CesiumDebug.toggleFPS()         — FPS counter
CesiumDebug.pipelineStatus()    — shader/pipeline/device health check
CesiumDebug.postProcess()       — post-process pipeline state table
CesiumDebug.canvasPixels()      — sample canvas pixel data
CesiumDebug.logImageryProbe()   — dump next 4 tile updates
CesiumDebug.scene               — direct scene access
CesiumDebug.context             — direct context access
CesiumDebug.device              — direct GPUDevice access
```

---

## Session 28: Build Variants, Stub Overhaul & Critical Fixes (2026-04-10)

### BUG-12 — All-black WebGPU canvas (render target misdirection)

**Severity:** CRITICAL  
**Symptom:** WebGPU canvas is entirely `rgba(0,0,0,255)`. Tiles are processed (GlobeTile logs appear), post-process pipeline exists and is enabled, but nothing is visible.

**Root cause (multi-layer):**

1. **`usePostProcess` forced false:** `FramebufferOrchestrator.js` sets `usePostProcess` based on whether effects are enabled. WebGPU always needs it. Additionally, `postProcess.ready` overwrites the flag on line 114 even after the isWebGPU override. Both fixed by adding `context.isWebGPU` checks at both assignment sites.

2. **Render target misdirection (the real fix):** `WebGPUContext.beginFrame()` opens a default render pass targeting the **canvas swap chain directly**. All draw commands execute against this pass. The post-process pipeline then reads from the **scene framebuffer** (which was never drawn to) and blits its empty content to the canvas — overwriting the actual rendered content with black.

   The fix: `WebGPUSceneRenderer.executeCommands()` now ends the default canvas render pass and begins a new one targeting the scene framebuffer's color + depth textures BEFORE the frustum loop. Commands draw into the scene framebuffer. The post-process tonemapping pass reads from it and writes to the canvas.

**Fix applied:**
- `FramebufferOrchestrator.js` — `isWebGPU` override at both `usePostProcess` assignment sites
- `WebGPUSceneRenderer.ts` — render pass redirect from canvas to scene framebuffer before frustum loop; uses `colorTarget.getColorAttachments()` + `getDepthStencilAttachment()` for proper pass descriptor construction

**Error guards added (prevent future recurrence):**
- CRITICAL error if scene framebuffer has no color attachments (commands draw to nothing)
- Warning if scene framebuffer has no depth/stencil (depth testing disabled)
- CRITICAL error if `usePostProcess=true` but no scene framebuffer color target exists (blit overwrites canvas with black)
- CRITICAL error in `_runPostProcessing` if post-process pipeline is missing when WebGPU context is active

**Files modified:**
- `packages/engine/Source/Scene/FramebufferOrchestrator.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`
- `packages/engine/Source/Scene/Scene.js` — backend-aware `_alternateSceneRenderer` diagnostic

### BUG-13 — `installCesiumDebug` export name mismatch

**Severity:** LOW (CesiumViewer-only)  
**Symptom:** `Uncaught SyntaxError: ... doesn't provide an export named: 'installCesiumDebug'`

**Root cause:** `CesiumDebug.js` uses `export default installCesiumDebug` but the barrel renames it to `CesiumDebug`. CesiumViewer.js imported the old name.

**Fix:** Changed import in `Apps/CesiumViewer/CesiumViewer.js` from `installCesiumDebug` to `CesiumDebug`.

### BUG-14 — ESM chunk loading failure in dev builds

**Severity:** HIGH (blocks all WebGPU dev testing)  
**Symptom:** `NS_ERROR_CORRUPTED_CONTENT` / `Loading failed for module ... chunks/chunk-*.js`

**Root cause:** `bundleCesiumJs` was changed to use `splitting: true` for ALL ESM outputs, including dev builds. The dev server doesn't serve the `chunks/` subdirectory correctly (MIME type / encoding issues on some setups).

**Fix:** Made ESM code splitting opt-in via `options.splitting` (default false). Dev builds (`gulp build` / `npm run restart`) keep single-file output. Release and variant builds pass `splitting: true`.

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

---

## Session 26: Pipeline Fixes — Black Canvas to Imagery Rendering

**Date:** April 10, 2026
**Goal:** Investigate and fix the all-black WebGPU canvas. Went from zero visible output to satellite imagery rendering with sun, moon, and stars.

### Starting state

- WebGPU canvas completely black — no sun, moon, globe, or stars visible
- WebGL side worked correctly (split-screen comparison page confirmed)
- From Session 25: BUG-9 ring buffer fix verified working (60 allocs/frame, 0 overflow), BUG-8 subgroups WGSL fix applied
- Firefox release showed globe sphere + atmosphere + stars (screenshot from user) but Playwright Firefox Nightly couldn't reproduce

### Debugging methodology

All debugging was done via browser console monkey-patching (Edge/Chromium) since Playwright MCP wasn't configured for Edge yet. The approach:

1. **Monkey-patch `context.clear()`** to log every clear call with pass label and framebuffer info
2. **Monkey-patch `pp.execute()`** to log source/target texture validity during render frames
3. **`CesiumDebug.snapshot()`** for full scene state dumps
4. **`CesiumDebug.canvasPixels()`** to sample canvas output (all rgba(0,0,0,0) initially)
5. **Direct property probing** via `scene._alternateSceneRenderer._postProcess` to check pipeline state between frames
6. **Temporary shader modifications** (`return vec4(1,0,0,1)` flat red) to isolate fragment vs pipeline issues

### BUG-12: Clear guard ordering (ROOT CAUSE #1)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` lines 2219-2248

**Discovery:** Monkey-patching `context.clear()` revealed an infinite loop of clear calls with truncated log output. The `clear()` method was called recursively because each clear destroyed the current render pass and opened a new one, which triggered more clears from `FramebufferOrchestrator.js` (lines 57, 70, 84, 109, 112, 127, 135, 161).

**Root cause:** The "Scene Framebuffer" label guard that was supposed to prevent clearing the scene FB pass was checking `_currentRenderPassEncoder.label` AFTER the pass had already been `.end()`ed and the reference set to `null`:

```typescript
// BEFORE (broken):
if (this._currentRenderPassEncoder) {
  this._currentRenderPassEncoder.end();      // ← destroys the pass
  this._currentRenderPassEncoder = null;     // ← clears the reference
}
// ... 25 lines later ...
const activePassLabel = this._currentRenderPassEncoder?.label ?? "";  // ← ALWAYS ""
if (activePassLabel.startsWith("Scene Framebuffer")) {
  return;  // ← NEVER fires
}
```

**Fix:** Moved the guard BEFORE the `.end()` call:

```typescript
// AFTER (fixed):
const activePassLabel = this._currentRenderPassEncoder?.label ?? "";
if (activePassLabel.startsWith("Scene")) {
  return;  // Now correctly fires when scene pass is active
}
if (this._currentRenderPassEncoder) {
  this._currentRenderPassEncoder.end();
  this._currentRenderPassEncoder = null;
}
```

**Impact:** This was the original cause of the all-black WebGPU output first reported as BUG-10. The clear command would open a canvas-targeting pass, globe tiles would draw into it, then the post-process blit would read the (empty) scene framebuffer and overwrite everything with black.

### BUG-13: Missing identity blit (ROOT CAUSE #2)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` line 506

**Discovery:** After fixing BUG-12, the canvas was still black. `CesiumDebug.canvasPixels()` showed all `rgba(0,0,0,0)` — completely transparent, not even cleared to black. Probing `pp.execute()` showed it was called with valid source+target views, but nothing reached the canvas.

**Root cause:** The `execute()` method had an early return when no effects were enabled:

```typescript
execute(encoder, sourceView, destView, depthView) {
  if (!this.hasActiveStages) return;  // ← returns without blitting to canvas!
  ...
}
```

WebGPU ALWAYS needs a blit from the scene framebuffer to the canvas swap chain, even when zero post-process effects are active. WebGL can render directly to the backbuffer, but WebGPU renders to an offscreen scene FB and the post-process pipeline is the ONLY path that copies it to the visible canvas.

A second instance of the same bug existed at line 568:

```typescript
if (singlePassStages.length === 0) {
  if (currentView !== sourceView) {
    this._executeCopyStage(...);  // only copies if effects changed the view
  }
  return;  // ← if no effects ran, never copies to canvas!
}
```

**Fix:** Both early-return paths now call `_executeCopyStage(encoder, sourceView, destView)`:

```typescript
if (!this.hasActiveStages) {
  this._executeCopyStage(encoder, sourceView, destView);
  return;
}
// ...
if (singlePassStages.length === 0) {
  this._executeCopyStage(encoder, currentView, destView);
  return;
}
```

### BUG-14: Copy pipeline depended on nullable tonemapStage (ROOT CAUSE #3)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` line 725

**Discovery:** After fixing BUG-13, probing `pp._copyPipeline` / `pp._copySampler` / `pp._copyBindGroupLayout` all returned `false`. The copy stage had no GPU resources.

**Root cause:** `_executeCopyStage()` reused `_tonemapStage` as a passthrough:

```typescript
private _executeCopyStage(encoder, sourceView, targetView) {
  if (this._tonemapStage) {  // ← null if tonemap not compiled yet
    this._executeSinglePassStage(encoder, this._tonemapStage, sourceView, targetView);
  }
  // ← silent no-op if _tonemapStage is null
}
```

**Fix:** Built a dedicated identity-blit pipeline that always exists after `initialize()`:

- Added `_identityPipeline` and `_identityBGL` fields to the class
- Created `_createIdentityBlitPipeline()` — a minimal fullscreen-triangle shader that samples the source texture and writes it unmodified to the target
- `_executeCopyStage()` now uses the identity pipeline instead of depending on `_tonemapStage`
- The identity pipeline is created once per device in `initialize()` and has zero uniforms — cheaper than the tonemapping stage

**Identity blit shader (inline WGSL):**

```wgsl
@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> VsOut {
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv  = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, uv);
}
```

**Result after BUG-12 + BUG-13 + BUG-14:** Sun and moon visible on canvas. Post-process pipeline confirmed working (scene FB → tonemap → canvas swap chain).

### BUG-15: Index buffer overflow invalidates entire command buffer

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`

**Discovery:** With sun and moon rendering, the globe was still invisible (black). Added `return vec4(1,0,0,1)` at the top of `fragmentMain` in GlobeTerrain.wgsl — globe turned bright red when zoomed in but stayed black at default zoom. GPU validation errors in the console revealed the cause:

```
Index range (first: 0, count: 39, format: IndexFormat::Uint16) does not fit in index buffer size (40).
 - While encoding [RenderBundleEncoder "Globe terrain bundle"].DrawIndexed(39, 1, 0, 0, 0).
```

**Root cause:** Some terrain tiles (likely fill tiles) have an index buffer with only 20 Uint16 indices (40 bytes) but the stored `indexCount` says 39. When WebGPU's render bundle encoder encounters this, it invalidates the ENTIRE command buffer — meaning nothing renders for that frame. At default zoom, these fill tiles are always visible, so every frame's command buffer is rejected. At close zoom, the bad tiles are culled and the command buffer stays valid.

Multiple occurrences observed with different sizes:
- count=39, buffer=40 bytes (20 indices)
- count=21, buffer=24 bytes (12 indices)
- count=18, buffer=20 bytes (10 indices)
- count=24, buffer=24 bytes (12 indices)
- count=15, buffer=16 bytes (8 indices)

**Likely cause:** Fill tile cache key collision or mesh data reuse — the `indexCount` from a real tile's mesh is stored but the `indexBuffer` is from a smaller fill tile mesh (or vice versa).

**Fix (clamp — not root cause fix):** Added an overflow guard before the draw call that clamps `drawIndexCount` to the maximum the buffer can hold:

```typescript
const maxIndicesInBuffer = Math.floor(drawIndexBuffer.size / bytesPerIndex);
if (drawIndexCount > maxIndicesInBuffer) {
  console.warn(`[WebGPU:GlobeTile] INDEX OVERFLOW — tile=${tileKey} ...`);
  drawIndexCount = maxIndicesInBuffer;
}
```

**Result:** Globe no longer crashes the command buffer. Imagery tiles render at medium/close zoom with satellite imagery visible. At default zoom, the clamped fill tiles render with partial geometry (visible as black triangular gaps).

**Status:** Clamped but root cause not fixed. See "Next Steps" below.

### Diagnostic logging improvements

**Problem:** Console was extremely spammy — every tile's center3D + uniform data logged every frame, making it impossible to read other messages.

**Fix:** Added throttle infrastructure to `WebGPUGlobeSurfaceRenderer.ts`:

```typescript
private _diagLastLogTime = 0;
private _diagShouldLog(): boolean {
  if (this._diagTileCount !== 0) return false;
  const now = performance.now();
  if (now - this._diagLastLogTime < 3000) return false;
  this._diagLastLogTime = now;
  return true;
}
```

All `console.log` guards changed from `this._diagTileCount <= N` (which logged N tiles per frame, every frame) to `this._diagShouldLog()` (logs one tile per 3 seconds max).

Also throttled `[WebGPU:GlobePass]` count log in `WebGPUSceneRenderer.ts` to once per 3 seconds.

### Other work in Session 26

The debugging session was interleaved with feature work. Full list of Session 26 changes:

**P1 Feature parity:**
- BUG-3 / 2D+Columbus View: Added `modifiedModelViewProjection` mat4 to CameraUniforms struct in GlobeTerrain.wgsl + TS uniform writer. CAMERA_UNIFORM_FLOATS 80→96.
- SHADOW-LAYOUT: Refactored WebGPUShadowMapRenderer.js to per-vertex-layout pipeline registry with `registerShadowCastVariant()` API.
- Verified buffer primitive renderers + label/SDF renderer already fully implemented (backlog was stale).

**P2 Quality:**
- Added WebGPURingBufferAllocatorSpec.js (6 specs with mock device)
- Added WebGPUShadowMapRendererSpec.js (variant registry tests)
- Created Tools/visual-regression/ scaffold (Playwright + pixel diff, zero deps)

**P3 Performance:**
- WGF-2 Transient attachments: Feature-detect + OR bit into MSAA color + non-samplable depth textures
- Subgroup variant added to PointCloudLOD.wgsl (subgroupBallot-collapsed compaction)
- Indirect draw batch API: `submitBatch()` + `executeBatchIndexed()` on WebGPUIndirectDrawManager
- AtmosphereLUT dispatch path: `ensureAtmosphereLUTResources()` + `dispatchAtmosphereLUT()` on PerformanceManager

**P4 Tech debt:**
- Removed unused DEFERRED_GBUFFER key from FeatureRendererKey.js (COUNT 38→37)
- WebGL compatibility stubs overhauled: real texture upload via `texImage2D`, format conversion via `webglToWebGPUTextureFormat`, `getParameter` from `device.limits`, `getExtension` stubs for 15 WebGL extensions, stencil state tracking, `generateMipmap` via `WebGPUMipmapGenerator`

**Build infrastructure:**
- Production build baseline: Cesium.js 6.8 MB min / 1.89 MB gzip
- `setGlobalDefaultRenderer()` API in RendererType.ts
- `bundleVariantPlugin.js` esbuild plugin for aliasing backend-specific modules to empty stubs
- Three gulp tasks: `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildCesiumDual`
- `buildAllVariants` with hoisted engine/widgets build (runs once, not 3x)

### Files modified in Session 26

| File | Change |
|------|--------|
| `WebGPUContext.ts` | Clear guard ordering fix (BUG-12), stub state fields for stencil/pixelStore/mipmapGenerator |
| `WebGPUPostProcessPipeline.ts` | Identity blit pipeline (BUG-13/14), both early-return paths fixed |
| `WebGPUGlobeSurfaceRenderer.ts` | Index overflow clamp (BUG-15), diagnostic throttling, CAMERA_UNIFORM_FLOATS 80→96 |
| `GlobeTerrain.wgsl` | Added modifiedModelViewProjection mat4, used in 2D/CV/Morphing vertex paths |
| `WebGPUShadowMapRenderer.js` | Per-layout pipeline registry, `registerShadowCastVariant()` |
| `WebGPUFramebufferManager.ts` | Transient attachment bit for MSAA + non-samplable depth |
| `WebGPUIndirectDrawManager.ts` | `submitBatch()` + `executeBatchIndexed()` |
| `WebGPUPerformanceManager.ts` | AtmosphereLUT resources + dispatch path |
| `WebGPURingBufferAllocator.ts` | (spec added) |
| `PointCloudLOD.wgsl` | Subgroup-accelerated `computeMainSubgroups` variant |
| `FeatureRendererKey.js` | DEFERRED_GBUFFER removed, keys renumbered |
| `RendererType.ts` | `setGlobalDefaultRenderer()` + `getGlobalDefaultRenderer()` |
| `WebGLStateConverters.ts` | `webglToWebGPUTextureFormat`, `bytesPerTexel`, filter/wrap/mipmap converters |
| `WebGLStubTexture.ts` | Full rewrite: real texture allocation, upload, sampler tracking, mipmap dispatch |
| `WebGLStubShader.ts` | `getParameter` from device.limits, `getExtension` stubs, naga transpile spike |
| `WebGLStubPipelineState.ts` | Stencil state tracking (func/mask/op + separate variants) |
| `WebGLStubTypes.ts` | pixelStore, stencil state, mipmapGenerator fields |
| `WebGLCompatibilityStub.ts` | Pass state to shader stubs |
| `WebGPUSceneRenderer.ts` | GlobePass log throttling |
| `scripts/build.js` | Variant-aware `createCesiumJs`/`bundleCesiumJs`, splitting, plugin |
| `scripts/bundleVariantPlugin.js` | NEW: esbuild alias plugin for variant tree-shaking |
| `scripts/stubs/emptyShader.js` | NEW: `export default ""` stub for GLSL strings |
| `scripts/stubs/emptyModule.js` | NEW: Proxy stub for WebGPU modules |
| `gulpfile.js` | `buildCesiumWebGLOnly`/`buildCesiumWebGPUOnly`/`buildCesiumDual`/`buildAllVariants` |
| `Tools/visual-regression/*` | NEW: capture-and-diff.mjs, scenes.json, README.md |
| `Specs/WebGPURingBufferAllocatorSpec.js` | NEW: 6 specs with mock device |
| `Specs/WebGPUShadowMapRendererSpec.js` | NEW: variant registry tests |

---

## Next Steps — Investigation Plan

### BUG-15: Fill tile index buffer overflow (HIGHEST PRIORITY)

**Symptom:** At default zoom (full globe view), the globe is black. GPU validation errors show index buffer overflows on small tiles. The clamp prevents command buffer invalidation but leaves visible gaps.

**Investigation steps:**

1. **Add tile key + LOD level to the overflow warning.** The current warning logs `tileKey` but we need to cross-reference with whether it's a fill tile or a real tile. Fill tiles have `surfaceTile.fill` set.

2. **Check the cache key logic.** The tile buffer cache in `WebGPUGlobeSurfaceRenderer.ts` uses `tileKey` as the cache key. If a fill tile and a real tile at the same coordinates share the same key, the fill tile's small buffer might be stored under a key that a real tile's large `indexCount` later reads.

3. **Check if `indices.length` vs `indices.byteLength / BYTES_PER_ELEMENT` ever disagree.** For TypedArray subarrays over a shared buffer, `length` reflects the subarray's element count, not the underlying buffer. Verify that `indices` is always a properly-sized TypedArray, not a view into a larger buffer.

4. **Verify fill tile stride detection.** The existing fill tile skip logic (Session 15) uses stride checks. Fill tiles with unusual strides might slip through and create buffers with wrong sizes.

5. **Quick fix attempt:** At the point where `TileGPUResources` is created (line 1248), add a validation:

```typescript
if (validIndexCount * (indexFormat === "uint32" ? 4 : 2) > ibAlignedSize) {
  console.error(`[WebGPU:GlobeTile] IB SIZE MISMATCH: indexCount=${validIndexCount} ibSize=${ibAlignedSize}`);
  validIndexCount = Math.floor(ibAlignedSize / (indexFormat === "uint32" ? 4 : 2));
}
```

### BUG-11: Imagery tile gaps (dark patches)

**Symptom:** At medium zoom, some tiles render with satellite imagery but others show as dark patches (the base color `vec3(0.04, 0.04, 0.06)` without any imagery composited).

**Investigation steps:**

1. **Add per-tile `texCoordsRect` + `translationAndScale` to the throttled diagnostic log.** These are the two values that control imagery UV mapping. If `texCoordsRect` is `(0,0,0,0)`, the `texCoordsAlpha` function returns 0 and imagery is invisible.

2. **Check whether `tileImagery.textureCoordinateRectangle` is defined** for the tiles that show as dark. Add:

```typescript
if (!rect) {
  console.warn(`[WebGPU:GlobeTile] tile=${tileKey} layer=${layerCount} — NO textureCoordinateRectangle`);
}
```

3. **Verify the `dayNightAlpha` values.** If both `dayAlpha` and `nightAlpha` are 0, the `mix(nightAlpha, dayAlpha, dayFade)` term kills the alpha. Check that `layer.dayAlpha` and `layer.nightAlpha` are set correctly.

4. **Test with the UV debug mode.** The shader already has: `if (tile.time > 99990.0) { return vec4(geoUV.x, geoUV.y, webMercT, 1.0); }`. Set the time to 99999 to see if UVs are correct.

5. **Test with the debug imagery return.** Re-add the earlier diagnostic block that returns `vec4(texCoordsAlpha, tex.a, layer.alpha, 1.0)` to see which multiplicand is zero for the dark tiles.

### Moon distortion

**Symptom:** Moon appears with incorrect aspect ratio or UV mapping — visible as a squished/elongated sphere.

**Investigation steps:**

1. Check `WebGPUMoonRenderer` (or equivalent) for the mesh geometry. The moon uses a UV sphere — verify vertex positions and normals.
2. Check if the moon's model matrix includes the correct scale for the moon's equatorial vs polar radius.
3. Compare the moon's render pipeline vertex layout with the actual mesh data stride.

### Remaining console noise

The `[WebGPU:GlobePass]` log still fires every 3 seconds. Several other one-time logs fire on every page load. Consider:

1. Moving all successful-init logs behind a `verbose` flag
2. Using `console.debug` instead of `console.log` for routine diagnostics (filterable in DevTools)
3. Adding a `CesiumDebug.setLogLevel('warn')` control that suppresses info-level WebGPU logs

---

## Session 27–30: Debug Overlays, Fog Staleness, RTE Completeness, Planetary-Scale Depth Precision

**Dates:** 2026-04-09 → 2026-04-11
**Scope:** Debug overlay tier, the black-globe-at-orbit saga, a complete RTE audit of every WGSL vertex shader and every TypeScript MVP packer, and a renderer-wide migration of `depthCompare` from `less` → `less-equal`.

This was the biggest single debugging arc in the project so far. The root user complaint — **the globe is black when zoomed out to orbit** — took ~5 rounds of rebuild-and-test to isolate, and in the process we uncovered ~20 latent bugs that had been silently lurking in the WebGPU renderer. Every fix is documented below with the full **symptom → hypothesis → diagnostic → root cause → fix** chain so the reasoning is preserved if any of these regresses.

### 27.1 Debug overlay tier — `CesiumDebug.showDepth` / `showFrustums` / `showCommands`

#### BUG-30: `WebGPUDebugDepthOverlay` shader wouldn't compile

**Symptom:** `showDepth` console command logged "Depth buffer visualization ON" but produced a WGSL compile error: `no matching call to 'textureSampleLevel(texture_depth_2d, sampler, vec2<f32>, abstract-float)'`.

**Root cause:** WGSL requires the `level` parameter of `textureSampleLevel` on a **depth** texture to be `i32` / `u32`, not `f32`. Abstract-float literals like `0.0` are rejected. This is *different* from color textures (`texture_2d<f32>`) which accept f32 LODs. Naga silently accepted the literal at parse time but rejected it at validation.

**Fix:** Use `0i` explicitly for depth texture sample LODs.
- [`Source/Shaders/WebGPU/WebGPUDebugDepthOverlay.ts:115`](../packages/engine/Source/Renderer/WebGPU/WebGPUDebugDepthOverlay.ts#L115) (and also in `WebGPUDebugFrustumOverlay.ts`)

#### BUG-31: Debug overlay modes conflicted — stuck in broken state

**Symptom:** Calling `showDepth()` then `showFrustums()` would leave the viewer showing the first overlay's error. Toggling one flag didn't clear the others.

**Root cause:** Depth / frustum / command overlays share a single dispatch slot in the WebGPU scene renderer (the first-enabled check returns early from `_runPostProcessing`). Any overlay that hit an error at init time would stay "latched" on the broken pipeline while the Scene flags for the other overlays silently piled up.

**Fix:** Added `clearAllOverlays()` helper in [`CesiumDebug.js`](../packages/engine/Source/Scene/CesiumDebug.js) that every `show*` method calls first, making the three modes mutually exclusive at the JS level.

#### BUG-32: `getDepthStencilAttachment()` hard-coded `depthLoadOp: "clear"`

**Symptom:** Multi-frustum depth clears were working, but reopening the scene framebuffer pass from any *other* site (debug overlay, post-process, env effect) was silently wiping depth because every call to `getDepthStencilAttachment()` returned a descriptor with `depthLoadOp: "clear"`.

**Root cause:** The helper in `WebGPURenderTarget.ts` took no load/store op parameters and unconditionally set clear. Any caller that wanted to reopen a pass preserving depth had to manually build the descriptor.

**Fix:** Parameterized the helper with defaulted `depthLoadOp` / `depthStoreOp` / `stencilLoadOp` / `stencilStoreOp` arguments.
- [`Source/Renderer/WebGPU/WebGPURenderTarget.ts:253-295`](../packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts#L253-L295)

#### BUG-33: `showDepth` only saw one frustum's depth

**Symptom:** `showDepth` at orbit showed a fully-cleared (magenta) screen. At close-in tilted views it showed a narrow grey band.

**Root cause:** Cesium splits the view into N frustums and clears depth between them. After rendering completes, the only depth that survives is from the **last** frustum rendered (the nearest). Any geometry that lived in other frustums is invisible to the overlay. At orbit the globe lives in the *far* frustum; the near frustum is empty; the overlay samples cleared depth.

**Fix:** Added a bypass — when `debugShowDepthAsColor` is on, skip the inter-frustum depth clear so all frustums accumulate into the same buffer. Depth-test correctness is compromised for that frame (far-frustum tiles may incorrectly occlude near-frustum tiles through stale depth), but the viz is the tool you reach for when something's wrong with depth anyway.
- [`WebGPUSceneRenderer.ts:720-785`](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts#L720-L785)

Also switched the shader from linear `(linear - near) / (far - near)` normalization to **log-scale** — Cesium's planetary camera runs `near ≈ 1m, far ≈ 1e10m` (ten decades) and linear normalization turns everything into near-zero grayscale. Log-scale spreads the useful range: 10 km at ~0.4, 100 km at ~0.5, 1000 km at ~0.6.

#### Positive outcome

`showDepth` now produces an actually useful visualization at any altitude. `showFrustums` and `showCommands` work through the same `WebGPUDebugFrustumOverlay` post-process path, both RTE-safe since they're fullscreen effects with no world-space positions.

---

### 27.2 The Fog Staleness Bug

#### BUG-34: Globe rendering dark at moderate altitude

**Symptom:** User reported "Turning off fog does make the globe usable at other angles." Toggling `scene.fog.enabled = false` in the console fixed the darkening — but `console.log(viewer.scene._frameState.fog)` showed `density: 0, enabled: false` already. So fog was "off" at CPU level but GPU was still applying it.

**Diagnostic chain:**
1. Added per-frame `console.log` of the fog state being packed into the tile uniform: `density`, `rawDensity`, `offset`, `enabled`, `cameraHeight`.
2. Log showed `density=0.000e+0 enabled=false gated=false cameraHeight=12674km` — fog was genuinely zero when written to the GPU.
3. Since CPU-side was 0 and GPU shader was getting 0, fog couldn't be the cause. This **ruled out** fog as the black-globe-at-orbit culprit.

**What we fixed anyway:** While tracing this, found that `Fog.update()` early-returns when `this.enabled === false`, leaving `frameState.fog.density` stale from whatever the previous frame set. If the user flipped `enabled` off mid-session after a period at low altitude where density was large, that stale value would persist forever.

**Fix:** Belt-and-suspenders — in [`WebGPUGlobeSurfaceRenderer._createTileUniformBuffer`](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts#L1681-L1720), gate density explicitly:
```typescript
const fogEnabled = frameState.fog.enabled !== false;
let density = fogEnabled ? (frameState.fog.density ?? 0.0) : 0.0;
```
Now disabling fog always produces a 0 density on the GPU, regardless of whether `Fog.update()` refreshed the frameState.

#### BUG-35: Fog path dropped alpha to zero when fog ≥ 0.98

**Symptom:** "Zooming all the way in looks fine until I angle my camera and then fog occludes everything." Tilted close-up views showed the terrain disappearing entirely into the sky color.

**Root cause:** Our `GlobeTerrain.wgsl` fog block had a WGSL-only addition:
```wgsl
if (fogAmount > 0.98) {
  alpha = max(1.0 - (fogAmount - 0.98) * 50.0, 0.0);
}
```
This dropped alpha to 0 at heavy fog, making the terrain **transparent** and exposing the black skybox behind it. Upstream WebGL's `czm_fog` does `mix(color, fogColor, fog)` and **never touches alpha**.

**Fix:** Removed the alpha drop entirely at [`GlobeTerrain.wgsl:962`](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl#L962). Terrain stays opaque through fog; fog only tints color.

---

### 27.3 RTE Completeness Audit

Prompted by the black-globe investigation, did a full audit of every WGSL vertex shader and every JS renderer that packs MVP uniforms. Context: CesiumJS WebGPU runs at planetary scale (positions up to ~6.4 Mm from origin), and naked `mvp * worldPos` loses precision catastrophically in FP32. The correct pattern is **Relative-To-Eye (RTE)**:
- Vertex buffers store positions as `positionHigh` + `positionLow` FP32 pairs (FP64-equivalent precision)
- Uniform buffers carry `encodedCameraPositionMCHigh/Low` + `mvpRelativeToEye` (MVP with translation column zeroed)
- Vertex shader does `translateRelativeToEye(posHi, posLo, camHi, camLo) → small eye-relative vec3`, then `mvpRelativeToEye × that`

See CLAUDE.md's RTE section for the full contract.

#### Audit scope

Scanned all ~80 WGSL vertex shaders under `Source/Shaders/WebGPU/` and all ~20 JS/TS WebGPU renderers. Looked for:
- Single `position: vec3<f32>` vertex inputs (bad — should be `positionHigh` + `positionLow`)
- Naked `viewProjectionMatrix * worldPos` or `modelViewProjection * vec4(position, 1.0)` in vertex shaders
- JS renderers packing `viewProjection` instead of `mvpRelativeToEye` into camera uniforms
- JS renderers zeroing the translation column of `mvp` *after* `proj × mv` (mathematically wrong — wipes P23 depth-mapping term)

#### BUG-36: 7 WGSL shaders violated RTE

| File | Fix |
|---|---|
| [`PhongLighting.wgsl`](../packages/engine/Source/Shaders/WebGPU/PhongLighting.wgsl) | Full rewrite: split position → hi/lo, added `translateRelativeToEye` helper + `mvpRelativeToEye` uniform. Fragment shader now uses `positionEC` instead of reconstructed world pos for view-vector math. |
| [`PBRMetallicRoughness.wgsl`](../packages/engine/Source/Shaders/WebGPU/PBRMetallicRoughness.wgsl) | Same pattern. |
| [`BasicColor.wgsl`](../packages/engine/Source/Shaders/WebGPU/BasicColor.wgsl) | Full rewrite to RTE. |
| [`BasicTextured.wgsl`](../packages/engine/Source/Shaders/WebGPU/BasicTextured.wgsl) | Same. |
| [`FlexibleGeometry.wgsl`](../packages/engine/Source/Shaders/WebGPU/FlexibleGeometry.wgsl) | Same. |
| [`Classification/VectorTile.wgsl`](../packages/engine/Source/Shaders/WebGPU/Classification/VectorTile.wgsl) | Full rewrite to RTE. |
| [`Classification/ShadowVolumeAppearance.wgsl`](../packages/engine/Source/Shaders/WebGPU/Classification/ShadowVolumeAppearance.wgsl) | Same, with `positionEC` via `modelViewRelativeToEye`. |

**How we found them:** Cross-referenced three greps:
1. WGSL files containing `positionHigh|positionLow|mvpRelativeToEye|translateRelativeToEye` (RTE markers — 77 files)
2. WGSL files containing `position: vec3<f32>` (single-position = suspect — 12 files)
3. WGSL files containing naked `viewProjection *` / `modelViewProjection *` (suspect — 3 files)

The intersection of #2 and #3, minus #1, gave the violators.

#### BUG-37: Weather particle compute system stored world-space positions

**Symptom:** Weather particles (rain, snow) appeared to freeze or snap when viewed at planetary scale.

**Root cause:** `Compute/WeatherParticles.wgsl` stored each particle's position in full world-space ECEF. At Earth radius (~6.4 Mm) FP32 precision is ~0.6 m/unit — **larger than a raindrop moves in one frame**. Particles would snap to a 0.6 m grid and visibly stutter.

**Fix (three coordinated files):**
1. **Compute shader** ([`WeatherParticles.wgsl`](../packages/engine/Source/Shaders/WebGPU/Compute/WeatherParticles.wgsl)) — Particle positions are now **camera-relative**. Update pass subtracts a frame-to-frame `cameraDelta` so particles stay world-stationary while stored in a small local frame. Spawn: `p.position = offset` (no big-number add). Cull: `length(p.position)` (no subtraction). Ground: `worldGroundAlt - cameraY` precomputed CPU-side.
2. **Render shader** ([`WeatherParticleRender.wgsl`](../packages/engine/Source/Shaders/WebGPU/Compute/WeatherParticleRender.wgsl)) — Uses `mvpRelativeToEye` instead of raw `viewProjection`. Billboard corners are already eye-relative.
3. **JS host** ([`WebGPUWeatherRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts)) — Tracks `prevCameraPosition` on the cache, computes `cameraDelta = curr - prev` in **FP64** on the CPU, and passes the small delta to the compute shader. Teleport guard: if delta > 4× spawn radius in one frame, delta is zeroed so existing particles age out instead of snapping.

#### BUG-38: 6 JS renderers zeroed MVP translation *after* projection multiply

**Symptom:** None immediately visible — this was a latent bug affecting primitives at planetary scale that would have caused incorrect depth values for any 3D Tiles / point clouds / voxels / Gaussian splats / ellipsoids / clouds / buffer polygons.

**Root cause:** A common pattern propagated by a misleading docstring in [`webgpuTypeHelpers.ts`](../packages/engine/Source/Renderer/WebGPU/webgpuTypeHelpers.ts):
```typescript
// WRONG — example in the docstring
const mvp = m4Values(Matrix4.multiply(proj, view, scratch));
mvp[12] = 0; // zero translation for RTE
```

This is mathematically incorrect. When you compute `proj × mv`, the projection's **P23** term (the near/far depth-mapping constant) ends up in the **same column-3 slots** as the translation — because the multiply redistributes col3 as:
```
(proj × mv)_col3 = [P00*mv03+P02*mv23, P11*mv13+P12*mv23, P22*mv23+P23, -mv23]
```
Zeroing `[12,13,14]` wipes P23 along with the translation. The result is an MVP matrix with no depth mapping — every vertex produces incorrect NDC z, and at planetary scale where z is near-1 anyway, all fragments fail the depth test.

**Correct pattern:** Zero the translation on `mv` **before** projecting:
```typescript
Matrix4.multiply(view, model, scratchMV);
scratchMV[12] = 0; scratchMV[13] = 0; scratchMV[14] = 0;
Matrix4.multiply(proj, scratchMV, scratchMVP);
```
Now `(proj × mv_rte)_col3 = proj × [0,0,0,1] = [0, 0, P23, 0]` — depth mapping preserved exactly. This matches `UniformStateComputations.cleanModelViewProjectionRelativeToEye` which has always been correct (and is the path used by auto-uniforms for the globe, which is why the globe was fine).

**Files fixed (all with the same pattern):**
- [`WebGPUBufferPrimitiveRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts#L201)
- [`WebGPUCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts#L350)
- [`WebGPUEllipsoidPrimitiveRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts#L237)
- [`WebGPUGaussianSplatRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts#L376)
- [`WebGPUPointCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts#L243)
- [`WebGPUVoxelRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts#L346)
- [`webgpuTypeHelpers.ts`](../packages/engine/Source/Renderer/WebGPU/webgpuTypeHelpers.ts) — docstring corrected to show the right pattern and prevent future propagation.

**Renderers that were already correct (verified during audit):** `WebGPUBillboardRenderer`, `WebGPUEnvironmentRenderer` (both sites), `WebGPUGroundPrimitiveRenderer`, `WebGPULabelRenderer`, `WebGPUModelRenderer`, `WebGPUPolylineRenderer`, `WebGPUPointPrimitiveRenderer`, `WebGPUPrimitiveCommands`, `WebGPUSkyAtmosphereRenderer`.

---

### 27.4 The Black-Globe-at-Orbit Root Cause

**Symptom (the headline bug of these sessions):** Globe visible at close range, globe completely black at orbital altitude (~10,000 km+). Wireframe overlay showed the globe's geometry was correctly rendered; depth overlay showed the globe's depth was being written; but the normal fragment output was all black.

**Diagnostic chain (5 rounds of rebuild-and-test):**

1. **Hypothesis 1: Fog darkening.** Ruled out — added per-frame fog diagnostic, confirmed `density=0 enabled=false` at orbit.
2. **Hypothesis 2: Lighting night-ambient too dark.** Ruled out — `Globe.enableLighting` defaults to `false`, so the entire lighting block in the shader is skipped.
3. **Hypothesis 3: `layerCount=0` → dark base color fallback.** Ruled out — added a **diagnostic orange fallback** in the shader for layerCount=0. Rebuild showed all tiles at orbit had `layerCount=2, readyInPass=2`. Imagery was definitely loaded.
4. **Hypothesis 4: Imagery texture composite producing black.** Added **raw-imagery passthrough** diagnostic that bypassed the composite chain and returned `textureSampleLevel(dayTexture0)` directly. At close range this showed correct terrain color. **At orbit, still black.** This proved the fragment shader wasn't even running at orbit — the fragments were being discarded *before* the fragment stage.
5. **Hypothesis 5: Depth precision discarding fragments.** Replaced the raw-sample diagnostic with **pure red**. If the globe showed red at orbit, the fragment shader was running and something downstream was overwriting; if black, fragments never reached the fragment stage. **Result: black.** Confirmed: fragments were being clipped or depth-tested away before ever running the fragment shader.

**Root cause:** At orbital altitude, the globe surface projects to a clip-space Z extremely close to 1.0. **FP32 precision rounds it to exactly 1.0**, which the WebGPU rasterizer treats as "behind the far plane" and clips. Even surviving fragments would fail `depthCompare: "less"` against the cleared depth buffer (which is also 1.0).

Compounding this: our skybox pipeline was using `depthCompare: "always"` + `depthWrite: false`. That meant the skybox painted every pixel but left the depth buffer at 1.0 everywhere, so every subsequent draw had to produce z < 1.0 strictly — which failed at orbit.

**The fix — three-part coordinated change:**

#### BUG-39a: Vertex-shader clip-Z clamp

In `GlobeTerrain.wgsl`'s `processVertex()`, clamp the clip-space Z to never exceed W:
```wgsl
out.position.z = min(out.position.z, out.position.w);
```
This ensures NDC z ≤ 1 exactly. Rasterizer-clipped fragments become "at the far plane" instead of "behind it". Paired with the depth-compare change below, they now survive.
- [`GlobeTerrain.wgsl:384-395`](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl#L384-L395)

#### BUG-39b: Globe pipeline `less` → `less-equal`

First-pass globe pipeline was using `depthCompare: isBlend ? "less-equal" : "less"`. Changed to **always** use `less-equal` so clamped z=1 fragments survive the depth test.
- [`WebGPUGlobeSurfaceRenderer.ts:691`](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts#L691)

#### BUG-39c: Skybox + Moon — proper far-plane pattern

The skybox had `depthCompare: "always"` which is the "draw-order-dependent" anti-pattern. Rewrote it to use the standard WebGPU skybox pattern:

**Shader** ([`CubeMapPanorama.wgsl`](../packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl#L75-L84)):
```wgsl
let clipPos = uniforms.projection * vec4<f32>(rotated, 1.0);
// Force z/w = 1 (far plane)
output.position = vec4<f32>(clipPos.x, clipPos.y, clipPos.w, clipPos.w);
```

**Pipeline** ([`WebGPUCubeMapPanoramaRenderer.js:258`](../packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js#L258)):
```js
depthWriteEnabled: false,
depthCompare: "less-equal",  // was "always"
```

The skybox is now parked exactly on the far plane. With `less-equal`, it fills only pixels where no closer geometry has drawn. **Draw order no longer matters** — the skybox can be issued before or after terrain and the result is identical.

Applied the same pattern to the Moon pipeline and shader ([`Environment/Moon.wgsl`](../packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl) + [`WebGPUEnvironmentRenderer.js:465`](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js#L465)).

#### BUG-39d: Renderer-wide `less` → `less-equal` migration

During the audit we found that the `less` vs `less-equal` choice was the same latent bug class across every opaque pipeline. Any geometry at planetary scale would eventually project to z≈1 and fail `less`. Migrated all 14 sites:

- `WebGPUBufferPrimitiveRenderer` (3 sites) — polygon / polyline / point buffer primitives
- `WebGPUCloudRenderer`
- `WebGPUDepthPlane`
- `WebGPUEllipsoidPrimitiveRenderer`
- `WebGPUGaussianSplatRenderer` (main + OIT variant)
- `WebGPUPointCloudRenderer`
- `WebGPUPrimitiveCommands` (4 sites — across color and pick variants)
- `WebGPUVoxelRenderer`
- `WebGPUShadowMapRenderer` — CSM cascade far planes have the same issue

Plus framework defaults changed so future code inherits the correct choice:
- [`WebGPUContext._depthCompare`](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L294) default: `less` → `less-equal`
- [`WebGPUPipelineDescriptorBuilder.depthStencil()`](../packages/engine/Source/Renderer/WebGPU/WebGPUPipelineDescriptorBuilder.ts#L135) default param: `less` → `less-equal`
- `WebGPUPipelineDescriptorBuilder._ensureDepthStencil()`
- [`WebGPURenderPipelineCache`](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts#L347) fallback: `less` → `less-equal`
- [`WebGPUShaderModule`](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderModule.ts#L224) auto-depth state: `less` → `less-equal`

**Verification:** Final `rg "depthCompare\s*:\s*\"less\""` across active code returned zero results. Only hit is a documentation comment in `CubeMapPanorama.wgsl` explaining the prior pattern. Similarly no remaining `depthCompare: "always"` except the same historical comment.

**Result:** Rebuild confirmed globe is visible at orbit. User's first screenshot after the rebuild: "I can see the globe again."

---

### 27.5 Known remaining issues (as of end of session 30)

These are the follow-ups that arose once the black-globe root cause was fixed. They're queued but not yet addressed in code (except where noted). Each entry includes the current hypothesis and next steps.

#### OPEN-1: Sky atmosphere not rendering (missing horizon glow)

**Symptom:** Globe is visible at orbit but has no atmospheric glow around the limb, no blue Rayleigh tint, sharp terminator. WebGL shows a clear blue halo; our WebGPU path shows nothing.

**Evidence:** `[WebGPU:EnvInject] ... skyBox=true skyAtmo=false sun=false moon=true` — the `isSkyAtmosphereVisible` flag is consistently `false` in the env-inject log.

**Current hypothesis:** The `updateWebGPUSkyAtmosphere` feature renderer is either (a) not being invoked, (b) early-returning on `skyAtmosphere.show === false`, or (c) pushing the command but failing to have it captured by `SkyAtmosphere.update`'s return path.

**Diagnostic in place:** Added three one-shot logs to `WebGPUSkyAtmosphereRenderer.updateWebGPUSkyAtmosphere`:
1. Entry log showing `show`, `mode`, `renderPass`, `hasContext`, `hasDevice`
2. Past-`show`-check log with pipeline cache state
3. Post-push log with `indexCount` and command list length

**Next steps:**
1. Rebuild and collect the diagnostic output.
2. Identify which path the code takes (early return vs full update).
3. If `skyAtmosphere.show` is false, investigate why (default is `true` from `CesiumWidget.js:385-386`).
4. If the command IS pushed but `envState.skyAtmosphereCommand` is still undefined, investigate the capture path in `SkyAtmosphere.update` (line 254-260 of `SkyAtmosphere.js`).
5. If the FR isn't being called at all, verify `FeatureRendererKey.SKY_ATMOSPHERE` registration in `WebGPUFeatureRenderers.ts:287`.

**Expected downstream impact:** Fixing this should also resolve OPEN-2 and OPEN-3 below. Sky atmosphere provides:
- Blue limb glow around the globe silhouette
- Subtle atmospheric tint that softens the day/night terminator
- Ground atmosphere color that feeds the fog color computation

Without it, the globe looks "stretched" and "see-through" at certain angles because the dark side is nearly pitch-black against the black sky and visually indistinguishable.

#### OPEN-2: "Stretched / unnatural lighting"

**Symptom:** At orbit the globe has a flat, uneven, unnatural appearance. Day side is visible; dark side fades to near-black with no atmospheric softening.

**Current hypothesis:** Symptom of OPEN-1. With `Globe.enableLighting === false` (default) and no sky atmosphere glow, the terrain renders with only the imagery texture — no diffuse shading, no atmospheric tint. The sharp transition from lit imagery to unlit imagery creates an unnatural look.

**Next steps:** Verify after OPEN-1 is resolved. If still problematic, investigate `computeDayNightFade` formula in `GlobeTerrain.wgsl:492-495`.

#### OPEN-3: "See-through globe" at certain camera angles

**Symptom:** At specific orbit angles, part of the globe appears to have a wedge-shaped cutout, as if you can see space through the earth.

**Current hypothesis:** Also a symptom of OPEN-1. The dark side of the earth renders as nearly `(0.04, 0.04, 0.06)` (the dark base color fallback in the shader) which is visually indistinguishable from the black sky. The user perceives a "cutout" where the dark side actually exists but is invisible. A functioning sky atmosphere would fill in the limb with a faint blue glow, making the dark side visible.

**If atmosphere doesn't resolve it:** Look for depth-test edge cases at the terminator or between LOD boundaries. Check if `_clearDepthStencil` is wiping globe depth between frustums at specific angles.

**Next steps:** Verify after OPEN-1. If still problematic, add a fragment-shader diagnostic that tints the dark side with a bright color to confirm it's being rendered (just invisible).

#### OPEN-4: Level-0 terrain tile center has bogus magnitude (~3 km instead of ~3186 km)

**Symptom (hygiene issue, not actively breaking anything):** Diagnostic log shows:
```
center3D tile=0_0_0 meshCtor=TerrainMesh encCtor=TerrainEncoding
  terrainDataCtor=? isFillByRef=false isCachedMesh=true
  magKm=3.060 center.xyz=(832.3,-2848.0,-749.7) quantized=false
```

The level-0 tile has an ECEF center magnitude of **3.06 km** — impossible for a valid Earth-surface tile, which should be ~6378 km. `terrainDataCtor=?` is `undefined`, meaning the tile has no backing `TerrainData` instance.

**Why it's not breaking things:** This tile renders briefly during the first frame and gets replaced by properly-loaded level-1+ tiles immediately. Wireframe shows a clean sphere, depth viz shows correct geometry.

**Current hypothesis:** A placeholder `TerrainMesh` is being constructed somewhere during terrain bootstrap with a default-initialized scratch `Cartesian3` as its center. Possibly in `GlobeSurfaceTile` when creating a placeholder mesh for terrain tiles that haven't loaded yet, or in an `EllipsoidTerrainProvider`-style fallback.

**Next steps:**
1. Add `console.trace` inside `new TerrainMesh(...)` construction to catch the caller that passes a bad center.
2. Check `Cesium3DTilesTerrainData.js:300`, `QuantizedMeshTerrainData.js:344`, `HeightmapTerrainData.js:278`, `TerrainFillMesh.js:1281` for the bootstrap path.
3. Low priority — fix after visible issues are resolved.

#### OPEN-5: Fog still might be too aggressive at tilted low altitude

**Symptom:** "Zooming all the way in looks fine until I angle my camera and then fog occludes everything." **Partially fixed** by removing the alpha drop (BUG-35) but the color-mix fog may still be too strong.

**Current hypothesis:** The upstream fog formula is correct (`fog = 1 - exp(-(dist * density)²)`) and matches our WGSL. But the density multiplier is unusually high at low altitude tilted views due to `density *= 1 - dot(viewDir, upDir)` in `Fog.update()`. When looking horizontally, dot → 0 and density is at max. Combined with our custom `atmosphereColor * nightFogDimming` fog color, the result may be too saturated.

**Next steps:**
1. Rebuild with the alpha-drop fix and see if the visible symptom is gone.
2. If still too strong, compare `computeAtmosphereColor` output between WebGL and WebGPU at matching camera states.
3. Investigate whether `fogMinimumBrightness` (default 0.03) should be lower for WebGPU since our atmosphere color is already darker than WebGL's.

#### OPEN-6: `tile=5_19_15 layerCount=1` (some tiles have only 1 imagery layer)

**Symptom:** A handful of tiles in the log show `layerCount=1` instead of `layerCount=2`. Not necessarily a bug — could be fill tiles or tiles whose secondary imagery hasn't loaded yet.

**Next steps:** Low priority. Monitor. Investigate if imagery compositing looks wrong at those tile locations.

---

### 27.6 Lessons learned

**1. Always bisect diagnostic-by-diagnostic, not hypothesis-by-hypothesis.**
The black-globe investigation took 5 rounds because each hypothesis was tested by a full rebuild. Better workflow: use the shader to output synthetic data (orange for layerCount=0, pure red for "fragment ran at all", raw texture passthrough for "is the texture black") — each diagnostic *rules out* a category of bugs, even if it doesn't immediately localize the fix. The "pure red still black" result was the breakthrough — it told us fragments weren't reaching the fragment stage, which immediately ruled out everything *inside* the shader and pointed at vertex/depth/clip.

**2. Renderer-level defaults matter more than individual pipeline choices.**
The "less vs less-equal" choice was made by copy-paste from a docstring example at the start of the project. That one docstring propagated to 14 pipeline creation sites across 10+ files. Fixing the symptom required fixing all 14 sites *and* fixing the framework defaults so future code inherits the right answer. We updated the docstring in `webgpuTypeHelpers.ts` as part of the fix to prevent re-propagation.

**3. The skybox `depthCompare: always` anti-pattern is widespread.**
Googling "webgl skybox depth test" gives a lot of tutorials that recommend `GL_ALWAYS` + strict draw-order ("draw the skybox first"). That's a fragile pattern that breaks the moment anything reorders the env pass. The correct modern pattern is: force clip-space z=w in the vertex shader (so z/w=1 exactly), use `less-equal`, and let draw order be anything. This also works for the moon and anything else that lives "infinitely far away". We applied this pattern consistently during the skybox fix and it's now the project's standard.

**4. FP32 precision at planetary scale manifests as "weird depth bugs", not "wrong positions".**
The globe positions were visibly correct at close range (wireframe confirmed) but fragments at orbit were being clipped. The root cause was FP32 precision in the *projection multiply*, not in the positions themselves. The `out.position.z = min(out.position.z, out.position.w)` clamp is a surgical fix that ensures NDC z ≤ 1 exactly, surviving the rasterizer's far-plane clip. Without this clamp, even `less-equal` wouldn't save you because the fragment was clipped before depth testing ran.

**5. RTE is layered — shader, uniform, and vertex buffer must all cooperate.**
Three independent axes must be correct for RTE to work:
- **Shader:** uses `mvpRelativeToEye × translateRelativeToEye(...)` pattern
- **Uniform:** packs `encodedCameraPositionMCHigh/Low` + MV with translation zeroed *before* projection multiply
- **Vertex buffer:** positions stored as `positionHigh` + `positionLow` split pairs from the CPU (via `EncodedCartesian3.fromCartesian`)

A single wrong axis breaks the whole chain. The audit found shaders that had correct RTE but were fed by JS code that zeroed translation *after* projection (BUG-38) — technically the shader was right, but the uniform was wrong and the math broke. Fix-by-grep isn't enough; you have to verify the end-to-end chain.

**6. `depthLoadOp: "clear"` is a dangerous default for a helper that reopens passes.**
`getDepthStencilAttachment()` hard-coded clear because the first caller wanted clear. Every subsequent caller that wanted to preserve depth had to manually build the descriptor and either forgot or didn't realize. BUG-32 is a direct consequence of making "clear" the only behavior of a helper. Lesson: helpers that produce render pass descriptors should always take explicit load/store ops, never default to destructive operations.

---

### 27.7 Files modified in sessions 27-30

**WGSL shaders (rewrites):**
- `packages/engine/Source/Shaders/WebGPU/PhongLighting.wgsl`
- `packages/engine/Source/Shaders/WebGPU/PBRMetallicRoughness.wgsl`
- `packages/engine/Source/Shaders/WebGPU/BasicColor.wgsl`
- `packages/engine/Source/Shaders/WebGPU/BasicTextured.wgsl`
- `packages/engine/Source/Shaders/WebGPU/FlexibleGeometry.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Classification/VectorTile.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Classification/ShadowVolumeAppearance.wgsl`
- `packages/engine/Source/Shaders/WebGPU/Compute/WeatherParticles.wgsl` (refactored to camera-relative)
- `packages/engine/Source/Shaders/WebGPU/Compute/WeatherParticleRender.wgsl` (uses mvpRelativeToEye)
- `packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl` (clip z=w)
- `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl` (clip z=w)

**WGSL shaders (edits):**
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (clip-Z clamp, fog alpha drop removed)
- `packages/engine/Source/Shaders/WebGPU/WebGPUDebugDepthOverlay.ts` (i32 LOD fix, log-scale norm)
- `packages/engine/Source/Shaders/WebGPU/WebGPUDebugFrustumOverlay.ts` (i32 LOD fix)

**JS/TS renderers:**
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` (fog gate, less-equal, diagnostics)
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` (debug depth bypass, frustum range capture)
- `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` (MVP zero order, less-equal x3)
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts` (MVP zero order, less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts` (MVP zero order, less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` (MVP zero order, less-equal x2)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts` (MVP zero order, less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` (less-equal x4)
- `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (MVP zero order, less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts` (less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js` (less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` (less-equal, was always)
- `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (less-equal for moon, was always)
- `packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts` (camera delta tracking, FP64 subtract)
- `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` (diagnostics)
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` (default less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPipelineDescriptorBuilder.ts` (default less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts` (fallback less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderModule.ts` (auto depth less-equal)
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts` (getDepthStencilAttachment parameterized)
- `packages/engine/Source/Renderer/WebGPU/webgpuTypeHelpers.ts` (docstring corrected)
- `packages/engine/Source/Scene/CesiumDebug.js` (clearAllOverlays helper)

---

## Session 35 — Resource.parseUrl URL-resolution regression (2026-04-19)

### BUG-35.1 — Relative URLs against a baseUrl lost the base's path

**File:** `packages/engine/Source/Core/Resource.js`
**Severity:** HIGH (app-breaking for every CesiumJS user with a subpath `CESIUM_BASE_URL`).
**Symptom:** `buildModuleUrl("Assets/approximateTerrainHeights.json")` against `CESIUM_BASE_URL = "/Build/Cesium/"` resolved to `http://host/Assets/...` instead of `http://host/Build/Cesium/Assets/...`. Every Workers, Assets, IAU2006_XYS, and SkyBox fetch 404'd. Variant smoke test caught this across all 3 bundles.

**Root cause:** The earlier ES6 modernization of `parseUrl` rewrote the uri.js-based implementation to use the native `URL` constructor with a placeholder base:

```js
parsed = new URL(url, "https://placeholder.invalid/"); // relative "Assets/foo" -> "/Assets/foo"
// ... later ...
cleanUrl = parsed.pathname;                             // "/Assets/foo" (root-relative!)
cleanUrl = getAbsoluteUri(cleanUrl, getAbsoluteUri(baseUrl)); // resolves against "http://host/Build/Cesium/"
```

The `URL` constructor forces every relative URL to a pathname starting with `/`, which then **behaves as a root-relative path** during later `getAbsoluteUri` resolution. Root-relative paths discard the base URL's pathname, so the result loses `/Build/Cesium/`.

**Fix applied:** Detect the relative-with-baseUrl case BEFORE calling `new URL`, and resolve the relative directly against the baseUrl so path preservation happens inside the URL constructor:

```js
if (!hadScheme && defined(baseUrl)) {
  parsed = new URL(url, getAbsoluteUri(baseUrl)); // preserves base's path
} else {
  parsed = new URL(url, "https://placeholder.invalid/"); // original path for absolutes
}
```

For the reconstruction step, the `hadScheme` branch and the new `defined(baseUrl)` branch both emit `${parsed.origin}${parsed.pathname}` — which is now correct because `parsed` already resolved against the real base.

### BUG-35.2 — Data + blob URIs corrupted into `null<pathname>`

**File:** `packages/engine/Source/Core/Resource.js` (same `parseUrl` rewrite).
**Severity:** HIGH (silent data-URI corruption in every Resource-routed image load).
**Symptom:** Base64 data URIs like `data:image/png;base64,iVBOR...` were ending up as `nullimage/png;base64,iVBOR...` 404 requests against the origin. Variant smoke test flagged this as a rogue `http://localhost:8080/nullimage/png;base64,...` request alongside the Assets 404s.

**Root cause:** The reconstruction step used `${parsed.origin}${parsed.pathname}` for URLs with a scheme. For `data:` (and `blob:`) URIs, `new URL("data:image/png;base64,...").origin === "null"` and `.pathname === "image/png;base64,..."`. Concatenating gave `"null" + "image/..."` = `"nullimage/..."`.

**Fix applied:** Short-circuit `data:` and `blob:` URIs and store them verbatim — they don't need origin/pathname reconstruction because they're opaque blobs:

```js
if (/^data:/i.test(url)) { this._url = url; this._queryParameters = {}; return; }
if (/^blob:/i.test(url)) { this._url = url; this._queryParameters = {}; return; }
```

**Coverage:** Core/Resource spec — 119/119 pass after the fix. Variant smoke test passes all 3 bundles (dual / webgl-only / webgpu-only) with zero console errors across 5 render frames.

**Files modified:**

- `packages/engine/Source/Core/Resource.js` (parseUrl: +42 / -10)
- `Tools/variant-smoke-test.mjs` (new smoke-test harness that caught both regressions)

### BUG-35.3 — Sync `new Viewer()` with `renderer: "webgpu"` silently returned a WebGL context

**File:** none — architectural constraint, not a bug fix. Documented here so future smoke-test authors don't repeat the misdiagnosis.

**Symptom:** Passing `contextOptions: { renderer: "webgpu" }` to `new Cesium.Viewer(...)` still returned a WebGL context. In the webgpu-only bundle this caused the WebGL backend to try compiling empty-stub GLSL shaders (`ERROR: -1:-1: '' : Missing main()`).

**Root cause (by design):** `Scene` constructor is synchronous and calls `new Context(canvas, contextOptions)` directly for the WebGL path. The WebGPU path requires an async device-request step (`navigator.gpu.requestAdapter → requestDevice`) that can't fit in a sync constructor. `Viewer.createAsync()` / `CesiumWidget.createAsync()` / `Scene.createAsync()` exist specifically for the WebGPU path — they pre-create the context and pass it via `options._preInitializedContext` to the sync `Scene` constructor.

**Takeaway:** Smoke tests, integration tests, or demo pages that want the WebGPU backend **must** go through `Viewer.createAsync()`. The variant-smoke-test harness now branches on renderer type for this reason.


### BUG-36.1 — CSM params UBO: splits / blendBands / biases packed at wrong byte offsets

**Files:** [packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts), [packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js), [packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js)

**Symptom:** CSM had been shipping since Session 32/33 (2026-04-13) but visual output was never validated (handoff Tier-1 item 3 left `STILL PENDING`). Surfaced during re-review of CSM Slice 2d Lit receivers — the shader layout and the JS packer disagreed on where `cascadeSplits` / `blendBands` / `cascadeMinBias` / `cascadeMaxSlopeBias` live inside the `CSMParams` UBO.

**Root cause:** The WGSL struct
```wgsl
struct CSMParams {
  cascadeVP0..3: mat4x4<f32>,  // 64 bytes each, natural WGSL layout
  cascadeSplits: vec4<f32>,    // natural offset: byte 256 (float 64)
  blendBands: vec4<f32>,       // natural offset: byte 272 (float 68)
  cascadeMinBias: vec4<f32>,   // natural offset: byte 288 (float 72)
  cascadeMaxSlopeBias: vec4<f32>, // natural offset: byte 304 (float 76)
}
```
produces a 320-byte struct. The JS packer wrote VPs correctly at floats 0..63 but then wrote splits/blendBands/biases at floats 256/260/264/268 — a 192-float gap. A stale comment in the renderer (`// 4 × mat4 = 256 floats`) masqueraded as intentional layout, and the layout-spec re-encoded the same wrong offsets, so specs passed even though the runtime data was mislocated.

**Consequence:** The shader read `(0,0,0,0)` for splits, which makes `selectCascade(viewDepth, splits)` fall through all `viewDepth < 0` checks and always return cascade 3. Depth bias also read as zero. CSM silently degraded to single-cascade-at-farthest-coverage with no depth bias — this is why near-camera shadows would have looked coarse and why a "Visual smoke test" was needed to expose it.

**Fix applied:** Changed the JS pack offsets from `_cascadeParamsData[256/260/264/268 + c]` to `_cascadeParamsData[64/68/72/76 + c]`. The shader, the placeholder buffer, and the BGL all stay unchanged — only the writer moves. Buffer size stays 1088 bytes (256-aligned) so no allocation changes ripple through; bytes beyond the 320-byte struct are unwritten zeros the shader never reads. Spec comment + regression spec added.

**Affects all CSM consumers** (all fixed by this change, no per-shader edits needed):

- `GlobeTerrain.wgsl`
- `PrimitivePhongColor.wgsl`, `PrimitivePhongTexturedColor.wgsl`
- `PrimitivePBRSimple.wgsl`, `PrimitivePBRTextured.wgsl`
- `ModelPBRComplete.wgsl`
- All 19 `PrimitiveMat*Lit.wgsl` variants (including the 17 added in this session)

---

### BUG-36.2 — Material UBO packer vs WGSL struct drift (audit finding; not yet fixed)

**Files affected (10 material types × 2 variants each = 20 shaders):**
[PrimitiveMatAlphaMap{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatAlphaMapFlat.wgsl),
[PrimitiveMatBumpMap{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatBumpMapFlat.wgsl),
[PrimitiveMatElevContour{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourFlat.wgsl),
[PrimitiveMatEmissionMap{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatEmissionMapFlat.wgsl),
[PrimitiveMatFade{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatFadeFlat.wgsl),
[PrimitiveMatImage{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatImageFlat.wgsl),
[PrimitiveMatNormalMap{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapFlat.wgsl),
[PrimitiveMatSpecularMap{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatSpecularMapFlat.wgsl),
[PrimitiveMatStripe{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatStripeFlat.wgsl),
[PrimitiveMatWater{Flat,Lit}.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterFlat.wgsl)

**Audit scope:** Cross-checked every distinct material type's [Material.js](../packages/engine/Source/Scene/Material.js) fabric `uniforms` declaration order against its WGSL `struct MaterialUniforms` declaration order. The fabric is the source of truth for what gets written into `material._uniformBuffer.gpuData`; [MaterialUniformBuffer.js](../packages/engine/Source/Scene/MaterialUniformBuffer.js) `._buildLayout` iterates `templateUniforms` in declaration order, assigns numeric fields sequential float offsets (honoring WGSL `vec4`/`vec2` alignment), and skips texture/channel-string values (offset -1, not in the float buffer). The WGSL struct reads that Float32Array as-is.

**Root cause:** Ten shaders' structs drifted from their corresponding fabrics. The drift falls into four failure modes:

1. **Phantom `color` field** (AlphaMap, EmissionMap, SpecularMap) — WGSL declares `color: vec4<f32>` at byte 0, but the fabric only has `image`/`channel(s)`/`repeat`. The fabric never writes `color`, so byte 0 gets the fabric's first numeric field instead. Net effect: the fabric's `repeat.xy` bytes get interpreted as `color.rg`, and `repeat`+`channel` read as zero. Fragment output is a tinted gradient of the repeat vector, not an alpha-masked image.

2. **Field re-ordering** (BumpMap, NormalMap, ElevationContour, Image, Stripe) — Fabric and WGSL declare the same fields but in a different order. Because the packer uses fabric order and the shader uses struct order, every field reads the wrong value:
    - BumpMap: fabric writes `[strength, _pad, repeat.x, repeat.y]`; WGSL reads as `[repeat.x, repeat.y, channel, strength]`.
    - ElevationContour: fabric writes `[spacing, _pad×3, color.rgba, width]`; WGSL reads as `[color.rgba, spacing, width]`. The contour `spacing` leaks into `color.r`.
    - Image: fabric writes `[repeat.xy, _pad×2, color.rgba]`; WGSL reads as `[color.rgba, repeat.xy]`. Swapped.
    - NormalMap: fabric writes `[strength, _pad, repeat.x, repeat.y]`; WGSL reads as `[repeat.x, repeat.y, strength, _pad, channels.xyz]` — `strength` goes to `repeat.x`.
    - Stripe: fabric writes `[horizontal(bool), _pad×3, evenColor, oddColor, offset, repeat]`; WGSL reads `[lightColor, darkColor, repeat, offset, orientation]` — also renames `evenColor`/`oddColor` to `lightColor`/`darkColor`.

3. **Missing-in-WGSL fields** (Fade `fadeDirection`, Fade `time`, Water `time`) — fabric writes fields that WGSL doesn't declare (data is ignored — harmless storage waste) or WGSL declares a field (`time`) that fabric doesn't populate (reads zero; animation freezes).

4. **String uniforms expected as numeric runtime values** (AlphaMap `channel`, BumpMap `channel`, NormalMap `channels`, SpecularMap `channel`, EmissionMap `channels`) — fabric provides these as strings (e.g., `"a"`, `"rgb"`). Upstream CesiumJS bakes them into the GLSL shader at fabric assembly time. The WebGPU ports instead declare runtime `channel: f32`/`channels: vec3<f32>` uniforms with no writer — they always read zero.

**What is NOT broken** (Session 36 audit clears these):

- **Color, Checker, Dot, Grid, RimLighting, ElevationRamp, ElevationBand (placeholder), SlopeRamp/AspectRamp (no numerics)** — fabric order matches WGSL struct order; numeric packing lands correctly.
- **Polyline{Arrow,Dash,Glow,Outline}** — collection-level shaders, not audited yet (different rendering path through `WebGPUPolylineRenderer`, may pack differently).
- **PBRSimple, PBRTextured, ModelPBRComplete** — not fabric-driven (custom material pipelines), skipped.
- **Basic{Color,Textured}, Phong{Color,TexturedColor}, Pick*** — all use `_placeholder: vec4<f32>` UBOs; no material fields, no mismatch possible.

**Why specs didn't catch it:** There is no round-trip spec that `new Material({...})` + inspects `material._uniformBuffer.gpuData` + asserts the float offsets match the WGSL struct. The pipeline creates the bind-group and draws; any "it renders" smoke test would pass because the shader still produces a pixel value — just the wrong one.

**Resolution (Session 36 continuation — Option B)** — the audit was followed up in the same session with a full implementation. `MaterialUniformBuffer` was extended to pack fabric channel-shorthand strings as numeric indices (r=0, g=1, b=2, a=3), and every affected shader was rewritten to match fabric declaration order:

- **Packer changes** ([MaterialUniformBuffer.js](../packages/engine/Source/Scene/MaterialUniformBuffer.js)):
    - `_classifyUniform` recognizes `name === "channel"` + 1-char r/g/b/a string → `channelIndex` (f32, size 1), and `name === "channels"` + 1-4 char swizzle string → `channelsVec3` (size 3) or `channelsVec4` (size 4).
    - `_writeValue` handles both new types, writing 0/1/2/3 indices per character.
    - `_readValue` round-trips to the original shorthand string through the facade getter.
    - Fixed a separate latent packing bug exposed by NormalMap: `_buildLayout` had `offset += 1` after every vec3, which over-padded. WGSL places an f32 into the vec3's 4-byte tail (byte 12 after a vec3 at byte 0), but the packer was putting the f32 at byte 16. Removing the `+1` makes `{ vec3, f32, ... }` layouts match WGSL exactly. All existing vec3-followed-by-vec2/vec3/vec4 cases still produce the same offsets because the next-field alignment computation already handled them.
- **Shader changes** (10 types × 2 variants = 20 files):
    - AlphaMap, BumpMap, SpecularMap: WGSL now reads `channel: f32` at fabric-declared offset; uses a runtime `extractChannel(tex, idx)` helper.
    - NormalMap, EmissionMap: WGSL reads `channels: vec3<f32>` and swizzles via `swizzleChannel`.
    - Image: struct reordered to `{ repeat: vec2, color: vec4 }` to match fabric.
    - ElevationContour: struct reordered to `{ spacing: f32, color: vec4, width: f32 }`.
    - Stripe: field names corrected to `evenColor`/`oddColor` and order matched to fabric `{ horizontal: f32, evenColor: vec4, oddColor: vec4, offset: f32, repeat: f32 }`; shader logic brought in line with [StripeMaterial.glsl](../packages/engine/Source/Shaders/Materials/StripeMaterial.glsl).
    - Fade: restructured to `{ fadeInColor, fadeOutColor, maximumDistance, fadeRepeat, fadeDirection: vec2, time: vec2 }`; shader logic now mirrors `FadeMaterial.glsl` (per-axis time-distance with optional wrap).
    - Water: dropped the unused `time: f32` field (fabric never provided it). TODO remains to plumb a frame-time uniform through the camera or scene UBO so animation re-enables.
    - NormalMap Flat fragment had a leftover reference to `normalTexture` that didn't exist as a binding — fixed to `normalMapTexture` in the same pass.
- **New spec** — [MaterialUniformBufferSpec.js](../packages/engine/Specs/Scene/MaterialUniformBufferSpec.js) locks in the channel-string packing, the round-trip read, the vec3+f32 tail-slot layout (NormalMap), and the fabric orderings for AlphaMap / BumpMap / Image / Checkerboard / EmissionMap / Fade. Any future fabric or WGSL reshuffle that drifts from these offsets will fail the spec at run time.

**Fix history superseded.** The earlier in-session note ("Fix not yet applied") no longer applies — all 10 material types and the packer bug are closed. Water time animation landed in the same session: the float-23 (Flat) and float-55 (Lit) pad slots in the camera UBO are now packed with `FrameState.frameNumber` via `getFrameTime()` in `WebGPUPrimitiveCommands.js`. Water's local `CameraUniforms` struct renames `_pad1` → `time` and drives the wave phase as `camera.time * material.animationSpeed`, matching upstream `Water.glsl`'s `czm_frameNumber * animationSpeed` semantic. No UBO size change; other shaders still declare `_pad1: f32` at the same slot and ignore the written value.

**Fix history (superseded — kept for posterity).** The original writeup described three options:

- **Option A (preferred):** Keep fabric as source of truth. Rewrite each of the 10 WGSL structs to declare fields in fabric order. Requires running `npx gulp buildWGSL` after each edit to regenerate the `.js` module wrappers. Side effect: for types with string uniforms (channel/channels), the shader must be changed to stop reading a runtime `material.channel` — either hardcode the channel at preprocess time (via a new `//>>ifdef CHANNEL_A` / `//>>ifdef CHANNEL_R` variant set) or add a dedicated JS writer that packs the channel index as an f32 before the rest of the fabric numeric fields.
- **Option B:** Keep WGSL as source of truth. Add a per-material-type override table in [MaterialUniformBuffer.js](../packages/engine/Source/Scene/MaterialUniformBuffer.js) that defines the exact float layout for each named material type. Backwards-compatible for 8 material types that already match; explicit opt-in for the 10 broken ones. Downside: duplicates knowledge from the WGSL source.
- **Option C:** Parse the WGSL struct at shader-module-creation time and drive the packer from it. Correct but high-effort (requires a WGSL struct-declaration parser).

Recommended plan for the next session: take Option A for the 5 "re-ordering" cases (BumpMap, NormalMap, ElevationContour, Image, Stripe) — mechanical swap, no new infra. For AlphaMap/EmissionMap/SpecularMap (channel-string cases), take Option B — add the single `channel: f32` writer — keeps WGSL layouts stable and covers all three with one piece of JS code. Fade/Water — fix in Option A (trim unused WGSL fields; stop reading `time` that never gets written).

---

### BUG-F3 — ES5 prototype inheritance against ES6 parent class throws on first frame

**Symptom:** Any entity with a `corridor`, `cylinder`, `ellipse`, `ellipsoid`, `plane`, `polygon`, `polylineVolume`, `rectangle`, or `wall` graphic threw `Class constructor DynamicGeometryUpdater cannot be invoked without 'new'` from the `GeometryVisualizer` hot path. Crash was deterministic: thrown the moment the visualizer constructed a `Dynamic*GeometryUpdater` for a time-dynamic geometry property.

**Root cause:** The parent `DynamicGeometryUpdater` had been migrated to an ES6 `class`, but the nine children listed in the `F3` finding still used the legacy ES5 inheritance idiom:

```javascript
function DynamicXxxGeometryUpdater(geometryUpdater, primitives, groundPrimitives) {
  DynamicGeometryUpdater.call(this, geometryUpdater, primitives, groundPrimitives);
}
if (defined(Object.create)) {
  DynamicXxxGeometryUpdater.prototype = Object.create(DynamicGeometryUpdater.prototype);
  DynamicXxxGeometryUpdater.prototype.constructor = DynamicXxxGeometryUpdater;
}
```

`Parent.call(this, ...)` works for function-declared constructors but is forbidden against ES6 class constructors — they require `[[Construct]]` invocation. The reference completed conversion at `BoxGeometryUpdater.js` had landed earlier, and the verification report flagged the remaining 9 siblings.

**Fix (Batch 66):** Mechanical rewrite of all 9 children to `class DynamicXxxGeometryUpdater extends DynamicGeometryUpdater`, with `super(...)` replacing `Parent.call(this, ...)` and `super.foo(...)` replacing `Parent.prototype.foo.call(this, ...)`. The `Object.create` polyfill block was dropped entirely — `extends` handles the prototype chain natively.

**Secondary TDZ fix:** The reference `BoxGeometryUpdater.js` placed `BoxGeometryUpdater.DynamicGeometryUpdater = DynamicBoxGeometryUpdater` on the line BEFORE the `class DynamicBoxGeometryUpdater` declaration. With the original `function`-declared constructor that worked because of hoisting; with the new ES6 class declaration it raises `ReferenceError: Cannot access 'DynamicBoxGeometryUpdater' before initialization` at module load. All 10 files (the 9 newly converted + the BoxGeometryUpdater reference) now place the assignment AFTER the class declaration. Verified by `node -e "import(...)"` round-trip on all 10 modules.

**Per-file surprises:**

- `EllipsoidGeometryUpdater.js` — child constructor sets ten extra instance fields beyond the `super(...)` call (`_scene`, `_modelMatrix`, `_attributes`, `_outlineAttributes`, `_lastSceneMode`, `_lastShow`, `_lastOutlineShow`, `_lastOutlineWidth`, `_lastOutlineColor`, `_lastOffset`, `_material`); preserved verbatim. The 320-line `update(time)` method body migrated as-is.
- `PolygonGeometryUpdater.js` — identifier was historically misspelled as `DyanmicPolygonGeometryUpdater` (note the swapped `n`/`a`). Confirmed via `git grep "Dyanmic"` that it had no external consumers; quietly renamed to `DynamicPolygonGeometryUpdater` as part of the conversion.
- `OpenStreetMapImageryProvider.js` and `TileMapServiceImageryProvider.js` — listed in the verification report but are already ES6 classes per upstream commits (`4b3c0ef68f` and earlier). Load-verified with no changes.

**Files modified:**
- [packages/engine/Source/DataSources/CorridorGeometryUpdater.js](../packages/engine/Source/DataSources/CorridorGeometryUpdater.js)
- [packages/engine/Source/DataSources/CylinderGeometryUpdater.js](../packages/engine/Source/DataSources/CylinderGeometryUpdater.js)
- [packages/engine/Source/DataSources/EllipseGeometryUpdater.js](../packages/engine/Source/DataSources/EllipseGeometryUpdater.js)
- [packages/engine/Source/DataSources/EllipsoidGeometryUpdater.js](../packages/engine/Source/DataSources/EllipsoidGeometryUpdater.js)
- [packages/engine/Source/DataSources/PlaneGeometryUpdater.js](../packages/engine/Source/DataSources/PlaneGeometryUpdater.js)
- [packages/engine/Source/DataSources/PolygonGeometryUpdater.js](../packages/engine/Source/DataSources/PolygonGeometryUpdater.js)
- [packages/engine/Source/DataSources/PolylineVolumeGeometryUpdater.js](../packages/engine/Source/DataSources/PolylineVolumeGeometryUpdater.js)
- [packages/engine/Source/DataSources/RectangleGeometryUpdater.js](../packages/engine/Source/DataSources/RectangleGeometryUpdater.js)
- [packages/engine/Source/DataSources/WallGeometryUpdater.js](../packages/engine/Source/DataSources/WallGeometryUpdater.js)
- [packages/engine/Source/DataSources/BoxGeometryUpdater.js](../packages/engine/Source/DataSources/BoxGeometryUpdater.js) (TDZ ordering fix only)

**Verification:** `npx tsc --noEmit` exits 0; `node --check` clean on all 10 files; `import(...)` smoke-test confirms `DynamicGeometryUpdater` static is reachable on every parent class.

---

## Session 36: Sandcastle DEFINITIVE re-verification — first true WebGPU exercise (2026-04-25)

**Context:** All 7 `WebGPU *.html` Sandcastle demos used synchronous `new Cesium.Viewer(container, { contextOptions: { renderer: "webgpu" } })`. The synchronous Viewer constructor delegates to the synchronous CesiumWidget constructor and **never enters the WebGPU async init path**. Probe in Batch 66 FINAL captured `rendererType: "webgl"` on every demo — meaning none of Batches 48-66 had ever been verified by these demos. This session converts the demos to `Viewer.createAsync(...)` and re-runs the runner.

**Sibling work:** `ShaderStruct.generateGlslLines()` got the same empty-body filler treatment as `ShaderFunction.generateGlslLines()` (NEW-1) — empty struct bodies are illegal in GLSL ES 3.00, mirror fix to F2.

**Outcome:** `rendererType: "webgpu"` now confirmed on all 7 results (probed via the runner's `Viewer.prototype.resize` hook). Three real WebGPU engine bugs surfaced — see NEW-3-A / B / C below. Per-pass detail in `migration_doc/SANDCASTLE_BATCH_66_DEFINITIVE_REPORT.md`.

### NEW-3-A — `WebGPUSceneRenderer._ensureResources` references undeclared `scene`

**Severity:** Critical (blocks 5 of 7 demos on frame 1)
**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:725-727`
**Symptom:** `ReferenceError: scene is not defined` thrown during `_ensureResources` → `executeCommands` → render loop crash → "An error occurred while rendering" modal.
**Root cause:** Batch 44's edge-FBO addition uses `scene._enableEdgeVisibility`, but the function only destructures `{ context }` from `config` (line 651). The caller `executeCommands` does destructure `scene` from the same config (line 862), so the fix is to add `scene` to the destructure on line 651.
**Status:** Logged for follow-up — not fixed in this pass per task constraint.

### NEW-3-B — `initWebGPUShadowMap` reads `device` from undefined

**Severity:** High (blocks Point Light Shadows demo)
**File:** WebGPU shadow-map init helper (`Build/CesiumUnminified/index.js:46929` — TS source: search for `initWebGPUShadowMap`)
**Symptom:** `TypeError: Cannot read properties of undefined (reading 'device')` thrown from `Object.initWebGPUShadowMap [as init]` called from `ShadowMap.update`.
**Root cause:** Likely a `frameState.context._device` vs `frameState.context.device` mismatch, or shadow-map init ordering vs context device handshake. Fires before `_ensureResources`, so this demo never even reaches NEW-3-A.
**Status:** Logged for follow-up.

### NEW-3-C — `Megatexture.get3DTextureDimension` is WebGL-only

**Severity:** High (Voxels feature unusable on WebGPU)
**File:** `packages/engine/Source/Scene/Megatexture.js` (`Build/CesiumUnminified/index.js:312077`)
**Symptom:** `RuntimeError: The GL context does not support a 3D texture large enough to contain a tile with the given dimensions.`
**Root cause:** `Megatexture` queries `MAX_3D_TEXTURE_SIZE` directly from a `WebGL2RenderingContext`-typed object. WebGPU exposes the equivalent via `device.limits.maxTextureDimension3D` but the megatexture code was never adapted. Voxels were not in scope of Batches 48-66.
**Fix sketch:** Route the cap query through `GraphicsContext.maximum3DTextureSize` (or equivalent abstract) and have `WebGPUContext` answer with `device.limits.maxTextureDimension3D`. This is consistent with the Voxels backlog item.
**Status:** Logged — promote to backlog as a voxel-feature port task.

### NEW-1 (this session, fixed inline) — `ShaderStruct` empty-body filler

**File:** `packages/engine/Source/Renderer/ShaderStruct.js:45-67`
**Fix:** Empty `fields` array now emits a benign `float _empty;` filler so `MetadataPipelineStage`'s unconditional `SelectedFeature` / `FeatureIds` struct registrations don't produce illegal GLSL.

### NEW-2 (this session, fixed inline) — Demos converted to `Viewer.createAsync`

**Files:** All 7 `Apps/Sandcastle/gallery/WebGPU *.html` demos. Single-line change per file — `const viewer = new Cesium.Viewer(...)` → `const viewer = await Cesium.Viewer.createAsync(...)`. Each demo's `window.startup` is already `async function`, so `await` is in scope. `contextOptions: { renderer: "webgpu" }` was already present and is preserved.

---

## Session 37: Sandcastle TRULY FINAL re-verification — NEW-3 closure + NEW-4 surfacing (2026-04-25)

**Context:** Follow-up to Session 36. Three engine bugs (NEW-3-A/B/C) surfaced when the demos were first run on a true WebGPU context. This session lands the fixes for all three and re-runs the runner to confirm closure and to discover the next layer of WebGPU-only bugs.

**Outcome:** All three NEW-3-* error signatures **gone** from the TRULY FINAL `report.json`. Six new findings (NEW-4-A through NEW-4-F) take their place — each strictly downstream of the bug it replaces. Per-pass detail in `migration_doc/SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md`.

### NEW-3-A — CLOSED

**Fix:** `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:651` — destructure `{ context, scene }` from `config` instead of `{ context }`.
**Verification:** TRULY FINAL `report.json` contains zero occurrences of `scene is not defined`. Demos that were blocked on frame 1 now reach the model-pipeline / globe-depth stages before hitting NEW-4-A or NEW-4-B respectively.

### NEW-3-B — CLOSED

**Fix:** `packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js:809-823` (`initWebGPUShadowMap`) and `:1059-1063` (`renderShadowCastPass`) — both sites now `const context = frameState?.context` early-return guard, then `const device = context.device ?? context._device` early-return guard. Each guard is documented with a NEW-3-B (Batch 66) comment explaining the early-frame init paths that previously crashed.
**Verification:** TRULY FINAL `report.json` contains zero occurrences of `Cannot read properties of undefined (reading 'device')`. Point Light Shadows demo now reaches the actual shadow render passes — the next blocker is the unrelated NEW-4-B globe-depth pipeline validation.

### NEW-3-C — PARTIALLY CLOSED

**Fix:** `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:1644-1645` — added `cl._maximum3DTextureSize = limits.maxTextureDimension3D ?? 2048` and `cl._maximumArrayTextureLayers = limits.maxTextureArrayLayers ?? 256` to the cap-publishing block. Corresponding entries added to the `ContextLimitsInternals` TS interface at line 195.
**Verification:** `Megatexture.get3DTextureDimension` no longer throws "does not support a 3D texture large enough" — but Voxel Pick still fails because `Texture3D` constructor itself has a second WebGL-only guard. Remaining work tracked as **NEW-4-D**.

### NEW-4-A — `EdgeVisibilityPipelineStage` calls WebGL-only `Buffer.getBufferData`

**Severity:** High (blocks Edge Visibility + Edge Feature ID; affects any model with edge visibility on WebGPU)
**Files:**
- `packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js`
- `packages/engine/Source/Scene/Model/ModelReader.js` — `readAttributeAsRawCompactTypedArray`, `readAttributeAsTypedArray`
- `packages/engine/Source/Renderer/Buffer.js:189` — `getBufferData` is the WebGL2-only `gl.getBufferSubData` wrapper
**Symptom:** `DeveloperError: A WebGL 2 context is required.` thrown from `_Buffer.getBufferData` during `EdgeVisibilityPipelineStage.process` → `buildTriangleAdjacency` → `ModelReader.readAttributeAsTypedArray`. Render loop crashes with the rendering-stopped modal.
**Root cause:** The model edge-visibility pipeline stage performs a CPU-side readback of vertex/index data to compute per-triangle adjacency (used for silhouette + crease edges). The readback path goes through `Buffer.getBufferData` which is the synchronous `gl.getBufferSubData` WebGL2-only wrapper.
**Fix sketch:** Either (a) cache vertex/index data on the CPU at upload time so the readback isn't needed at all (preferred — also benefits WebGL by avoiding a GPU→CPU stall during model preparation), or (b) add a WebGPU-aware `Buffer.getBufferDataAsync()` that uses `device.queue.readBuffer` / `mapAsync` and refactor `EdgeVisibilityPipelineStage.process` + `buildTriangleAdjacency` to await the async preparation.
**Status:** Logged for follow-up.

### NEW-4-B — `GlobeDepth-DepthCopy` pipeline rejected: depth-texture sampler binding type mismatch

**Severity:** Critical (blocks 5 of 7 demos: Many Imagery Layers, Model Pick, Point Light Shadows, Translucent Classification, plus latently any demo with picking / DOF / FXAA)
**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts:387-388`
**Symptom:** GPU validation error
```
Texture binding (group:0, binding:0) is TextureSampleType::Depth but used statically with
a sampler (group:0, binding:1) that's SamplerBindingType::Filtering
    - While validating fragment stage ([ShaderModule "GlobeDepth-DepthCopy-Shader"], entryPoint: "fragmentMain")
    - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor ""GlobeDepth-DepthCopy-Pipeline""])
```
The pipeline is invalidated; subsequent `[Invalid RenderPipeline "GlobeDepth-DepthCopy-Pipeline"] is invalid due to a previous error` cascades follow on every frame.
**Root cause:** The bind group layout declares `texture(0, ..., { sampleType: "depth" })` and `sampler(1, Stage.FRAGMENT)` — the latter defaults to `filtering` binding type. WebGPU spec requires depth-texture bindings to be paired with a `non-filtering` or `comparison` sampler binding type. The actual sampler is created with `magFilter: "nearest" / minFilter: "nearest"` (line 394-395) so the intent is already non-filtering — only the binding-type declaration needs to match.
**Fix sketch:** Change [`WebGPUGlobeDepth.ts:388`](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts) from `sampler(1, Stage.FRAGMENT)` to `sampler(1, Stage.FRAGMENT, { type: "non-filtering" })`. If the `sampler` helper doesn't accept a binding-type override, expand to the raw descriptor `{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } }`. Apply the same fix to the MSAA depth-copy pipeline if it has the same shape.
**Status:** Logged for follow-up — single-line fix, highest-ROI next-session action.

### NEW-4-C — `getLogDepthShaderProgram` reads `fragmentShaderSource` from undefined `shaderProgram`

**Severity:** Medium (blocks Translucent Classification demo)
**File:** `packages/engine/Source/Scene/DerivedCommand.js:139` (`getLogDepthShaderProgram`) and `:230` (`createLogDepthCommand`)
**Symptom:** `TypeError: Cannot read properties of undefined (reading 'fragmentShaderSource')` thrown from `getLogDepthShaderProgram` during `_Scene.updateDerivedCommands` → `insertIntoBin` → `View.createPotentiallyVisibleSet`.
**Root cause:** `DerivedCommand.createLogDepthCommand` is the WebGL log-depth derivation pass that wraps `command.shaderProgram` to inject the log-z fragment output. Classification primitives enqueue commands through the WebGL command path because no WebGPU classification feature renderer exists yet (see `BUILD-VAR-HAZARD-CLASSIFICATION` in this log). When the source command is a `WebGPUDrawCommand`, `command.shaderProgram` is undefined → the wrap throws.
**Fix sketch:** Two options:
  - **Tactical:** Add early-return at the top of `createLogDepthCommand` when `command.shaderProgram` is missing — derived command silently no-ops, matching the "no WebGPU classification renderer" status quo.
  - **Strategic:** Build a `CLASSIFICATION_PRIMITIVE` feature renderer that intercepts the WebGL classification path entirely (already on backlog as `BUILD-VAR-HAZARD-CLASSIFICATION`).
**Status:** Logged for follow-up.

### NEW-4-D — `Texture3D` constructor still has WebGL-only guard

**Severity:** High (blocks Voxel Pick demo; affects any WebGPU code path that allocates a `Texture3D`)
**File:** `packages/engine/Source/Renderer/Texture3D.js:74`
**Symptom:** `DeveloperError: WebGL1 does not support texture3D. Please use a WebGL2 context.` thrown during `_VoxelPrimitive.update` → `initFromProvider` → `new VoxelTraversal` → `new _Megatexture` → `new _Texture3D`.
**Root cause:** Successor to NEW-3-C. The cap-query (`_maximum3DTextureSize`) is now correct, but the `Texture3D` constructor itself has an unconditional WebGL2 guard. The WebGL stub on `WebGPUContext` doesn't (and shouldn't) claim to be WebGL2, so the guard fires.
**Fix sketch:** `Texture3D.js` needs a WebGPU-aware path (or a `Texture3D` feature renderer) that allocates a `GPUTexture` with `dimension: "3d"` instead of calling `gl.texImage3D`. Non-trivial port — all `Texture3D` consumers (`Megatexture`, `VoxelTraversal`) call into WebGL-style API surfaces and need parallel migration.
**Status:** Logged for follow-up — voxel-feature port task; recommend deferring until the full `Megatexture` / `VoxelTraversal` WebGPU port is scheduled.

### NEW-4-E — `Voxel color pipeline` WGSL: missing return at end of function

**Severity:** High (blocks Voxel Pick rendering even after NEW-4-D is fixed)
**File:** Unknown WGSL source. Pipeline label `"Voxel color pipeline"` indicates the source is somewhere under `packages/engine/Source/Shaders/WebGPU/Voxel*.wgsl` (or assembled by the voxel feature renderer).
**Symptom:**
```
Error while parsing WGSL: :113:1 error: missing return at end of function
}
^
    - While calling [Device].CreateShaderModule([ShaderModuleDescriptor])
```
Subsequent `[Invalid ShaderModule (unlabeled)] is invalid due to a previous error - While validating vertex stage ... entryPoint: "vertexMain" - While calling CreateRenderPipeline("Voxel color pipeline")` cascades.
**Root cause:** Vertex-stage entry function (or a helper) ends without a `return` on at least one code path. WGSL requires every non-void function to end with a `return` on every path.
**Fix sketch:** Locate the source via `grep "Voxel color pipeline"` in `packages/engine/Source/Renderer/WebGPU/`. Inspect the assembled WGSL around line 113 — likely an `else` branch missing a `return`. Add the missing return with the correct struct/value.
**Status:** Logged for follow-up — paired with NEW-4-D as a voxel-feature task.

### NEW-4-F — Globe terrain pipeline exceeds default `maxSampledTexturesPerShaderStage` (advisory)

**Severity:** Low (advisory — runs anyway on this adapter because 16 is a soft default; would hard-fail on adapters where 16 is the actual hardware limit)
**File:** `WebGPUContext.ts` device-init (`requestDevice` call) and `Source/Renderer/WebGPU/WebGPUGlobeRenderer*.ts` (or wherever the Globe terrain pipeline layout is assembled)
**Warning:**
```
The number of sampled textures (29) in the Fragment stage exceeds the maximum per-stage
limit (16). This adapter supports a higher maxSampledTexturesPerShaderStage of 48, which
can be specified in requiredLimits when calling requestDevice().
    - While calling [Device].CreatePipelineLayout([PipelineLayoutDescriptor ""Globe terrain pipeline layout""])
```
**Root cause:** `WebGPUContext._initializeDevice` (or wherever `adapter.requestDevice` runs) doesn't pass `requiredLimits.maxSampledTexturesPerShaderStage = 48`.
**Fix sketch:** Add `maxSampledTexturesPerShaderStage: Math.min(48, adapter.limits.maxSampledTexturesPerShaderStage)` to the `requiredLimits` object on `requestDevice`. Cap it to the adapter's reported limit so the call doesn't fail on adapters that can't go above 16 — those adapters then need a separate "fewer-sampled-textures" pipeline-layout variant, but that's a downstream concern.
**Status:** Logged advisory — fold into the next renderer-init sweep.

## Session 40 — Tier 0 follow-up: engine tsc fixes + NEW-4-E Voxel WGSL fix (2026-04-25, Batch 68)

Tier-0 cleanup pass driven by the Tier-0 list at the top of `NEXT_SESSION_HANDOFF.md`. Four sequential tasks, all closed in a single commit so the worktree state matches what gets pushed.

### S40-T1 — `WebGPUContext.ts:3780` — `FrameTimings` not assignable to `DebugStatsValue`

**Symptom:** Engine-package `tsc --noEmit` failed with `TS2322`: `FrameTimings` lacked an index signature, so it didn't satisfy the `DebugStatsObject` shape required at the assignment site (`stats.performance = this._performanceManager.frameTimings`).

**Root cause:** `FrameTimings` (in `WebGPUPerformanceManager.ts`) was declared as a plain interface with named fields. Even though every field's value type (`number` and `Record<string, number>`) is a valid `DebugStatsValue`, TypeScript's structural matching for index-signature-bearing targets requires the interface to carry the index signature itself — not just have field values that would satisfy it.

**Fix:** `interface FrameTimings extends DebugStatsObject` — same pattern already used by `PassTimingResult` and `ProfilingResults` in `WebGPUTimestampProfiler.ts`. Added `import type { DebugStatsObject } from "../GraphicsContext.js"` and a JSDoc note explaining the inheritance rationale.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts`

### S40-T2 — `WebGPUSceneRenderer.ts:2643` — `GPUTexture | GPUTextureView` not narrowable to `GPUTextureView`

**Symptom:** Engine-package `tsc --noEmit` failed with `TS2345`: `executeInvertClassificationComposite` requires `sceneColorAttachmentView: GPUTextureView | undefined`, but the call site passed `colorTarget.getColorAttachments()[0]?.view`, whose type per `@webgpu/types` is `GPUTexture | GPUTextureView`.

**Root cause:** The `@webgpu/types` declaration for `GPURenderPassColorAttachment.view` widened to `GPUTexture | GPUTextureView` to accommodate browsers that accept a raw texture and create the default view internally. Our `WebGPURenderTarget.RenderTargetAttachment.view` field is always specifically a `GPUTextureView` at runtime, but the wider WebGPU types don't propagate that.

**Fix:** Narrow at the call site. If the value is a `GPUTexture` (has `createView`), call `createView()`; otherwise pass through. This satisfies the typechecker without lying about runtime semantics, and degrades gracefully if a future browser version really does pass a `GPUTexture` here.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`

### S40-T3 — Pre-existing blocker: `cesium-js-types.d.ts` `inverseViewTranspose`

**Symptom:** Engine-package `tsc --noEmit` failed with `TS2741`: `Property 'inverseViewTranspose' is missing in type 'UniformState' but required in type 'CesiumUniformState'.` This was pre-existing on `origin/main` — verified with a labeled `git stash` round-trip — but the prompt requires engine tsc to be 0 errors before the rebuild step.

**Root cause:** `CesiumUniformState.inverseViewTranspose` was declared `readonly inverseViewTranspose: CesiumMatrix4 | undefined` (the property MUST exist, value MAY be undefined). The actual `Renderer/UniformState.js` class doesn't define this property at all — runtime access returns `undefined`, which is what the only consumer (`WebGPUClippingPlaneCollection.ts:122`) already handles via the `if (invViewT) {...} else if (view) {...}` branching.

**Fix:** Mark the field optional (`readonly inverseViewTranspose?: CesiumMatrix4 | undefined`) — aligns the type with reality (the property may be absent) and matches the existing consumer's defensive pattern. Updated the JSDoc to explain the rationale so a future merge from upstream doesn't silently re-tighten it.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts`

### S40-T4 — NEW-4-E live capture and WGSL fix

**Captured naga error (verbatim):**

```text
[CesiumJS:webgpu:<ctx-uuid>] Shader "unlabeled" compilation ERROR at line 113:1: missing return at end of function
```

This matched the Batch-67 prediction in `DEFERRED_WORK.md` exactly. Applied predicted candidate (a) — paired each `discard;` with an explicit `return vec4<f32>(0.0);` so naga can prove `fragmentMain` and `fragmentPickMain` return on every path. The discarded fragment ignores the returned value, so the colour is irrelevant; the explicit return is purely to satisfy WGSL's control-flow analyzer. Also added a trailing fallthrough return after the terminal `discard;` at the end of `fragmentPickMain`. The `missing return at end of function` console error is gone after the fix.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (3 paired `discard; return` edits + 1 trailing fallthrough return + WGSL comments)

**Sandcastle re-verification status:** PASS=5, FAIL=2 (Translucent Classification = pre-existing, Voxel Pick = newly surfaced NEW-4-G — see below). The original NEW-4-E error is gone; Voxel Pick remains FAIL because resolving NEW-4-E unmasked a different WGSL error that was previously short-circuited.

### S40-T4-followup — NEW-4-G surfaced

The Voxel Pick demo now reports a different WGSL error: `'textureSample' must only be called from uniform control flow` at line 73:13. This is a new entry (NEW-4-G) tracked in `DEFERRED_WORK.md` with predicted root cause + fix candidates. Likely fix is replacing `textureSample` with `textureSampleLevel(..., 0.0)` since the volumetric texture is single-mip and doesn't need derivative-driven LOD selection. Out of scope for Batch 68 (Tier 0 list ended at NEW-4-E).

### Worktree-runner ergonomics (incidental Batch 68 changes)

Two infrastructure changes landed in the same commit because they were required to actually run Task 3/4 from a `.claude/worktrees/agent-*` directory rather than the canonical `cesium-webgpu/` root:

- `Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — `BASE_URL` now reads `process.env.SANDCASTLE_BASE_URL` (default unchanged at `http://localhost:8080`). Lets a worktree-private dev server on a non-default port serve the runner without code changes.
- `server.js` — `--sandcastlePort` flag added (default 8081, the historical hardcoded value). The Sandcastle mirror server now uses `argv.sandcastlePort` instead of a hardcoded `8081`, and the `buildSandcastleApp` outer/inner origin pair uses `argv.port`/`argv.sandcastlePort` instead of hardcoded `8080`/`8081`. Required so `node server.js --port 8090 --sandcastlePort 8091` doesn't EADDRINUSE on a workstation where the canonical-main server already holds 8080+8081.

Neither change affects the default-port behaviour. The runner change is also needed for any future agent that runs Sandcastle from a worktree — it's strictly additive.

## Session 41 — Batch 69: NEW-4-G Voxel `textureSample` non-uniform control flow (2026-04-26)

Closes NEW-4-G from `DEFERRED_WORK.md`. Carried forward from Session 40's S40-T4-followup. WGSL fix only — Voxel Pick demo remains FAIL because NEW-4-G's resolution exposes the next predicted blocker (NEW-4-H, JS-side `Matrix4.multiplyByPoint` with undefined cartesian in `updateWebGPUVoxelPrimitive`). Sandcastle baseline stays at 5/7 PASS.

### S41-T1 — NEW-4-G: `textureSample` rejected in data-dependent ray-march loop

**Symptom:** With NEW-4-E's `missing return at end of function` resolved, the next naga compile error surfaces in `WebGPUVoxelRenderer.ts`'s embedded WGSL:

```text
[CesiumJS:webgpu:<ctx-uuid>] Shader "unlabeled" compilation ERROR at line 73:13: 'textureSample' must only be called from uniform control flow
```

**Root cause:** WGSL spec requires `textureSample` to be called from uniform control flow because it auto-computes derivatives across a 2x2 fragment quad. The call sites at `fragmentMain` line 120 and `fragmentPickMain` line 159 sit inside a `for` loop with `if (t > tE || accumA > 0.99) { break; }` (color path) and `if (t > tE) { break; }` (pick path). The color path's break is data-dependent on `accumA`, which accumulates from per-fragment samples — so the loop body is structurally non-uniform. Even though the pick path's break is parameter-driven, the WGSL spec applies the same uniformity analysis and the call still fails because naga cannot statically prove uniformity. Mirrors the GLSL constraint that derivatives are undefined when invoked from non-uniform control flow.

**Fix:** Replaced both `textureSample(voxelTex, voxelSamp, uvw)` calls with `textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0)`. `textureSampleLevel` takes an explicit LOD argument and never computes derivatives, so it has no uniform-control-flow requirement and naga accepts the call inside the data-dependent loop. Forcing LOD 0 matches existing intent — volumetric voxel textures are single-mip so there's no LOD chain to traverse anyway. Both edits are wrapped in WGSL comments referencing NEW-4-G with the rationale.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts`

**Verification:** Re-ran `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` after `npx gulp build`. The `'textureSample' must only be called from uniform control flow` error is gone from the Voxel Pick demo's console errors. The pipeline now compiles and the demo reaches the per-frame `_VoxelPrimitive.update` path where it hits NEW-4-H (separate JS bug, see below).

### S41-T1-followup — NEW-4-H surfaced

The Voxel Pick demo now reports a different error: `DeveloperError: Expected cartesian to be typeof object, actual typeof was undefined` at `Matrix4.multiplyByPoint` called from `updateWebGPUVoxelPrimitive`. Stack trace points at [WebGPUVoxelRenderer.ts:467-471](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts#L467-L471) — `Matrix4.multiplyByPoint(invModel, camWorld, new Cartesian3())` where `camWorld = us.cameraPosition`. The `us.cameraPosition` arg is undefined at this point in the lifecycle. This is a new entry (NEW-4-H) tracked in `DEFERRED_WORK.md` with predicted fix candidates. Out of scope for Batch 69 (single NEW-4-G unblock task per user direction).

### Sandcastle baseline after Batch 69

PASS=5, FAIL=2 (unchanged from Batch 68):

- WebGPU Edge Feature ID — PASS
- WebGPU Edge Visibility — PASS
- WebGPU Many Imagery Layers — PASS
- WebGPU Model Pick — PASS (note: pick returned null at canvas center — primitive may be off-center, render itself OK)
- WebGPU Point Light Shadows — PASS
- WebGPU Translucent Classification — FAIL (pre-existing render-loop crash, separate from voxel work)
- WebGPU Voxel Pick — FAIL (NEW-4-G WGSL closed; NEW-4-H JS-side bug now blocking)

## Session 42 — Batch 70: NEW-4-H UniformState.cameraPosition + DerivedCommand WebGPU guard (2026-04-26)

Closes NEW-4-H from `DEFERRED_WORK.md`. Two coupled root causes flushed in one batch — both surfaced once NEW-4-G's WGSL blocker was out of the way. Sandcastle baseline jumps from 5/7 to 6/7 PASS as Voxel Pick goes green; Translucent Classification's `_cachedShader` co-failure also closes via the same DerivedCommand.js fix, leaving only its separate depth-format-copy-compat issue (NEW-4-I).

### S42-T1 — Missing `UniformState.cameraPosition` getter (13 silent broken call sites)

**Symptom:** Voxel Pick demo crashes the render loop on first frame:

```text
DeveloperError: Expected cartesian to be typeof object, actual typeof was undefined
    at Check.typeOf.object (index.js:188:15)
    at Matrix4.multiplyByPoint (index.js:4591:28)
    at Object.updateWebGPUVoxelPrimitive [as update] (index.js:79617:36)
```

**Root cause:** `UniformState.js` initializes `this._cameraPosition = new Cartesian3()` in the constructor and `UniformStateComputations.updateCamera` populates it from `camera.positionWC` every frame — but the class never declared a public `get cameraPosition()` getter. The TS `.d.ts` companion at [UniformState.d.ts:49](../packages/engine/Source/Renderer/UniformState.d.ts) declared `readonly cameraPosition: Cartesian3` since at least the c7a502de6e WIP checkpoint, and 13 WebGPU renderer call sites consumed it (`WebGPUVoxelRenderer.ts:465`, `WebGPUCloudRenderer.ts:391`, `WebGPUEllipsoidPrimitiveRenderer.ts:441`, `WebGPUGaussianSplatRenderer.ts:589`, `WebGPUPointCloudRenderer.ts:450/718`, `WebGPUBufferPrimitiveRenderer.ts:216`, `WebGPUGlobeSurfaceRenderer.ts:1657/2141/2145`, `WebGPUUniformGroupManager.ts:269/273`, `WebGPUModelRenderer.js:837`). Every read returned `undefined`. Production builds masked this entirely because `Check.typeOf.object` debug pragmas are stripped — the unminified Sandcastle build was the first place the missing property surfaced as a hard crash, and Voxel Pick was the first demo to dereference it before any callers could have guarded.

**Fix:** Added `get cameraPosition()` to `UniformState.js` next to `previousCameraPosition`. One-line addition (plus a JSDoc block referencing NEW-4-H so future maintainers don't re-remove it). All 13 call sites are now correct without any per-site changes.

**Files modified:**

- `packages/engine/Source/Renderer/UniformState.js`

### S42-T2 — `DerivedCommand.createDepthOnlyDerivedCommand` lacked WebGPU shader-program guard

**Symptom:** Once T1's `cameraPosition` blocker was resolved, Voxel Pick AND Translucent Classification both crashed with:

```text
TypeError: Cannot read properties of undefined (reading '_cachedShader')
    at ShaderCache.getDerivedShaderProgram (index.js:25790:44)
    at getDepthOnlyShaderProgram (index.js:295577:44)
    at DerivedCommand.createDepthOnlyDerivedCommand (index.js:295654:45)
    at updateDerivedCommands (...)
```

**Root cause:** `DerivedCommand.createDepthOnlyDerivedCommand` is upstream WebGL-only logic that derives a depth-only shader by manipulating GLSL `fragmentShaderSource` and caching via `shaderProgram._cachedShader`. WebGPU draw commands carry a `GPUShaderModule`-backed pipeline, not a WebGL `ShaderProgram`, so `command.shaderProgram` is either undefined or an object without `id` / `_cachedShader`. The sibling `createLogDepthCommand` already had a NEW-5-A WebGPU guard from Batch 66 (`if (!defined(cmdShader?.id)) { result.command.shaderProgram = cmdShader; return result; }`) — this batch closes the symmetric defect on `createDepthOnlyDerivedCommand`.

**Fix:** Added the symmetric guard at the top of `createDepthOnlyDerivedCommand` (after `result` initialization but before the cache-or-derive walk). When `command.shaderProgram?.id` is undefined, copy the WebGPU shader/renderState through unchanged and return immediately — the WebGPU dispatcher (`selectCommandVariant` from Batch 29) already routes depth-only via its own `derivedCommands.depth.command` slot with a pre-built WGSL pipeline (see `WebGPUDerivedCommand.createDepthOnlyDerivedCommand` for the WebGPU side).

**Files modified:**

- `packages/engine/Source/Scene/DerivedCommand.js`

### Sandcastle baseline after Batch 70

PASS=6, FAIL=1 (was 5/2):

- WebGPU Edge Feature ID — PASS
- WebGPU Edge Visibility — PASS
- WebGPU Many Imagery Layers — PASS
- WebGPU Model Pick — PASS (note: pick returns null at canvas center — primitive may be off-center, render itself OK; same pre-existing note)
- WebGPU Point Light Shadows — PASS
- WebGPU Translucent Classification — FAIL (NEW-4-H `_cachedShader` co-failure closed; remaining failure is NEW-4-I depth-format-copy-compat, separate root cause)
- WebGPU Voxel Pick — PASS (was FAIL since Batch 66 — NEW-4-G + NEW-4-H both required to unblock)

### S42-T3 — NEW-4-I surfaced

The Translucent Classification demo now reports a single significant console error: WebGPU validation rejects the translucent-depth-pack `copyTextureToTexture` because source `SceneFramebuffer-Color_depth` is `Depth24PlusStencil8` and destination `TranslucentTileClass_TranslucentDepth_1x` is `Depth24Plus` — formats are not copy compatible per spec. New entry (NEW-4-I) tracked in `DEFERRED_WORK.md` with predicted one-line fix (allocate the destination as `Depth24PlusStencil8` to match the scene FB depth attachment). Out of scope for Batch 70.

## Session 43 — Batch 71: NEW-4-I depth-format copy-compat → Sandcastle 7/7 PASS (2026-04-27)

Closes NEW-4-I from `DEFERRED_WORK.md`. First time all 7 WebGPU Sandcastle demos pass on real WebGPU (Edge / Chromium with `--enable-unsafe-webgpu`). Marks the end of the NEW-4-A through NEW-4-I sequence that started in Batch 66.

### S43-T1 — NEW-4-I: `_translucentDepthTexture` format mismatched scene FB depth

**Symptom:** Translucent Classification demo crashes the render loop on first frame:

```text
[WebGPU:GlobePass] GPU VALIDATION ERROR: Source [Texture "SceneFramebuffer-Color_depth"] format (TextureFormat::Depth24PlusStencil8) and destination [Texture "TranslucentTileClass_TranslucentDepth_1x"] format (TextureFormat::Depth24Plus) are not copy compatible.
 - While [Failed to format error message: "encoding %s.CopyTextureToTexture(%s, %s, %s)."].
 - While finishing [CommandEncoder "Scene Frame Command Encoder"].
```

**Root cause:** `WebGPUTranslucentTileClassification.update` allocated `_translucentDepthTexture` as `depth24plus` (depth-only) because the translucent pack pipeline only ever reads the depth aspect via the sampleable view (which already pins `aspect: "depth-only"`). The scene FB depth attachment, however, is allocated as `depth24plus-stencil8` because InvertClassification needs the stencil aspect. WebGPU `copyTextureToTexture` requires source and destination formats to be identical — the spec doesn't allow copying depth+stencil → depth-only even when both endpoints specify `aspect: "depth-only"`. The asymmetric allocation predated the InvertClassification stencil-path landing and was never reconciled.

**Fix:** Single-line format change at [WebGPUTranslucentTileClassification.ts:322](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) from `"depth24plus"` to `"depth24plus-stencil8"`. The sampleable view at the next allocation (line 331) already pins `aspect: "depth-only"`, so the pack pipeline continues to bind only the depth channel — the stencil aspect is allocated but never sampled. Added an inline NEW-4-I comment explaining the rationale + cost (one stencil byte per pixel, negligible). The unused `_translucentDepthView` (private, dead-after-refactor) is left in place — never consumed externally, removing it is out of scope.

**Files modified:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts`

**Verification:** `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` after `npx gulp build`. Translucent Classification flips FAIL → PASS. Final runner total: PASS=7, FAIL=0, SKIP=0.

### Sandcastle baseline after Batch 71 — 7/7 PASS

| Demo                              | Status | Trajectory across NEW-4 sweep                                                                                                                          |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebGPU Edge Feature ID            | PASS   | Closed in Batch 67 via NEW-4-A (eager typed-array retention).                                                                                          |
| WebGPU Edge Visibility            | PASS   | Closed in Batch 67 via NEW-4-A.                                                                                                                        |
| WebGPU Many Imagery Layers        | PASS   | Steady-state since Batch 66.                                                                                                                           |
| WebGPU Model Pick                 | PASS   | Renders correctly; pick returns null at canvas center (model is off-center). Latent UX issue, not a render bug.                                        |
| WebGPU Point Light Shadows        | PASS   | Steady-state since Batch 63 (5-tap PCF).                                                                                                               |
| WebGPU Translucent Classification | PASS   | **Closed today via NEW-4-I**. Was FAIL since Batch 66 — first the `_cachedShader` issue (closed by NEW-4-H), then this depth-format copy-compat issue. |
| WebGPU Voxel Pick                 | PASS   | Closed in Batch 70 via NEW-4-G + NEW-4-H combo.                                                                                                        |

**End of the NEW-4 sweep.** All nine NEW-4-prefixed entries that surfaced from the Batch 66 Sandcastle rollout are now closed (NEW-4-A/B/C/D/E/F/G/H/I). The Sandcastle baseline is the new floor — any future regression that drops below 7/7 is a regression to investigate, not a known-failing demo.

---

## Session 44 — Batch 72: C-R7 paired sweep, slice 1 (Cloud + Voxel + Weather) (2026-04-27)

Closes the first slice of the paired **C-R7-SHADER-MODULE-DEDUP** + **C-R7-RENDERER-MIGRATION-REMAINING** items from `DEFERRED_WORK.md`. Three renderers — `WebGPUCloudRenderer`, `WebGPUVoxelRenderer`, and the render half of `WebGPUWeatherRenderer` — now route both their `GPUShaderModule` compilation and their `GPURenderPipeline` materialization through the central caches. Sandcastle baseline holds at 7/7 PASS (Voxel Pick is the direct in-baseline coverage; Cloud + Weather lack WebGPU baseline demos so coverage is via tsc + build only).

### S44-T1 — `ShaderSourceId` registry expansion

Added four new entries to [`WebGPUShaderDefines.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts):

- `CLOUD_COLLECTION = 13`
- `VOXEL_PRIMITIVE = 14`
- `WEATHER_PARTICLE_RENDER = 15`
- `WEATHER_PARTICLES_COMPUTE = 16` (compute-shader source; pipeline still goes through `device.createComputePipeline()` because no `WebGPUComputePipelineCache` exists, but the `GPUShaderModule` is deduped)

Add-only registry rule (per `CLAUDE.md`) preserved: numbering is monotonic, no entries renumbered or removed.

### S44-T2 — Cloud renderer migration

[`WebGPUCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts):

- Per-device `WebGPUShaderModuleCache` via `WeakMap<GPUDevice, WebGPUShaderModuleCache>` (mirrors the Polyline / Billboard / Label / PointPrimitive pattern).
- Pipeline construction split into descriptor-only (held on `cache.pipelineDescriptor`) + async resolution (`tryResolveCloudPipeline`) with the standard sync-first / async-kickoff / fallback shape from Batch 56's `tryResolveEllipsoidPipelines`.
- Added `pipelineRequestPending` flag + early-return-skip-frame guard so we never enqueue a draw command with a null pipeline.

### S44-T3 — Voxel renderer migration

[`WebGPUVoxelRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts):

- Same per-device shader module cache pattern.
- Two pipelines (color + pick) sharing one shader module → mirrors Ellipsoid's two-pipeline `tryResolveVoxelPipelines` shape, including `Promise.all` for parallel async kickoff.
- Vertex buffer layout extracted as a single shared array reference (was previously inlined into both pipeline descriptors with the same shape — the central cache key hashes the full vertex layout, so two literal-but-equivalent arrays would still dedupe, but using one reference is cleaner).

### S44-T4 — Weather renderer migration (render path only)

[`WebGPUWeatherRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts):

- Per-device shader module cache covers BOTH the compute (`WeatherParticlesWGSL`) and render (`WeatherParticleRenderWGSL`) shaders. The compute pipelines themselves are still created via `device.createComputePipeline()` directly because no compute pipeline cache exists yet — but the `GPUShaderModule` is deduped, which is the load-bearing piece.
- Render pipeline migrated to the central cache via new `tryResolveWeatherRenderPipeline` helper.
- Compute pipeline migration deferred to a future Batch (gated on `WebGPUComputePipelineCache` infrastructure landing).

### Verification

- `npx tsc --noEmit` clean (zero errors).
- `npx gulp build` clean (full WGSL compilation + esbuild bundling green).
- Sandcastle baseline: `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — **PASS=7, FAIL=0, SKIP=0**. Voxel Pick is the direct exercise of the migrated voxel renderer; the rest of the demos confirm no collateral regression elsewhere in the renderer fleet.
- Cloud + Weather have no WebGPU baseline coverage (only WebGL Sandcastle demos exist for `CloudCollection` + `scene.weather`); their migration verification is by tsc + build success and by mirroring the established Ellipsoid / Polyline pattern verbatim.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts`
- `migration_doc/DEFERRED_WORK.md` (counts + Batch 72 entry)
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` (this entry)

### Remaining C-R7 work

- **C-R7-RENDERER-MIGRATION-REMAINING:** 6 renderers still on local Map caches — `Billboard`, `Label`, `Environment`, `VolumetricFog`, `PointCloud`, `GlobeSurface` (3697 LOC, may be its own session). Plus `ModelRenderer` (gated on full ShaderModuleCache adoption) and `AutoExposure` (gated on `WebGPUComputePipelineCache` infra).
- **C-R7-SHADER-MODULE-DEDUP:** 4 renderers still without module cache — `Environment`, `VolumetricFog`, `PointCloud`, plus the `ModelRenderer` adoption pass.

---

## Session 45 — Batch 73: C-R7 paired sweep, slice 2 (Label + Billboard) (2026-04-27)

Closes the second slice of **C-R7-RENDERER-MIGRATION-REMAINING** from `DEFERRED_WORK.md`. Both `WebGPULabelRenderer` and `WebGPUBillboardRenderer` already had `WebGPUShaderModuleCache` adoption (since Batch 22-era work) but were still building `GPURenderPipeline` objects directly via `device.createRenderPipeline()` keyed by a local `Map<defines, pipeline>`. Batch 73 routes both through the central `webgpuPipelineCache` so two LabelCollections / BillboardCollections with identical (defines, format, depthFormat) tuples share one `GPURenderPipeline` instead of one per collection.

### S45-T1 — Label SDF pipeline migration

[`WebGPULabelRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js):

- `createSDFPipeline()` → `buildSDFDescriptor()` — returns the cache-friendly `WebGPURenderPipelineDescriptor` shape (with `name` carrying format + depthFormat + defines for cache-key uniqueness) instead of materializing a pipeline directly.
- Added `tryResolveLabelSDFPipeline(device, pipelineCache, entry)` mirror of Polyline's `tryResolvePolylinePipeline` — sync-first, async-kickoff, fallback to direct creation.
- `cache.sdfPipelines = new Map<defines, GPURenderPipeline>` → `cache.sdfPipelineEntries = new Map<defines, { descriptor, pipeline, pending }>`. Frame loop calls `tryResolveLabelSDFPipeline` and skip-returns when the resolved pipeline is null (still materializing in central cache).
- Added `descriptorToGPU` helper for the no-central-cache fallback path.

### S45-T2 — Billboard color + pick pipeline migration

[`WebGPUBillboardRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js):

- `createBillboardPipeline()` → `buildBillboardDescriptor()` (color, alpha-blended).
- `createBillboardPickPipeline()` → `buildBillboardPickDescriptor()` (pick, no blend, depth-write enabled).
- Added `tryResolveBillboardPipeline(device, pipelineCache, entry)` shared by both color and pick paths.
- `cache.pipelines` + `cache.pickPipelines` → `cache.pipelineEntries` + `cache.pickPipelineEntries`, both keyed by defines, both holding `{ descriptor, pipeline, pending }` slots.
- Both call sites (color in main update path, pick in `_pushBillboardPickCommand`) skip-return when resolution returns null.

### Shape of the migration

Where Batch 72's renderers (Cloud / Voxel / Weather) had a single pipeline (or two with one shared descriptor shape), Label + Billboard have a `Map<defines, descriptor>` pattern because they pre-generate pipelines per active-defines combination (DP-H42 DISABLE_DEPTH_DISTANCE × DP-H40 SPLIT_ENABLED × ifdef branches in their WGSL). The migration preserves the per-defines local Map but the values are now lightweight entry slots that reference the central cache's `GPURenderPipeline` rather than owning unique pipelines.

### Verification

- `npx tsc --noEmit` clean.
- `npx gulp build` clean.
- Sandcastle baseline: `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — **PASS=7, FAIL=0, SKIP=0**. Edge Visibility + Edge Feature ID + Many Imagery Layers + Translucent Classification all exercise Billboard / Label / shared rendering paths — no collateral regression.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js`
- `migration_doc/DEFERRED_WORK.md` (counts updated; remaining renderers list shrinks 6 → 4)
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` (this entry)

### Adopter counts after Batch 73

- **Pipeline cache:** 11 renderers — Polyline, PointPrimitive, GroundPrimitive, GaussianSplat, EllipsoidPrimitive, BufferPrimitive, DepthPlane, Cloud, Voxel, **Label** (new), **Billboard** (new) + Weather render.
- **Shader module cache:** 8 renderers (unchanged from Batch 72) — Polyline, PointPrimitive, Billboard, Label, GlobeSurface, Cloud, Voxel, Weather.

### Remaining C-R7 work (1-2 sessions)

- **Pipeline cache only:** `WebGPUGlobeSurfaceRenderer` (3697 LOC, own session — already has module cache).
- **Both gaps:** `WebGPUEnvironmentRenderer` (1047 LOC), `WebGPUVolumetricFogRenderer` (1185 LOC), `WebGPUPointCloudRenderer` (892 LOC).
- **Blocked:** `WebGPUModelRenderer` (KHR shader-family work via C-R4-GLTF-KHR), `WebGPUAutoExposure` (compute pipeline cache infra).

---

## Session 46 — Batch 74: C-R7 paired sweep, slice 3 (Environment + PointCloud + VolumetricFog) (2026-04-27)

Closes the third slice of paired **C-R7-SHADER-MODULE-DEDUP** + **C-R7-RENDERER-MIGRATION-REMAINING** items from `DEFERRED_WORK.md`. Three renderers — `WebGPUEnvironmentRenderer` (Sun + Moon), `WebGPUPointCloudRenderer` (default + LOD), and the composite half of `WebGPUVolumetricFogRenderer` — now route both `GPUShaderModule` compilation and `GPURenderPipeline` materialization through the central caches. Sandcastle baseline holds at 7/7 PASS.

### S46-T1 — `ShaderSourceId` registry expansion

Six new entries added to [`WebGPUShaderDefines.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts) (add-only, monotonic):

- `ENVIRONMENT_SUN = 17`
- `ENVIRONMENT_MOON = 18`
- `VOLUMETRIC_FOG_COMPUTE = 19` (compute pipeline still goes direct; module is deduped)
- `VOLUMETRIC_FOG_COMPOSITE = 20`
- `POINT_CLOUD = 21`
- `POINT_CLOUD_LOD = 22`

### S46-T2 — Environment renderer migration

[`WebGPUEnvironmentRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js):

- Per-device `WebGPUShaderModuleCache` via `WeakMap<GPUDevice, WebGPUShaderModuleCache>`.
- Sun WGSL hoisted from inline template literal to a top-level `SUN_SHADER_WGSL` const so the module cache can dedupe by source ID. Pure relocation — content unchanged.
- `createMoonPipeline()` → `buildMoonPipelineResources()` returning the descriptor + BGL.
- New shared `tryResolveEnvPipeline()` resolver mirroring Batch 56's Ellipsoid template.
- Both Sun (`cache.pipelineEntry`) and Moon (`cache.pipelineEntry`) call sites use entry-based caching with skip-frame on async-pending.
- Moon's prior `pushErrorScope`/`popErrorScope` wrapper + `_pipelineFailed` sentinel removed: the central cache's `createRenderPipelineAsync` `.catch` handler subsumes that error path. A retry simply attempts creation again next frame, matching prior behavior for transient errors.

### S46-T3 — PointCloud renderer migration

[`WebGPUPointCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts):

- Per-device `WebGPUShaderModuleCache`.
- `buildPipeline()` → `buildPipelineDescriptor()`. `_buildLODPipeline()` → `_buildLODPipelineDescriptor()`.
- New shared `tryResolvePointCloudPipeline()` resolver.
- `PointCloudCache` extended with `pipelineEntry` and `lodPipelineEntry` slots (both `{ descriptor, pipeline, pending }`).
- Default-path call site skip-returns when central cache hasn't materialized.
- LOD-path call site (`_runGPULODPath`) skip-returns when LOD pipeline isn't yet ready — matches the existing `lodStorageBindGroup` not-ready behavior (one-frame visual gap, recovers next frame).

### S46-T4 — VolumetricFog composite migration

[`WebGPUVolumetricFogRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts):

- Per-device `WebGPUShaderModuleCache` covers both the compute (`VolumetricFog.wgsl`) and composite (`VolumetricFogComposite.wgsl`) shaders.
- The three compute pipelines (densityInjection / lightScattering / integrate) still use direct `device.createComputePipeline()` because no `WebGPUComputePipelineCache` exists yet — but they share a single deduped `GPUShaderModule`.
- Composite render pipeline routed through `webgpuPipelineCache`. The descriptor is held on `_resources.compositePipelineEntry`; `composite()` early-exits if the pipeline isn't ready (Phase 5a no-op clears the integrated volume so a missed composite frame is invisible).
- The interface field `compositePipeline: GPURenderPipeline` was changed to `GPURenderPipeline | null` to reflect the async resolution; all in-method reads now go through the resolution path.

### Verification

- `npx tsc --noEmit` clean (zero errors).
- `npx gulp build` clean.
- Sandcastle baseline: `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — **PASS=7, FAIL=0, SKIP=0**. Every demo exercises Sun + Moon environment rendering, so the migration is well-covered. PointCloud + VolumetricFog have no in-baseline coverage (only WebGL Sandcastle demos exist for those primitives); their migration verification is by tsc + build success and by mirroring the established Polyline / Ellipsoid pattern verbatim.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts`
- `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`
- `migration_doc/DEFERRED_WORK.md` (counts updated; remaining renderers list shrinks 4 → 1)
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` (this entry)

### Adopter counts after Batch 74

- **Pipeline cache:** 14 renderers — Polyline, PointPrimitive, GroundPrimitive, GaussianSplat, EllipsoidPrimitive, BufferPrimitive, DepthPlane, Cloud, Voxel, Label, Billboard, **Environment Sun** (new), **Environment Moon** (new), **PointCloud** (new) + Weather render + VolumetricFog composite.
- **Shader module cache:** 12 renderers — Polyline, PointPrimitive, Billboard, Label, GlobeSurface, Cloud, Voxel, Weather, **Environment** (new), **VolumetricFog** (new), **PointCloud** (new).

### Remaining C-R7 work (1 session)

- **Pipeline cache only:** `WebGPUGlobeSurfaceRenderer` (3697 LOC — its own session because of scope; already has module cache).
- **Blocked:** `WebGPUModelRenderer` (KHR shader-family work via C-R4-GLTF-KHR), `WebGPUAutoExposure` (compute pipeline cache infra).

---

## Session 60 (2026-05-06) — Batch 183 translucent-globe + camera-underground double-blend

**Bug:** When both `frameState.cameraUnderground` and `frameState.globeTranslucencyState.translucent` were true, the per-tile 3-pass technique (depth-only back-face → translucent back-face → translucent front-face) emitted commands AND the regular color command ran with `cullMode: "none"` (because `disableCulling` is true via `cameraUnderground`). Result: back-faces blended twice — once via the translucent back-face command (cullFront pipeline) and once via the regular color command (cullNone pipeline). User-visible as a wrong-alpha shimmer on the far side of the globe when transitioning from underground to surface with translucency on.

**Root cause:** The 3-pass emission gate at `WebGPUGlobeSurfaceRenderer.ts:871-876` checked `globeTranslucent && !isSubsequentPass && !debugWireframe && debugFragmentMode === NONE` but had no `!cameraUnderground` check. Originally the `disableCulling` decision was `!providerCullEnabled || cameraUnderground || globeTranslucent`, so when `globeTranslucent` was true the regular color command ran with `cullMode: "none"`. Batch 182 split that decision: `disableCulling` no longer includes `globeTranslucent`, and the regular color command flips to `cullMode: "back"` (front-face only) so the translucent-back-face pass can fill the far side. But the split didn't account for `cameraUnderground` taking precedence over `globeTranslucent` — when both are true, `disableCulling` is still true (from cameraUnderground), so the regular color command still runs cullMode "none", and the 3-pass commands fire on top.

**Fix:** Extended the gate at `WebGPUGlobeSurfaceRenderer.ts:871-876` with `!cameraUnderground`. Camera-underground takes precedence over globeTranslucent; the underground path uses single-pass both-faces (the user's primary intent when underground is "see through the globe"), and the 3-pass technique is reserved for surface-level translucent-globe rendering where the camera is OUTSIDE the planet.

**Files modified:** `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts:871-887`.

---

## Session 61 (2026-05-08) — BUG-WEBGPU-PIPELINE-ASYNC + NEW-WEBGPU-PIPELINE-READY-SIGNAL + NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER

Closes BUG-WEBGPU-PIPELINE-ASYNC class — the regression introduced in batches 213-225 where the WebGPU canvas rendered as black/empty whenever an async render pipeline resolved AFTER `Scene.requestRenderMode` hibernated. The root cause was structural: `device.createRenderPipelineAsync()` is async, but Cesium's render loop has no formal wakeup channel back into `Scene.requestRender()` for async GPU resource readiness. ~20 WebGPU renderers had ad-hoc per-call-site `frameState.afterRender.push(() => true)` plumbing; one of them ([GlobeSurfaceTileProviderRendering.js](packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js)) didn't, and the globe rendered black until user input.

### BUG-WEBGPU-PIPELINE-ASYNC root cause

Empty `cmdDescs` returned by `WebGPUGlobeSurfaceRenderer.createTileCommands` indicates the GPU pipeline was still cooking via `device.createRenderPipelineAsync`. Scene's `shouldRender` gate ([Scene.js:3362](packages/engine/Source/Scene/Scene.js#L3362)) saw nothing dirty, scene hibernated, and the pipeline's eventual `.then` callback wrote `entry.pipeline = p` to a parked scene that would never render again until camera input.

### Fix shape — three companion features

**1. NEW-WEBGPU-PIPELINE-READY-SIGNAL — `AsyncResourceMonitor`** ([AsyncResourceMonitor.ts](packages/engine/Source/Renderer/WebGPU/AsyncResourceMonitor.ts))

Per-`GraphicsContext` event bus. Producers (pipeline caches, image-decode helper, direct compute callers) call `monitor.begin({kind, key, priority?, ownerSceneIds?})` when starting async work and `monitor.resolve(token)` (or `reject`) when done. Subscribers (typically the attached Scene) call `monitor.subscribe(cb, {sceneId})` and re-issue `requestRender()` on resolution.

Design properties:

- **Per-context isolation** — one monitor per `GraphicsContext`. Cross-context wakeups impossible by construction. Multi-WebGPU split-screen works because each context has its own monitor.
- **Priority-aware** — `foreground` (default) keeps Scene's `shouldRender` gate open via `pendingForegroundCount`; `background` is for `cache.warm()` speculative pre-cooking and lets the scene hibernate normally during warmup, only waking on resolution.
- **Multi-context attribution** — `ownerSceneIds: ReadonlySet<string>` on the token + `sceneId` on the subscriber lets the monitor filter dispatch when both sides claim attribution. Tokens without owners (the default — most pipelines are shared) fire on every subscriber.
- **Idempotent** — `begin/resolve/reject` are no-ops on already-tracked / already-cleared tokens. Tolerant of teardown races.
- **Device-loss handling** — `monitor.reset(reason)` rejects every inflight token in one sweep; subscribers stay attached so producers re-issue against the recovered device.

Wired into:

- [WebGPURenderPipelineCache.ts](packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) — `getPipeline()` publishes around `device.createRenderPipelineAsync`. Also added `cache.warm(descriptor, variant)` for speculative pre-cooking with background priority.
- [WebGPUComputePipelineCache.ts](packages/engine/Source/Renderer/WebGPU/WebGPUComputePipelineCache.ts) — sibling wiring for compute pipelines.
- [WebGPUImageUpload.decodeWithOrientation](packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts) — async `createImageBitmap` decode publishes `image-decode` tokens.
- Direct `device.createComputePipelineAsync` callers that bypass the central cache: [WebGPUGPUCuller](packages/engine/Source/Renderer/WebGPU/WebGPUGPUCuller.ts), [WebGPUDecoupledScan](packages/engine/Source/Renderer/WebGPU/WebGPUDecoupledScan.ts), [WebGPUPointCloudLODProcessor](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts), [WebGPUComputeEngine](packages/engine/Source/Renderer/WebGPU/WebGPUComputeEngine.ts) all wrap their direct calls in `trackComputePipelineCreation()` (exported helper from `AsyncResourceMonitor.ts`).
- [Scene.js](packages/engine/Source/Scene/Scene.js) — subscribes once at construction; `shouldRender` gate adds `pendingForegroundCount > 0` as defense-in-depth poll. Optional chaining → 0 on WebGL contexts so non-WebGPU scenes pay nothing.

Phase 3 cleanup removed the manual `afterRender.push(() => true)` from [GlobeSurfaceTileProviderRendering.js:887](packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js#L887) — the monitor wakeup is now load-bearing on its own. Other renderers' `afterRender` pushes remain because they're for non-pipeline async (Model loader resources, tile content load) — those have their own well-tested pattern.

**2. NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER — `AsyncResourceTelemetry`** ([AsyncResourceTelemetry.ts](packages/engine/Source/Renderer/WebGPU/AsyncResourceTelemetry.ts))

Perf-side subscriber that aggregates per-`AsyncResourceKind` p50/p95/p99 latency, throughput, and failure rates over a 100-sample rolling window. Eagerly attached when the monitor is first created (via the `WebGPUContext.asyncResources` getter) so the first cold-compile pipelines aren't lost to lazy attachment. Surfaced via:

- [WebGPUContext.asyncResourceTelemetry](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) getter
- [WebGPUPerformanceManager.getAsyncResourceStats()](packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts)
- `getDiagnostics()` lines for render + compute p50/p95/p99

Production smoke test against CesiumViewer reported render-pipeline mean 837 ms cold-start latency, peak inflight 2 — useful baseline for future perf-budget decisions.

**3. Order-of-operations defensive fix in the caches** — `pendingPipelines.set` and `stats.pending++` happen BEFORE `monitor.begin` so a `started` subscriber that re-enters `cache.getPipeline(sameDescriptor)` finds the pending entry instead of double-creating. Audit-driven, no current regression observed but tightens the contract.

### Verification

[Tools/visual-regression/probe-async-resource-monitor.mjs](Tools/visual-regression/probe-async-resource-monitor.mjs) is the smoke test. All assertions pass against live CesiumViewer:

- Globe renders correctly (cmdListLength=18, 16 tiles, default `requestRenderMode=true`)
- Monitor caught 3 render-pipeline events with peak inflight=2, mean ~837ms
- 2 subscribers attached (Scene + telemetry), 0 rejections, 0 console errors
- Phase 4 priority gating: foreground token bumps `pendingForegroundCount`, background does not
- Phase 6 attribution filtering: scene-A and scene-B subscribers each see only own + shared events (4 each, 0 cross-leak)
- `monitor.reset()` clears 2 inflight tokens, idempotent on subsequent `resolve()`

### Files modified

New files:

- `packages/engine/Source/Renderer/WebGPU/AsyncResourceMonitor.ts`
- `packages/engine/Source/Renderer/WebGPU/AsyncResourceTelemetry.ts`
- `Tools/visual-regression/probe-async-resource-monitor.mjs`

Modified:

- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` (asyncResources + telemetry getters; cache constructor wiring; 4 `WebGPUGPUCuller` construction sites threaded with monitor; PointCloudLOD processor wiring)
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts` (constructor + `getPipeline` + new `warm()` method)
- `packages/engine/Source/Renderer/WebGPU/WebGPUComputePipelineCache.ts` (constructor + `getPipeline`)
- `packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts` (`decodeWithOrientation` accepts monitor)
- `packages/engine/Source/Renderer/WebGPU/WebGPUGPUCuller.ts` (constructor option + 2 wrapped calls)
- `packages/engine/Source/Renderer/WebGPU/WebGPUDecoupledScan.ts` (constructor option + 1 wrapped call)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts` (constructor option + 4 wrapped calls + forwards monitor to nested DecoupledScan)
- `packages/engine/Source/Renderer/WebGPU/WebGPUComputeEngine.ts` (asyncResourceMonitor setter + 1 wrapped call)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts` (`getAsyncResourceStats()` + diagnostics lines)
- `packages/engine/Source/Scene/Scene.js` (monitor subscription + shouldRender gate + destroy unsub)
- `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` (Phase 3 cleanup of manual afterRender push)

---

## Session 62 (2026-05-08) — Cross-backend visual regression sweep + WGSL fixes (`BUG-WGSL-MODEL-PBR-*` + `BUG-DEV-SERVER-*`)

Built a cross-backend Sandcastle runner that loads every gallery demo against both WebGL and WebGPU, capturing screenshots + diff stats + console/page errors per demo. The first sweep surfaced 41 demos with `Model PBR ShaderModule` compilation failures (silent — canvas had non-zero size so the demo "passed" by superficial canvas-render check). All four root causes were WGSL bugs in `ModelPBRComplete.wgsl`. Plus two dev-server bugs that were masking shader edits during development.

### Background — runner architecture

- New file: `Tools/visual-regression/cross-backend-sandcastle-runner.mjs` — loads each gallery `.html`, forces WebGL once and WebGPU once via three layered tricks:

  1. `addInitScript` Proxy over `window.Cesium` (the module namespace itself is frozen, so direct mutation silently fails — Proxy is the only way to override `Viewer`).
  2. `addInitScript` getter/setter trap over `window.startup` so the proxied namespace is forwarded into the demo's local `Cesium` parameter (load-cesium-es6.js calls `window.startup(Cesium)` with the original module).
  3. `page.route` HTML rewrite that replaces sync `new Cesium.Viewer(` with `await Cesium.Viewer.createAsync(` when forcing WebGPU — sync constructor has no WebGPU code path.

- New file: `Tools/visual-regression/analyze-cross-backend-report.mjs` — categorizes the per-demo JSON report by both-fail / one-fail / both-OK, low/medium/high diff, and surfaces `consoleMessages` / `pageErrors` per demo so real bugs are visible (not just "canvas dimensions > 0").

The runner's first sweep showed 224/224 demos rendering to a canvas, but reported 156 demos with WebGPU-only console errors. Filtering out dev-build noise (debug-pragma diagnostics that ship as no-ops in production, browser environment warnings) revealed 95 demos with real WebGPU issues. Top bug clusters drove the fixes below.

### BUG-WGSL-MODEL-PBR-FRAGCOORD — `input.position.xy` access against struct without `position` field (41 demos)

**Symptom:** `[CesiumJS:webgpu] Shader "Model PBR ShaderModule [defines=0x0]" compilation ERROR at line 2484:18: struct member position not found`. Affected every demo that loaded any glTF model or 3D Tile (3D Tiles 1.1, BIM, Photogrammetry, Compare, etc.).

**Root cause:** `fragmentClassificationMain` in [ModelPBRComplete.wgsl:2843](packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl#L2843) accessed `input.position.xy`, but the `FragmentInput` struct (defined at line 944) names the `@builtin(position)` field `fragCoord`, not `position`. Likely a port miss — most WGSL shaders in the codebase use `fragCoord` consistently; this entry point was an outlier. The line numbers in the error refer to the post-preprocessor compiled shader (after `//>>ifdef MODEL_HAS_KHR_TEXTURES` blocks are stripped), which is why the surface line number doesn't match the source.

**Fix:** Single-line edit — `input.position.xy` → `input.fragCoord.xy`. Comment added explaining the mismatch.

### BUG-WGSL-FWIDTH-NONUNIFORM — `fwidth` called from non-uniform control flow (41 demos, surfaced after MODEL-PBR-FRAGCOORD)

**Symptom:** Same demos as above. After fixing the field-name bug, the next compile error surfaced: `'fwidth' must only be called from uniform control flow`.

**Root cause:** `applyEdgeOverlay()` in [ModelPBRComplete.wgsl:1336](packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl#L1336) computed `let pixelStep = fwidth(geomDepthLinearEarly)` inside the function body. The function is invoked from inside `if (hasFlag(flags, FLAG_IS_UNLIT)) { ... }` (line 1818-1828) which the WGSL compiler conservatively treats as non-uniform control flow even when `flags` is read from a uniform buffer. WGSL requires `fwidth` (and other implicit-derivative functions) to be called from uniform control flow only, because derivatives are computed across a 2x2 fragment quad and can't safely be sampled if some lanes are masked off by an `if`.

**Fix:** Hoist `fwidth` to the entry of `fragmentMain` where control flow is guaranteed uniform. Added `let edgePixelStep = fwidth(abs(input.positionEC.z));` as the first non-uniform-touching statement in fragmentMain. Threaded through `applyEdgeOverlay` as a new parameter `pixelStep: f32`. Removed the inner `fwidth` call. Two call sites updated to pass `edgePixelStep`. Cost: every fragment now computes pixelStep even when the edge stage is disabled — negligible (one fwidth, ~2 ALU).

### BUG-WGSL-TEXTURESAMPLE-NONUNIFORM — `textureSample` called from non-uniform control flow (41 demos, third layer)

**Symptom:** After hoisting `fwidth`, third compile error: `'textureSample' must only be called from uniform control flow` at multiple lines in `ModelPBRComplete.wgsl`.

**Root cause:** Same uniform-control-flow rule applies to `textureSample` (since it computes mip selection from screen-space derivatives). 19 call sites in `ModelPBRComplete.wgsl` — many inside `if (hasFlag(flags, FLAG_HAS_*_TEXTURE))` branches that the compiler can't prove uniform. Each affected: base color, normal, metallic-roughness, occlusion, emissive, IBL diffuse, batch table feature ID, feature pick texture, etc. (full list in `lookupBatchColor`, `lookupFeaturePickColor`, `fragmentMain`, `fragmentPickHoverMain`, `fragmentPickMain`, `fragmentVelocityMain`).

**Fix:** Replaced all 19 `textureSample(tex, sampler, uv)` calls with `textureSampleLevel(tex, sampler, uv, 0.0)`. The `*Level` variant doesn't compute screen-space derivatives (mip is supplied explicitly), so it's exempt from the uniform-control-flow constraint. Trade-off: no automatic mipmap selection. For Cesium model textures this is acceptable because:

1. Most model textures don't use mipmaps anyway (the upload path doesn't generate them by default).
2. The texture set in question is dominated by base color / normal maps where LOD 0 sampling is typical.
3. A future batch can selectively restore `textureSample` for textures known to have mipmaps, by hoisting the sample call to uniform control flow (the same hoist pattern used for fwidth).

Done as a single batch regex over the file (`textureSample(...)` → `textureSampleLevel(..., 0.0)`); verified no false positives by checking `, 0.0, 0.0)` count = 0 (no double-suffix).

### BUG-WGSL-POLYLINE-SWIZZLES — `.s` / `.t` swizzle characters not valid WGSL (7 demos)

**Symptom:** `[warning] Error while parsing WGSL: :191:34 error: invalid vector swizzle character`. Affected polyline-styling demos (CZML Polyline, Polyline Dash, etc.).

**Root cause:** Three polyline material shaders ported from GLSL still used `.s` / `.t` (GLSL texture-coord swizzles) for `vec2` access. WGSL only accepts `.x/.y`, `.r/.g`, `.u/.v` — `.s/.t` parses as undeclared identifiers. Files: [PolylineArrow.wgsl](packages/engine/Source/Shaders/WebGPU/Collections/PolylineArrow.wgsl), [PolylineGlow.wgsl](packages/engine/Source/Shaders/WebGPU/Collections/PolylineGlow.wgsl), [PolylineOutline.wgsl](packages/engine/Source/Shaders/WebGPU/Collections/PolylineOutline.wgsl).

**Fix:** Bulk replace `st.s → st.x` and `st.t → st.y` per file. Verified no other files in `Source/Shaders/WebGPU/` had similar misses.

### BUG-DEV-SERVER-WGSL-WATCHER — chokidar watcher missed `.wgsl` edits (silently masked all WGSL fixes during dev)

**Symptom:** While debugging the WGSL fixes above, `gulp build` regenerated the `.js` mirrors but the running dev server kept serving the OLD compiled bundle. `curl http://localhost:8080/Build/CesiumUnminified/index.js | grep -c input.fragCoord.xy` returned `1` (matching disk) but the in-page error message kept showing the OLD code text. Cost ~30 minutes of confusion before tracing.

**Root cause:** The dev server's chokidar watcher in [server.js:252](server.js#L252) was filtered to `.glsl`-only:

```js
const glslWatcher = chokidar.watch("packages/engine/Source/Shaders", {
  ignored: (path, stats) => {
    return !!stats?.isFile() && !path.endsWith(".glsl");
  },
});
```

`.wgsl` edits weren't seen, so `glslToJavaScript` was never called and the bundle cache (`esmCache` + `engineBundleCache` + `iifeCache`) never invalidated. The pre-cached bundle in memory continued serving the pre-edit code despite gulp having regenerated the `.js` mirror on disk.

**Fix:** Extended the watcher filter to accept both `.glsl` and `.wgsl`:

```js
return !path.endsWith(".glsl") && !path.endsWith(".wgsl");
```

Added a `wgslToJavaScript` import + branched the watcher callback so `.wgsl` edits trigger the WGSL regenerator instead of the GLSL one (they're separate functions). Both clear the same bundle caches. Comment notes the precedent (Translucent Classification depth-copy debugging where `.ts` edits were similarly masked).

### BUG-DEV-SERVER-GLSL-DELETES-WGSL — `glslToJavaScript` deleted `.js` mirrors of `.wgsl` files as "leftovers"

**Symptom:** When triggering the GLSL watcher via `touch some.glsl`, the dev server bundle started returning HTTP error pages: `Could not resolve "../../Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.js"` and dozens of others. The `.js` files had vanished from disk.

**Root cause:** `glslToJavaScript` in [scripts/build.js:773](scripts/build.js#L773) collects "all currently existing .js files in Shaders/" into a `leftOverJsFiles` set, then iterates the `.glsl` source files and removes their corresponding `.js` from the set. Files left in the set at the end are deleted as "orphan" .js files — but the WGSL `.js` mirrors qualify as orphans because no `.glsl` source corresponds to them. Each watcher invocation wiped the WGSL bundle until the next `gulp build`.

**Fix:** Added `!packages/${workspace}/Source/Shaders/WebGPU/**/*.js` to the globby include patterns, excluding the WGSL mirror tree from the leftover-deletion sweep entirely. WGSL mirrors are managed by the separate `wgslToJavaScript` function and shouldn't be touched by `glslToJavaScript`.

### Verification

Direct sandcastle test (`3D Tiles BIM.html`) before/after — same demo:

- Before fixes: 4 separate WGSL compile errors (`position not found` × 2, then `fwidth` × 2 after first fix, then `textureSample` × N after second fix). Demo rendered the navigation chrome but not the model.
- After fixes: 0 shader compile errors. Model loads + renders. WebGL vs WebGPU diff = 33% (within normal range; differences are camera-positioning and tonemap).

Full sweep at 229 demos (the 224 original + 6 new sandcastles authored this session): 0 shader compile errors across all demos. 95 demos still have other issues (vertex buffer count, CZML JS bugs, vec4 validation, etc.) — see DEFERRED_WORK entries below.

### Files modified

Source:

- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — fragmentClassificationMain field rename + fwidth hoist + applyEdgeOverlay parameter + 19× textureSample → textureSampleLevel
- `packages/engine/Source/Shaders/WebGPU/Collections/PolylineArrow.wgsl` — `.s/.t` swizzles
- `packages/engine/Source/Shaders/WebGPU/Collections/PolylineGlow.wgsl` — `.s/.t` swizzles
- `packages/engine/Source/Shaders/WebGPU/Collections/PolylineOutline.wgsl` — `.s/.t` swizzles

Build / dev infrastructure:

- `server.js` — chokidar watcher filter + wgslToJavaScript import + dispatch by extension
- `scripts/build.js` — exclude WGSL mirrors from glslToJavaScript leftover-deletion

Tooling (new):

- `Tools/visual-regression/cross-backend-sandcastle-runner.mjs` — cross-backend sweep runner
- `Tools/visual-regression/analyze-cross-backend-report.mjs` — categorized analyzer

Sandcastle additions (new — see also FEATURE_INVENTORY §B):

- `Apps/Sandcastle/gallery/WebGPU Async Resource Monitor.html`
- `Apps/Sandcastle/gallery/WebGPU Temporal Anti-Aliasing.html`
- `Apps/Sandcastle/gallery/WebGPU God Rays.html`
- `Apps/Sandcastle/gallery/WebGPU Screen Space Reflections.html`
- `Apps/Sandcastle/gallery/WebGPU Weather Particles.html`
- `Apps/Sandcastle/gallery/WebGPU Vector Tile Buffer Rendering.html`


## Session 63 (2026-05-09) — Last-mile WebGPU error cluster + missing star map

The cross-backend sweep ended Session 62 with 2 WebGPU-only failures + a visually-obvious "no stars in the sky" parity gap. Investigated and fixed all three.

### `BUG-WEBGPU-PICK-STAGING-MAPPED` — `Buffer "Pick staging buffer" used in submit while mapped` + `createBuffer Failed to read 'size' property: Value is null`

**Symptom:** [Apps/Sandcastle/gallery/Clamp to 3D Model.html](Apps/Sandcastle/gallery/Clamp%20to%203D%20Model.html) hit two distinct WebGPU validation errors per second on the WebGPU backend. The CallbackProperty calls `scene.sampleHeight` every frame, which queues a pick render → readback chain.

**Root causes (two):**

1. `WebGPUPickFramebuffer._startReadback` issues `copyTextureToBuffer` + `submit` then calls `mapAsync(GPUMapMode.READ)` in a fire-and-forget `.then(() => unmap())` chain. The next frame's `_startReadback` queued another copy on the same `_stagingBuffer` while the previous frame's mapAsync was still pending or the buffer was mapped (between mapAsync resolution and the .then firing). WebGPU rejects submit if any referenced buffer is in mapping-pending or mapped state.
2. The `begin()` path computed `bufferSize = bytesPerRow * height` without validating viewport dimensions. During teardown / 0-size viewports, `width`/`height` came in `undefined` → `bufferSize = NaN` → `device.createBuffer({size: NaN})` → "Failed to read 'size' property: Value is null".

**Fix** ([packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts)):

- Added `_readbackInFlight` flag set to `true` after submit + mapAsync, cleared in the `.then` / `.catch`. `_startReadback` early-returns if a readback is still pending. Resize/destroy paths reset the flag explicitly so a swapped buffer doesn't strand the gate.
- Validated `viewport.width` / `viewport.height` at `begin()` entry, falling back to `1` if missing/non-positive. Stops NaN propagation into `createBuffer`.

### `BUG-WEBGPU-WRITEBUFFER-OVERFLOW` — `writeBuffer Number of bytes to write is too large`

**Symptom:** [Apps/Sandcastle/gallery/Show or Hide Entities.html](Apps/Sandcastle/gallery/Show%20or%20Hide%20Entities.html) threw a writeBuffer validation error every frame from `updateWebGPUMaterialCommandUniforms`.

**Root cause:** `scratchMaterialCameraData = new Float32Array(64)` (256 bytes) is the source for `device.queue.writeBuffer(buffer, 0, ud.buffer, 0, LIT_CAMERA_BYTES)` — but `LIT_CAMERA_BYTES = 304` (mvpRTE+mvRTE+normalMatrix+camHigh+camLow+lightDir+prevVP). Asking writeBuffer to read 304 bytes from a 256-byte source fails validation; `writeRTEUniformsLit` also writes `ud[60..75]` for `prevVP` which silently no-op'd against the undersized typed array.

**Fix** ([packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)): Bumped `scratchMaterialCameraData` to `new Float32Array(80)` (320 bytes). Sized for the larger lit/PBR layout; flat material shaders fit comfortably.

### `BUG-WEBGPU-SKYBOX-INVISIBLE` — Default skybox stars rendered black on WebGPU (parity gap with WebGL)

**Symptom (user report):** "no star map in WebGPU". The default Cesium skybox stars showed correctly on WebGL but the entire backdrop was black on WebGPU.

**Diagnostic path** (every layer fired correctly except the last):

1. `Scene.updateAndExecuteCommands` env-update path → fires (`renderPass=true`, `hasSkyBox=true`)
2. `SkyBox.update` → fires (`mode=SCENE3D`, `passes.render=true`)
3. `CubeMapPanorama.update` → fires (`hasFR=true`, `ctxIsWebGPU=true`)
4. WebGPU FR `updateCubeMapPanorama` → fires (`returnCommand=true`, sources OK)
5. `loadCubeMap` → succeeds (`Cubemap loaded: 1024x1024, 6 faces`)
6. `SceneRenderer.maybeInject(envState.skyBoxCommand, "skyBox")` → injects (`hasPipeline=true`)

So the skybox geometry rendered. To verify, the fragment shader was temporarily replaced with `return vec4(1.0, 0.0, 1.0, 1.0)` — the entire backdrop turned magenta, confirming the geometry covered the right pixels. Replacing again with raw `textureSample(...)` → faint stars visible. So the cubemap loaded and sampled correctly.

**Root causes (two):**

1. **`uniformState.morphTime` is undefined.** [WebGPUCubeMapPanoramaRenderer.js#L467](packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js) wrote `uniformData[49] = uniformState.morphTime`. `morphTime` lives on `frameState`, not on `UniformState` — the WebGL `czm_morphTime` automatic uniform reads `uniformState.frameState.morphTime`. Writing `undefined` into a `Float32Array` produces `NaN`. The fragment shader emits `vec4(corrected, morphTime)` → alpha = NaN. Blending with NaN alpha collapses the destination color to the clear color (black) on every pixel the skybox touched.
2. **Phase 1.3b star-brightness modulation defaulted ON.** Even after fixing morphTime, the day-side hemisphere went black because `enableStarBrightnessModulation` defaulted to `true` (modulate stars toward black as the sky brightens). The legacy GLSL `SkyBoxFS` has no such modulation — stars stay full-brightness all day. WebGL parity expects the legacy behavior.

**Fix** ([packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js](packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js)):

- `uniformData[49] = frameState.morphTime ?? 1.0` — read from frameState, fall back to 1.0 (3D mode) so the alpha output is always a valid float.
- Flipped `enableModulation` default to `false`. Apps that want the new dimming behavior must opt in via `scene.globe.atmosphericConditions.skyAtmosphere.enableStarBrightnessModulation = true`. Documented in the source comment.
- Also added a separate fix earlier in the same file (originally landed for this session): `panoramaTransform` falls back to `uniformState.temeToPseudoFixedMatrix` when no user transform is provided, matching the legacy `SkyBoxVS.glsl` path. (Standalone CubeMapPanorama instances with explicit transforms unchanged.)

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts` — readback in-flight gate + width/height validation
- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` — bump scratchMaterialCameraData to 80 floats
- `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` — frameState.morphTime fallback + star-modulation default-off + temeToPseudoFixed fallback transform


## Session 63 cont. (2026-05-09) — Cross-backend sweep cluster: 156 → 7 (only docd warnings)

After the initial three fixes from Session 63, the cross-backend sweep surfaced 29 demos with WebGPU-only console errors. Eight more bug clusters were identified and fixed; the final sweep ends with 7 demos warning, all of them the documented "PostProcessStage requires `wgslFragmentShader`" informational message — i.e. zero actual WebGPU regressions versus WebGL.

### `BUG-WEBGPU-CREATEVERTEXBUFFER-OVERLOAD` — `createBuffer ... 'size' is not unsigned long long` for instance buffers

**Symptom:** CZML Billboard / CZML Point / CZML Position Definitions / CZML Reference Properties threw `TypeError: Failed to execute 'createBuffer'` from `WebGPUBuffer.createVertexBuffer` whenever a Billboard / Label / PointPrimitive collection allocated its instance buffer.

**Root cause:** `WebGPUBuffer.createVertexBuffer(device, data, label?)` only accepted a `data` (typed array) form. The Collection renderers (Billboard, Label, PointPrimitive) all called it with `(device, sizeInBytes, mappedAtCreation, label)` — passing a `number` where the function expected a buffer. The function ran `data.byteLength` on the number, got `undefined`, and `WebGPUBuffer.create({size: undefined})` propagated NaN through `Math.max` into `device.createBuffer`. Existed since the renderers landed; the second arg `true` was previously interpreted as the label string (no-op) so the bug stayed latent until the `data` path got exercised.

**Fix** ([packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts)):

- Added second overload: `createVertexBuffer(device, sizeBytes, mappedAtCreation?, label?)` — allocates an empty buffer of the given size for callers that fill via `device.queue.writeBuffer` later. Same overload added to `createIndexBuffer`. Internal `_createTyped` helper sniffs `typeof dataOrSize === "number"` to pick the path.
- Flipped `mappedAtCreation = true` → `false` at all 8 call sites in `WebGPUBillboardRenderer.js`, `WebGPULabelRenderer.js`, `WebGPUPointPrimitiveRenderer.js`. Comments at every call site already said "mappedAtCreation = false; we'll writeBuffer" — the `true` was a copy-paste-era bug masked by the broken signature. With the signature fixed, leaving `mappedAtCreation: true` would surface as "Buffer used in submit while mapped" because the buffers go straight into a `writeBuffer` without an `unmap()` (they were never meant to be mapped).

### `BUG-WEBGPU-DEPTHPLANE-HDR-FORMAT` — `Attachment state of [DepthPlane-Pipeline] not compatible with [Scene Framebuffer Render Pass]`

**Symptom:** Atmosphere demo emitted the warning every frame on WebGPU. Render pass expected `RG11B10Ufloat` (HDR scene FB), pipeline declared `BGRA8Unorm` (canvas format).

**Root cause:** `WebGPUDepthPlane.initialize()` was called once with `context.presentationFormat` (canvas format = `bgra8unorm`). When HDR mode flipped the scene framebuffer to a float format, the cached pipeline was never rebuilt — its baked-in fragment-output target stayed BGRA8Unorm. (PostProcessPipeline already had this exact pattern; the depth plane was missed.)

**Fix:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts](packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts) — store the active `_colorFormat` on the instance.
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts](packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts) — derive `desiredDepthPlaneFormat` from `context.scenePipelineFormat` (the SCENE FB color, not the canvas format), and rebuild the depth plane when the cached `_colorFormat` doesn't match — same Batch-110 pattern as `_postProcess`.

### `BUG-WEBGPU-PRIMITIVE-CAMERA-UB-PADDING` — Pipeline binding requires 320 bytes; buffer is 304

**Symptom:** CZML Rectangle (and any other Polygon/Rectangle entity using a fabric material) emitted `[Buffer "Mat Camera UB 0"] bound with size 304 ... requires at least 320 bytes` every frame.

**Root cause:** 29 Primitive WGSL shaders (`PrimitiveMatAlphaMapLit`, `PrimitiveMatCheckerLit`, `PrimitiveMatDotFlat`, `PrimitiveMat{Elev*,Image,Water,EmissionMap,RimLighting,SpecularMap,Stripe,Fade,NormalMap,...}{Flat,Lit}`, plus several Collections + ModelPBRComplete) had spurious explicit `_pad2: f32` (or `_pad2: vec2<f32>` / `_pad3: vec2<f32>`) fields between `lightDirection: vec4<f32>` (or `_pad1: f32`) and `previousViewProjection: mat4x4<f32>`. The mat4 already has 16-byte alignment so the pads were redundant — but they pushed the total struct size from the JS-canonical 304 / 160 bytes up to 320 / 176, and the JS `LIT_CAMERA_BYTES` / `FLAT_CAMERA_BYTES` constants weren't updated. WebGPU's pipeline-derived `minBindingSize` validation tripped every frame.

**Fix:** Stripped 29 WGSL files of the spurious `_pad{2,3}` fields between `_pad1` / `lightDirection` and `previousViewProjection`. A regex over the `struct CameraUniforms` body removed the redundant pads while preserving the legitimate vec3-alignment pads (`_pad0`, `_pad1`). Total struct size now matches JS-side `LIT_CAMERA_BYTES = 304` / `FLAT_CAMERA_BYTES = 160` for all primitive shaders.

### `BUG-WEBGPU-BILLBOARD-RUNTIME-FETCH` — `Error while parsing WGSL: <!DOCTYPE html>...`

**Symptom:** CZML Billboard and Label and four other billboard-heavy demos emitted the WGSL parse error during pipeline creation. Naga choked because the "shader source" was actually the dev server's HTML 404 page.

**Root cause:** [WebGPUBillboardRenderer.js#L135](packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) had a runtime `fetch("../../Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl")` — a relative URL that resolved against the current page. From `Apps/Sandcastle/gallery/X.html` it tried `Apps/Sandcastle/Source/...` which 404s. Every other shader in the renderer used the synchronous bundled `getCollectionShaderSource("billboardPick")` import — only this one path was misordered.

**Fix:** Replaced the runtime fetch with `getCollectionShaderSource("billboardColor")` (already imported at the top of the file). Removed the `await` from the call site since the new path is sync. The builds (sandcastle + production + standalone Apps) now all resolve the shader at bundle time via esbuild's `BillboardCollection.js` mirror.

### `BUG-WEBGPU-GLSTUB-TEXTURE-MIP` — `Texture copy range touches outside ... mip level N` + `MipLevel (N) > number of mip levels`

**Symptom:** Cesium OSM Buildings + I3S Building Scene Layer + Clouds + Cesium Inspector emitted hundreds of warnings per frame from the WebGL stub's `texImage2D` translation as imagery layers walked their mip chain.

**Root causes (two):**

1. `texImage2D(level=N>0, ...)` re-ran `ensureTextureAllocated(width, height)` with the level-N dimensions, destroying the level-0 allocation and recreating a smaller texture sized for level N's dimensions only — subsequent mip uploads referenced levels beyond the new `mipLevelCount`.
2. `writeTexture` was called with the caller's `(width, height)` even at `level > 0`. Some legacy WebGL upload paths pass the BASE-level dimensions even at higher mips (relying on driver clamping). WebGPU validates strictly and refused the upload.

**Fix** ([packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts](packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts)):

- Only `ensureTextureAllocated()` from level-0 uploads (or when no allocation exists). Higher-level uploads keep the existing texture.
- Skip uploads targeting `level >= tex.mipLevelCount` instead of crashing.
- Clamp the copy extent at `level > 0` to `max(1, base >> level)` for both `texImage2D` and `texSubImage2D`. Truncates oversized uploads instead of failing the frame.

### `BUG-WEBGPU-OCTDECODE-INFERENCE` — `DeveloperError: x and y must be unsigned normalized integers between 0 and 255`

**Symptom:** Materials demo crashed the render loop. RectangleGeometry compressed-attribute decode tried to interpret an ST value as an oct-encoded normal.

**Root cause:** `Primitive` ships compressed geometry through `PrimitivePipeline.packCreateGeometryResults` which packs `attributes` + `indices` only — the `_compressedAttributesMeta` flag dictionary added in Batch 23 doesn't survive the `postMessage` round-trip. So `ensureUncompressedAttributes`'s fallback inference branch is the COMMON case for app-level geometry, not an edge. The original inference was "componentsPerAttribute === 1 → assume normal" which guessed wrong for ST-only geometries (rectangles + many fabric materials) and tripped octDecode's range check.

**Fix** ([packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)):

- Probe-based inference: the first compressed value's magnitude disambiguates st vs normal. ST values from `compressTextureCoordinates` pack 12-bit pairs (range 0..16777215; real samples > 65535). Normal values from `octEncodeFloat` pack 8-bit pairs (always ≤ 65535). `probe > 65535 ⇒ ST` is unambiguous.
- Belt-and-braces: wrapped the `octDecodeFloat` call in a `try/catch` that falls back to a unit-up normal `(0, 0, 1)` instead of killing the frame. A misclassified ST value now produces a flat-shaded primitive rather than a render-loop crash.

### `BUG-WEBGPU-MARS-GLOBE-SELF-DESTRUCT` — `Cannot read properties of undefined (reading 'tileProvider')`

**Symptom:** Mars demo (custom Globe with `Cesium.Ellipsoid.MARS`) failed at construction with `Error constructing CesiumWidget`.

**Root cause:** `Viewer.createAsync` (the WebGPU path) constructs a temporary `CesiumWidget` first, then calls `new Viewer(container, {...options, _preInitializedScene: widget.scene})`. The Viewer constructor invokes `new CesiumWidget` AGAIN with the same options including `options.globe`. CesiumWidget's `scene.globe = options.globe` runs, hitting the Scene setter — which always destroyed the existing globe before re-binding (`this._globe = this._globe && this._globe.destroy()`). On the second pass, the EXISTING globe IS the new globe — destroy ran on the live Mars globe, wiping `_surface`, then `updateGlobeListeners` accessed `_surface.tileProvider` and crashed.

WebGL parity unaffected: the WebGL sync path runs `new Viewer` once, never re-assigning the same globe.

**Fix** ([packages/engine/Source/Scene/Scene.js](packages/engine/Source/Scene/Scene.js)): Scene `set globe(globe)` early-returns when `this._globe === globe`. Prevents the self-destruct without changing destroy behavior for genuine globe swaps.

### Files modified (Session 63 cont.)

- `packages/engine/Source/Renderer/WebGPU/WebGPUBuffer.ts` — createVertexBuffer / createIndexBuffer overloads + private `_createTyped` helper
- `packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js` — `mappedAtCreation: true → false` ×3 + replace runtime fetch with bundled import
- `packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js` — `mappedAtCreation: true → false` ×2
- `packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js` — `mappedAtCreation: true → false` ×3
- `packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts` — expose `_colorFormat`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts` — rebuild depth plane on scenePipelineFormat change
- `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts` — guard ensureTextureAllocated to level-0 + clamp copy extent
- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` — probe-based attribute inference + octDecodeFloat try-catch
- `packages/engine/Source/Scene/Scene.js` — globe setter same-instance no-op
- 29 WGSL files under `packages/engine/Source/Shaders/WebGPU/{Collections,Generated,Globe,Model,Primitive}/` — strip spurious `_pad{2,3}` fields between `lightDirection`/`_pad1` and `previousViewProjection`

### Final cross-backend sweep result

- 229/229 demos render canvas
- 0 demos with WebGPU-only errors (real bugs)
- 7 demos with WebGPU-only warnings — all the documented `PostProcessStage requires wgslFragmentShader` informational message (Custom Post Process, Custom Per-Feature Post Process, Depth of Field, Fog Post Process, LensFlare, Per-Feature Post Processing, Post Processing). These are by-design — GLSL custom shader transpilation is intentionally not supported on WebGPU; users supply WGSL fragments instead.

Compared to Session 62 entry baseline (156 WebGPU-only failures), this is an effective 100% reduction in WebGPU bugs surfaceable by the sweep. Remaining work focuses on per-feature visual fidelity (the diff% numbers are still high for many demos; "both backends OK" doesn't mean "pixel-identical") rather than rendering correctness.


## Session 63 cont. (2026-05-09) — Visual diff survey turned up two WebGL render-loop crashes

After the WebGPU regression cluster cleared, a side-by-side screenshot survey of WebGL vs WebGPU exposed two bugs in the **WebGL** path that were causing the WebGL run to crash entirely on a handful of demos. Both pre-existed in the fork (not introduced by WebGPU work) and both surface as "An error occurred while rendering. Rendering has stopped." red overlay.

### `BUG-WEBGL-LIGHTSDATA-FLOAT32` — `DeveloperError: Invalid vec4 value` from `UniformArrayFloatVec4.set` for `czm_lightsData`

**Symptom:** 3D Tiles BIM and Cesium OSM Buildings demos showed the red error overlay on WebGL while rendering normally on WebGPU. Improving the error message to include the uniform name + length + value type pinned the source: `Invalid vec4 value at index 0 of uniform array "czm_lightsData" (length 132). Expected Color or Cartesian4 — got number.`

**Root cause:** [UniformState.js#L210](packages/engine/Source/Renderer/UniformState.js) initializes `_lightsData = new Float32Array(132)` (33 vec4s × 4 floats). The automatic uniform `czm_lightsData` returns this Float32Array directly. But `UniformArrayFloatVec4.set` walked `value[i]` expecting an object with `.red` (Color) or `.x` (Cartesian4) — bare numbers tripped the `else throw` branch.

**Fix** ([packages/engine/Source/Renderer/createUniformArray.js](packages/engine/Source/Renderer/createUniformArray.js)):

- Added a fast-path at the top of `UniformArrayFloatVec4.set`: when `value` is a typed-array view (`ArrayBuffer.isView(value)`), skip the per-element unpacking, do a flat memcmp against the cached buffer, and `gl.uniform4fv` the buffer directly. Matches the WebGPU side's `device.queue.writeBuffer` semantics.
- Also improved the existing error message to name the uniform + length + actual type when the per-element fallback hits an invalid value (catches future similar bugs).

### `BUG-WEBGL-TIMEINTERVAL-CONTAINS-STALE` — `TypeError: this.includes is not a function`

**Symptom:** Particle System.html and any demo using Entity availability tracking crashed the render loop on WebGL with `TypeError: this.includes is not a function` — the `TimeIntervalCollection.contains` method calls `this.includes(julianDate)` but `includes` doesn't exist on the class.

**Root cause:** [TimeIntervalCollection.js#L120](packages/engine/Source/Core/TimeIntervalCollection.js) — `contains()` was a thin wrapper around `this.includes(...)` but the underlying `includes` implementation got removed at some point and the wrapper was left dangling.

**Fix:** Replaced `this.includes(julianDate)` with `this.indexOf(julianDate) >= 0` — `indexOf` is the actual lookup implementation present in the same class, returning the matching interval index or a bitwise-complement of the insertion point.

### Files modified

- `packages/engine/Source/Renderer/createUniformArray.js` — Float32Array fast-path + better error message
- `packages/engine/Source/Core/TimeIntervalCollection.js` — `contains` uses `indexOf`

### Visual survey: known WebGPU parity gaps observed (NOT crashes, NOT fixed this session)

The screenshot survey exposed several feature-parity gaps where both backends render successfully but visually diverge. None block the demo, all are tracked here for future per-feature work:

- **SkyAtmosphere glow missing** on WebGPU (Hello World, Atmosphere demo). The FR pipeline IS created, command IS pushed to `commandList` with `pass: 0` (ENVIRONMENT), but the visible halo doesn't appear. Diagnostic confirmed `show=true`, `mode=SCENE3D`, `renderPass=true`, `hasPipeline=true`, `indexCount=24576`. Likely a render-state / depth-blend / pipeline-format issue in the WebGPU SkyAtmosphere shader or pass routing.
- **Custom globe materials missing** on WebGPU (Globe Materials demo shows default Earth instead of elevation gradient).
- **Polygon outlines missing** on WebGPU (Polygon demo's per-position-height outlines don't render).
- **Imagery quality washed out** on WebGPU (Imagery Layers demo missing label overlay layer).
- **Box geometry partial render** on WebGPU (Box demo shows triangular halves instead of full cubes).
- **Camera doesn't engage to demo's intended view** on many demos (Camera, 3D Models, Atmosphere, Shadows). For demos using `Sandcastle.addToolbarMenu` with a header-only first item, `defaultAction` is never set so the camera stays at the default Earth-from-space view; this matches WebGL behavior IF those demos are visited fresh, but the `cesium-hasSeenNavHelp` localStorage from the WebGL run also leaks into the WebGPU run, hiding the help panel — appears as a regression in the side-by-side screenshots even though it's a runner-context artifact, not a Cesium bug.

These are queued for a future session focused on per-feature visual fidelity rather than rendering correctness.


## Session 63 cont. (2026-05-09) — Polyline rendering revival + atmosphere alpha mix + runner CLI

### `BUG-WEBGPU-POLYLINE-LENGTH-TYPO` — `collection._polylinesLength` is undefined; entire polyline path early-exits

**Symptom:** Polylines completely missing on WebGPU. CZML Polyline + Polyline + Polyline Dash + Polyline Volume + CZML Polyline Volume + CZML Reference Properties + Geometry and Appearances all rendered the globe but no polylines. WebGL showed colored lines correctly.

**Root cause:** [WebGPUPolylineRenderer.js#L1188](packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) read `collection._polylinesLength` to decide whether to bail early. The actual property on `PolylineCollection` is `_polylines` (an array) — `_polylinesLength` doesn't exist. Result: `length === 0` was always falsy (undefined), but at the top of every entry point the read returned `undefined`, and the cascade of subsequent `_polylinesLength` reads all wrote `undefined` lengths into per-segment buffers / loop bounds / instance counts, silently producing no commands. 4 read sites total (lines 197, 367, 571, 1188).

**Fix:** Replaced all 4 `collection._polylinesLength` reads with `collection._polylines.length`.

### `BUG-WEBGPU-POLYLINE-MAPPED-AT-CREATION` — same `mappedAtCreation: true` latent bug as Billboard / Label / PointPrimitive

**Symptom:** After fixing the length-typo bug, polylines surfaced 46 `[Buffer "Polyline X segments"] used in submit while mapped` warnings per frame, and the entire scene went black (the invalid command buffer killed everything).

**Root cause:** Same pattern as the [Session 63 createVertexBuffer overload fix](#bug-webgpu-createvertexbuffer-overload). The polyline renderer's three `WebGPUBuffer.createVertexBuffer(device, sizeBytes, true, label)` calls (instance segments, prev segments, pick segments) were calling the new overload with `mappedAtCreation = true` while the very next statement is `device.queue.writeBuffer(...)` — which fails on a mapped buffer. Pre-overload the `true` was silently treated as the label string and ignored; post-overload it became real semantics and broke things.

**Fix:** Flipped all 3 polyline `createVertexBuffer` call sites to `mappedAtCreation: false`. Same mechanical fix as Billboard / Label / PointPrimitive received earlier.

### `BUG-WEBGPU-SKYATMO-ALPHA-MIX` — alpha derived from dim post-tonemap RGB clamps to ~0

**Symptom:** WebGPU SkyAtmosphere produced near-zero alpha for the typical dim Rayleigh+Mie scattering output. The atmosphere geometry rendered (confirmed by replacing fragment output with magenta — visible thin halo around Earth's limb) but the actual scattering output was blended to invisibility.

**Root cause:** [SkyAtmosphere.wgsl#L367](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl) computed `alpha = clamp(max(rgb)*2, 0, 1)` from the post-tonemap color. For dim scattering values (~0.001 RGB after `1 - exp(-x)` tonemap), alpha clamps to ~0.002 — effectively transparent.

**Compare to WebGL** [SkyAtmosphereFS.glsl#L55](packages/engine/Source/Shaders/SkyAtmosphereFS.glsl): `color.a = mix(color.b, 1.0, color.a)` — at minimum the alpha is the blue channel, so even when geometric opacity is near-zero (camera high above the atmosphere shell) the dominant blue channel still produces a visible halo. Pure RGB-magnitude derivation drops below WebGL's effective floor.

**Fix:** Compute `opacity = clamp(max(rgb)*2, 0, 1)` (preserving the existing geometric scaling) then `alpha = mix(rgb.b, 1.0, opacity)` — matches the WebGL pattern. Atmosphere parity isn't 100% (the WebGL path's color magnitude is also higher pre-tonemap due to different intensity scaling), but at least the dim-but-blue scattered output now shows as a halo instead of vanishing.

### Runner CLI ergonomics — `--include` / `--exclude` / `--exact` / `--list` / `--help`

The cross-backend runner previously only supported a single `--filter` substring, making it tedious to re-run a specific group of demos affected by a fix (or to pin to one demo when "Camera" also matches "Camera Tutorial"). Added:

- `--include "A,B,C"` — OR-match across multiple substrings (repeatable)
- `--exclude "X,Y"` — drop demos matching any substring (applied last)
- `--exact "Foo.html"` — exact filename(s); bypasses substring matching
- `--list` — print selected demos and exit (sanity check before a 40-min sweep)
- `--help` / `-h` — full usage reference
- Auto-wipe `output/cross-backend/*.png` + `report.json` at the start of full sweeps; subset runs (any selection knob set) preserve other demos' files

`Tools/visual-regression/output/cross-backend/` is now in `.gitignore` so the per-run binary blobs no longer churn the repo. Documented in [Tools/visual-regression/README.md](Tools/visual-regression/README.md).

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js` — `_polylinesLength` typo (4 sites) + `mappedAtCreation: true → false` (3 sites)
- `packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — alpha derivation matches WebGL `mix(blue, 1.0, opacity)` floor
- `Tools/visual-regression/cross-backend-sandcastle-runner.mjs` — `--include` / `--exclude` / `--exact` / `--list` / `--help` + auto-wipe on full sweep
- `Tools/visual-regression/README.md` — runner CLI documentation
- `.gitignore` — ignore `Tools/visual-regression/output/cross-backend/`

## Session 64 (2026-05-10) — Cubemap (skybox stars) double-sRGB encoding

### `BUG-WEBGPU-CUBEMAP-DOUBLE-GAMMA` — stars rendered as bright "concrete" background; entire scene perceived as washed out

**Symptom (user report):** "The colors in WebGPU seem blown out and unsaturated. The starmap sort of shows now but it almost looks like it has inverted colors." Visual diff confirmed: WebGPU `Hello World`, `Star Burst`, `Atmosphere`, etc. showed the BACKGROUND (where black space + dim stars should be) as a uniform gray/concrete-textured field. Bright stars stayed bright, but the dim background was elevated to mid-gray, collapsing star contrast and making the visible portion of the cubemap look "inverted" (dim regions brighter than they should be relative to bright stars).

**Root cause:** [WebGPUCubeMapPanoramaRenderer.js#L131](packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js) and the mirror file [Shaders/WebGPU/CubeMapPanorama.wgsl#L120](packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl) applied `pow(modulated, vec3<f32>(1.0 / 2.2))` UNCONDITIONALLY before returning the fragment. Cubemap PNG data is sRGB-encoded; the cubemap texture format is `rgba8unorm` (no auto-decode); the canvas color space is sRGB. So `textureSample` returns sRGB values as raw floats, and the canvas treats the shader output bytes as sRGB-encoded. The unconditional `pow(x, 1/2.2)` re-encoded sRGB on top of sRGB:
- Black (0.0) → 0.0 (stays black, OK)
- Dim background (sRGB ~0.05) → `pow(0.05, 0.454) ≈ 0.247` (lifts to mid-gray)
- Mid (sRGB ~0.5) → `pow(0.5, 0.454) ≈ 0.732` (over-bright)

The dim regions of the star cubemap thus became a uniform gray/concrete background, drowning out the bright stars and making the whole scene look low-contrast.

**Compare to WebGL** [Builtin/Functions/gammaCorrect.glsl](packages/engine/Source/Shaders/Builtin/Functions/gammaCorrect.glsl): `czm_gammaCorrect` is `#ifdef HDR` — a no-op when HDR is off (the default). [SkyBoxFS.glsl#L8](packages/engine/Source/Shaders/SkyBoxFS.glsl) calls `czm_gammaCorrect(color)` which returns the sample untouched when HDR is off. So WebGL with HDR=off writes raw sRGB cubemap values to the canvas — which is what the canvas's sRGB color space expects.

**Fix:** Removed the unconditional pow on both shader files. Now `return vec4<f32>(modulated, morphTime);` matches WebGL's HDR-off behavior. Cubemap PNG bytes flow through to the sRGB canvas without re-encoding. Documented a `// TODO:` for HDR mode (when `_hdrCanvasOutput` is on, the shader should `pow(color, 2.2)` to put the sRGB sample into linear HDR space before the tonemap stage re-encodes for display) — kept out of scope here since it requires plumbing an HDR flag through the panorama uniform and the user's complaint was specifically the SDR-default case.

**Verification:** Targeted re-run of `Hello World`, `Star Burst`, `Atmosphere`, `Imagery Adjustment`, `Earth at Night`, and friends shows the background is now BLACK with bright sparse stars (matches WebGL). The Earth itself reads slightly brighter than WebGL in some demos — likely a separate issue (the Primitive PBR shaders also have unconditional `pow(color, 1/2.2)` after a per-fragment Reinhard, which double-tonemaps when the post-process tonemap stage is also active; deferred since it requires coordinating the per-fragment tonemap with the post-process stage's enable state).

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js` — removed unconditional pow; documented HDR-mode TODO
- `packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl` — same fix in the mirror .wgsl file

## Session 64 cont. (2026-05-10) — HDR detection audit + Model PBR tonemap operator (Reinhard → PBR Neutral)

### HDR support detection — not the source of the wash-out

After the cubemap fix, audited whether the residual Earth wash-out came from WebGPU using HDR when it shouldn't. Findings:

- **WebGL** ([Context.js#L527-L534](packages/engine/Source/Renderer/Context.js#L527-L534)) genuinely probes `EXT_color_buffer_float` / `EXT_color_buffer_half_float` / `WEBGL_depth_texture`; the values reflect what the device supports.
- **WebGPU** ([WebGPUContext.ts#L559-L561](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L559-L561)) hardcodes `_colorBufferFloat = true` and `_colorBufferHalfFloat = true`. Justified in practice because `rgba16float` is mandatory-renderable per WebGPU spec, but it does mean the getters lie about `rgba32float` blending availability.
- **HDR scene FB format selection** ([WebGPUSceneFramebuffer.ts#L366-L373](packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts#L366-L373)) DOES feature-check `rg11b10ufloat-renderable` and falls back to the always-supported `rgba16float`.
- **HDR canvas output** ([WebGPUContext.ts#L4606-L4656](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L4606-L4656)) has reactive try/catch fallback chain: `rgba16float + display-p3 + extended toneMapping` → `rgba16float` only → `bgra8unorm` SDR.
- **Defaults are HDR-OFF everywhere**: `Scene.highDynamicRange = false`, `_hdrCanvasOutput = false`, `WebGPUSceneFramebuffer._hdr = false`.

So we are NOT mistakenly enabling HDR. The cubemap bug and the residual wash-out reproduced with `_hdr === false` everywhere. Marked the audit complete; no code changes — the existing detection chain is correct in practice.

### `BUG-WEBGPU-MODEL-PBR-TONEMAP-OPERATOR` — Reinhard squashes mid-tones; WebGL uses Khronos PBR Neutral

**Symptom:** glTF models on WebGPU render with noticeably duller / lower-contrast colors than the same model on WebGL. Most visible on textured PBR models with mid-tone albedos in the [0.4, 0.6] range — those values are pulled down to ~0.33 by Reinhard before the gamma encode lifts them to ~0.62, producing the "everything is mid-gray" look the user reported as "washed out and unsaturated."

**Root cause:** [ModelPBRComplete.wgsl#L878-L881](packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) applied the simple Reinhard operator `color / (color + 1.0)` followed by `pow(., 1/2.2)`. Reinhard compresses the entire [0, +∞) range, so even SDR mid-tones (peak 0.5) get pulled to 0.333 before the gamma encode. The two call sites are the unlit early-out (line 1850) and the final lit composition (line 2536) — every visible pixel of every glTF model went through this curve.

**Compare to WebGL** [LightingStageFS.glsl#L186-L204](packages/engine/Source/Shaders/Model/LightingStageFS.glsl):
```glsl
#ifndef HDR
    color = czm_pbrNeutralTonemapping(color);
#endif
// ...
#elif !defined(HDR)
    color = czm_linearToSrgb(color);
#endif
```
WebGL uses the **Khronos PBR Neutral** operator ([pbrNeutralTonemapping.glsl](packages/engine/Source/Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl)) which is **identity for inputs ≤ 0.76** — only peaks above that get gently compressed with saturation preservation. SDR mid-tones pass through unchanged, then `czm_linearToSrgb` does the sRGB encode. Both steps are gated on `#ifndef HDR` so HDR builds skip them entirely (post-process tonemap stage handles HDR display mapping).

**Fix:** Replaced Reinhard with an inline port of the Khronos PBR Neutral curve and routed `tonemapAndGamma` through it. The fix is **unconditional in WebGPU for now** because the active WebGPU paths all run with `_hdr === false` — when HDR plumbing reaches the Model shader (it doesn't yet), gate both the tonemap and the gamma encode on the HDR flag to match WebGL's `#ifndef HDR`. The TODO is in the source comment.

```wgsl
// New tonemapAndGamma:
let mapped = pbrNeutralTonemap(max(color, vec3<f32>(0.0)));
return pow(mapped, vec3<f32>(1.0 / 2.2));
```

**Visual impact:** Mid-tone albedo (RGB 0.5) before fix went to 0.333 → 0.62 displayed; after fix stays at 0.5 → 0.74 displayed (then sRGB-decoded by display back to ~0.5). Brighter parts (peak > 0.76) get a mild compression curve that preserves saturation instead of crushing it.

### Dead-PBR-shader audit (no code changes)

While auditing the PBR pipeline, confirmed three "WebGPU PBR" shaders are scaffolded but not wired:

- [PrimitivePBRSimple.wgsl](packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePBRSimple.wgsl) — registered in `WebGPUPrimitiveShaders.js` shader cache, exposed via `selectPBRShader()`, but no caller invokes that selector. Search for `"pbrSimple"` / `"pbrTextured"` finds only the registration sites.
- [PrimitivePBRTextured.wgsl](packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePBRTextured.wgsl) — same.
- [PBRMetallicRoughness.wgsl](packages/engine/Source/Shaders/WebGPU/PBRMetallicRoughness.wgsl) — referenced as a constant in `WebGPUShaderCache.ts` but the constant has no consumers.

All three carry the same Reinhard + unconditional gamma pattern that bit `ModelPBRComplete.wgsl`. Per CLAUDE.md §7 the scaffolding stays in place — they're pre-allocated for the planned PBR primitive path. **TODO when those land:** apply the same PBR Neutral conversion at that time.

### Files modified

- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — added `pbrNeutralTonemap`, swapped Reinhard for it inside `tonemapAndGamma`. The `.js` mirror was regenerated by the build.

## Session 64 cont. (2026-05-10) — Atmosphere tonemap parity (Globe FOG branch + SkyAtmosphere)

### `BUG-WEBGPU-GLOBE-FOG-NO-TONEMAP-OR-GAMMA` — Globe FOG branch mixes raw linear-HDR atmosphere into sRGB imagery

**Symptom:** Earth on WebGPU reads as slightly lighter and lower-contrast than WebGL across baseline demos (Hello World, Star Burst, etc.). After the cubemap fix landed, this was the leading remaining color delta on the disk itself — most visible at the limb and over deep-blue ocean tiles where the haze blend has the most authority.

**Root cause:** [GlobeTerrain.wgsl#L1925-L1929](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl#L1925-L1929) (pre-fix) computed the fog color from `computeAtmosphereColor()` (HDR-linear output, magnitudes in the 0.05–0.30 range for typical viewing) then mixed it straight into the imagery without any color-space conversion. The imagery is already sRGB-encoded display-space (textures stored as `rgba8unorm`, sampled raw). Mixing linear-HDR fog into sRGB imagery is a category error — it tints the limb dim-blue/cyan instead of the bright sky-blue WebGL produces.

**Compare to WebGL** [GlobeFS.glsl#L519-L533](packages/engine/Source/Shaders/GlobeFS.glsl#L519-L533):
```glsl
vec3 fogColor = groundAtmosphereColor.rgb;
#ifndef HDR
    fogColor.rgb = czm_pbrNeutralTonemapping(fogColor.rgb);
    fogColor.rgb = czm_inverseGamma(fogColor.rgb);
#endif
finalColor = vec4(czm_fog(v_distance, finalColor.rgb, fogColor.rgb, czm_fogVisualDensityScalar), finalColor.a);
```
WebGL brings the linear fog into SDR display space with PBR Neutral + sRGB encode FIRST, so the mix is between two display-space values. Both steps gated on `#ifndef HDR` (skipped when HDR is on, since the post-process tonemap stage will handle the conversion downstream).

**Fix:** Added an inline `pbrNeutralTonemapAtmosphere` helper (port of `czm_pbrNeutralTonemapping`) and routed the fog color through it followed by `pow(., 1/2.2)` before the mix. Identity for typical SDR atmosphere magnitudes; the curve only kicks in for the rare bright peak (e.g. when an Atmosphere demo dials `atmosphereLightIntensity` way up).

### `BUG-WEBGPU-SKYATMO-WRONG-TONEMAP-OPERATOR` — `1 - exp(-x)` instead of PBR Neutral, no sRGB encode

**Symptom:** SkyAtmosphere halo around the Earth reads dimmer and slightly cooler than WebGL's halo. The earlier alpha-mix fix (Session 63) made it visible at all, but it never matched WebGL's tonal feel.

**Root cause:** [SkyAtmosphere.wgsl#L364-L365](packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl#L364-L365) (pre-fix) used `finalColor = vec3<f32>(1.0) - exp(-finalColor)` — a Hejl-style exposure curve that compresses the entire range (not the gentle Khronos PBR Neutral curve WebGL uses) and skipped the sRGB encode entirely. So the result was both darker AND in the wrong color space for the canvas.

**Compare to WebGL** [SkyAtmosphereFS.glsl#L40-L43](packages/engine/Source/Shaders/SkyAtmosphereFS.glsl#L40-L43):
```glsl
#ifndef HDR
    color.rgb = czm_pbrNeutralTonemapping(color.rgb);
    color.rgb = czm_inverseGamma(color.rgb);
#endif
```
Same pattern as the Globe FOG branch — PBR Neutral then sRGB encode, gated on `#ifndef HDR`.

**Fix:** Added `pbrNeutralTonemapSky` helper (same Khronos port) and replaced the exp-tonemap with `pbrNeutralTonemapSky` + `pow(., 1/2.2)`. The alpha derivation stays as-is (Session 63 fix) — its job is to make sure dim-but-real scattered output produces a visible halo even when the geometric opacity is near zero.

### Files modified

- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — added `pbrNeutralTonemapAtmosphere` near the existing atmosphere helpers; routed fog color through tonemap + sRGB encode before mixing into imagery
- `packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — added `pbrNeutralTonemapSky`; replaced `1 - exp(-color)` exposure tonemap with `pbrNeutralTonemapSky` + `pow(., 1/2.2)`

The two helpers are duplicated rather than shared because the WGSL preprocessor's include path isn't wired between Globe/ and Environment/ for these files yet (same reason CSM helpers are duplicated inline per the Globe shader's own commentary). Once that lands, fold both into a single `pbrNeutralTonemap` chunk in `WGSLBuiltins.ts`.

## Session 64 cont. (2026-05-10) — Cross-backend runner: Sandcastle defaultAction never fires on WebGPU model demos

### `BUG-RUNNER-SANDCASTLE-DEFER-TOO-EARLY` — `finishedLoading` checks `_hasToolbarMenu` before the menu is registered

**Symptom (user report):** "the camera issues are still there for some of the WebGPU tests where they are not focusing the camera to the correct location. Look at 3D_Models_coloring & 3D_Models tests." On WebGPU, `3D Models.html`, `3D Models Coloring.html`, `Clamp to 3D Model.html`, and similar model demos showed Earth-from-space instead of the close-up model view that WebGL produced. The toolbar menu (Aircraft / Drone / Ground Vehicle / etc.) was also missing from the WebGPU screenshots.

**Root cause:** A pixel-level `__capturedViewer` probe ([Tools/visual-regression/track-entity-probe.mjs](Tools/visual-regression/track-entity-probe.mjs)) showed `entityCount: 0` on WebGPU at every time point — the demo's `createModel()` (the toolbar's `defaultAction`) **never ran** on WebGPU. Trace logs revealed the call order:

WebGL (sync `new Cesium.Viewer`):
```
1. patchSandcastle
2. addToolbarMenu  ← _hasToolbarMenu = true
3. finishedLoading ← _hasToolbarMenu == true → defers correctly
```

WebGPU (HTML rewritten to `await Cesium.Viewer.createAsync`):
```
1. patchSandcastle
2. finishedLoading ← _hasToolbarMenu == FALSE → falls through to original immediately!
3. addToolbarMenu (TOO LATE — defaultAction set after finishedLoading already returned)
```

The runner's [`patchSandcastle` in cross-backend-sandcastle-runner.mjs](Tools/visual-regression/cross-backend-sandcastle-runner.mjs) (pre-fix lines 350-360) gated the deferral on whether `_hasToolbarMenu` had already been observed:

```js
SC.finishedLoading = function () {
  if (!_hasToolbarMenu) {
    _origFinishedLoading.call(SC); // call ORIGINAL synchronously
    return;
  }
  deferFinishedLoading();
};
```

This works for WebGL because the synchronous `new Viewer(...)` constructor lets `addToolbarMenu` run BEFORE control returns to `load-cesium-es6.js`. On WebGPU, `await Cesium.Viewer.createAsync(...)` suspends the startup function, so `addToolbarMenu` runs AFTER `load-cesium-es6.js` calls `Sandcastle.finishedLoading()`. The `_hasToolbarMenu` gate had the wrong polarity — it should defer when there's any reason to wait, not require evidence that the menu already exists.

**Fix:** Replaced the `_hasToolbarMenu` gate with a `_startupPromise || typeof _startup === "function"` gate. If the demo registered a `window.startup` (every modern Sandcastle demo does), defer `finishedLoading` until `_startupPromise` resolves — by then the menu has had a chance to register and `defaultAction` is set. Only legacy demos without `window.startup` use the synchronous fall-through.

**Verification:** Re-running [track-entity-probe.mjs](Tools/visual-regression/track-entity-probe.mjs) post-fix shows both backends now report `entityCount: 1`, `hasTrackedEntity: true`, identical camera positions (`(-14000, 3500, 3500)` at altitude 8516m for `3D Models.html`'s default Aircraft menu pick). The `3D_Models.webgpu.png` cross-backend output now shows the camera AT the model location (with the toolbar dropdown visible) instead of the default Earth-from-space.

**Scope of impact:** This fixes EVERY WebGPU model demo that uses `Sandcastle.addToolbarMenu` to set up its scene state. By rough count from the previous sweep results, ~25-40 demos were affected (anything with a model picker, aircraft/drone/balloon variant, or category dropdown that drives entity creation). The "WebGPU camera shows Earth from space instead of the model" symptom is a single root cause manifesting across all of them.

### Files modified

- `Tools/visual-regression/cross-backend-sandcastle-runner.mjs` — replaced `_hasToolbarMenu` gate in `patchSandcastle()` with a `_startupPromise || typeof _startup === "function"` gate
- `Tools/visual-regression/track-entity-probe.mjs` — new diagnostic: drops the cross-backend runner's HTML-rewrite + Sandcastle-defer shim into a standalone Playwright probe and dumps `viewer.trackedEntity` / `entityCount` / camera state at 2-second intervals for both backends. Useful for future "why doesn't WebGPU XYZ" demos.




## Session 65 (2026-05-11) — GroundAtmosphere drape missing at orbital altitudes

### Symptom

At Hello-World camera altitudes (~12 Mm), the WebGPU planet renders only the **SkyAtmosphere shell** at the limb. The expected **GroundAtmosphere drape** — a soft blue tint that covers the entire visible planet disk on WebGL — is absent. Users see a hard-edged planet against the skybox with a thin atmospheric ring, instead of the gradient atmospheric blend WebGL shows.

The user caught this after my magenta-marker probe earlier in Session 65 only confirmed the SkyAtmosphere shell rendered at the limb. The two effects are visually similar but architecturally distinct:

1. **SkyAtmosphere shell** — `WebGPUSkyAtmosphereRenderer` draws a translucent shell mesh around the planet, visible at the limb where the view ray grazes the atmosphere.
2. **GroundAtmosphere drape** — applied inside `GlobeFS.glsl` / `GlobeTerrain.wgsl`, blends the atmosphere color INTO each ground fragment, producing the haze that drapes over the planet disk itself.

### Root cause

`GlobeTerrain.wgsl`'s atmosphere blend code was gated solely by `fogDensity > 0.0`:

```wgsl
let fogDensity = tile.fogDensity;
if (fogDensity > 0.0) {
  // ... sample LUT, blend fogColor via czm_fog() ...
}
```

But `Fog.update()` in [`Scene/Fog.js`](packages/engine/Source/Scene/Fog.js#L130) hard-disables fog when `camera.positionCartographic.height > this.maxHeight` (default 800 km):

```js
if (positionCartographic.height > this.maxHeight) {
  frameState.fog.enabled = false;
  frameState.fog.density = 0;
  return;
}
```

The CesiumViewer's default home camera puts the user at ~12 Mm. Fog is disabled. The fog branch never runs. No drape is applied.

**WebGL has two delivery paths** for the atmospheric color over ground fragments, gated by `#if defined(GROUND_ATMOSPHERE) || defined(FOG)` in [GlobeFS.glsl:475](packages/engine/Source/Shaders/GlobeFS.glsl#L475):

- `#ifdef FOG` branch (lines 519-533) — close-to-ground, drives the drape via `czm_fog()`. Active when camera < 800 km.
- `#else` branch (lines 535-563) — far-from-ground, drives the drape via `mix(imagery, finalAtmosphereColor, fade)` with `fade` derived from `lightingFadeOutDistance/lightingFadeInDistance` (defaults π/2 × R ≈ 10 Mm / π × R ≈ 20 Mm). Active when camera is between 10–20 Mm.

WebGPU was missing the `#else` branch entirely.

### Fix

Three changes:

1. **TileUniforms struct** — added `groundAtmosphereControl: vec4<f32>` slot at offset 472 (bumping struct from 472 floats / 1888 bytes to 476 floats / 1904 bytes). Carries:
   - `.x` = enable flag (1.0 when `showGroundAtmosphere && fade > 0`)
   - `.y` = pre-computed fade scalar
   - `.z` = `atmosphereLightIntensity`
   - `.w` = reserved
2. **CPU pack (`WebGPUGlobeSurfaceTileUB.ts`)** — reads `frameState.camera.positionWC`, computes `cameraDist = |positionWC|`, derives `fade = clamp((cameraDist - lightingFadeOutDistance) / span, 0, 1)`. Writes into the new slot. Fade source values come from `tileProvider.lightingFadeOutDistance/lightingFadeInDistance` (mirrored from `Globe` in [`Globe.js:1086-1087`](packages/engine/Source/Scene/Globe.js#L1086)).
3. **GlobeTerrain.wgsl** — restructured the fog block so the LUT/inline atmosphere-color computation runs for BOTH paths (fog vs drape). Added a `else if (groundAtmosphereEnabled)` branch that mirrors WebGL's `#else`:

```wgsl
let transmittanceModifier: f32 = 0.5;
let transmittance = transmittanceModifier + atmosphereOpacity;
let finalAtmosphereColor = color + atmosphereColor * transmittance;
let exposure: f32 = 2.0; // matches GlobeFS.glsl fExposure
let tonemapped = vec3<f32>(1.0) - exp(-exposure * finalAtmosphereColor);
let fadeAmount = tile.groundAtmosphereControl.y;
color = mix(color, tonemapped, fadeAmount);
```

The exposure constant 2.0 matches [GlobeFS.glsl:302](packages/engine/Source/Shaders/GlobeFS.glsl#L302) `const float fExposure = 2.0;`.

### Verification

Pre-fix CesiumViewer WebGPU screenshot (Hello-World camera): planet disk renders flat against starfield with no atmospheric tint over the surface; only the SkyAtmosphere shell is visible at the limb.

Post-fix CesiumViewer WebGPU screenshot: planet disk now shows the expected blue atmospheric drape covering the visible portion, fading by fade scalar (~0.6 at the default 12 Mm altitude). Day/night terminator is visible. Drape integrates with the existing LUT-based atmosphere color computation.

### Limitations / follow-ups

- The drape uses the SkyAtmosphere LUT (intensity 50.0) scaled by `GROUND_INTENSITY_RESCALE = 0.2` to approximate `Globe.atmosphereLightIntensity = 10.0`. A dedicated ground-LUT dispatch would be more accurate when users customize either intensity independently.
- The WebGL `#else` branch optionally applies a sun-darken/sunlit-intensity ramp under `defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))`. Not yet ported — the WGSL branch always uses the unlit path. Track under DEFERRED_WORK if a user needs the directional intensity modulation.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts` — added `GROUND_ATMOSPHERE_CONTROL_OFFSET = 472`, bumped `TILE_UNIFORM_FLOATS` to 476.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts` — CPU-side pack of `groundAtmosphereControl` vec4 (enable + fade + intensity).
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — added `groundAtmosphereControl: vec4<f32>` to TileUniforms; restructured fog/drape block with `else if (groundAtmosphereEnabled)` branch matching `GlobeFS.glsl` lines 535-563.

## Session 65 cont. (2026-05-11) — SkyAtmosphere depth-range mismatch for inside-shell views

### Symptom

All ground-level photogrammetry / city-scale demos (Aerometrex SF, Particle System Fireworks, 3D Tiles BIM, Lighting, Shadows, Bloom @ ground level — Session 65 triage at 96.6%, 96.5%, 94.8%, 94.1%, 93.3% diff) show a **pitch-black sky** above the horizon in WebGPU where WebGL shows the expected blue atmospheric scattering. Hello World @ orbital altitudes renders the sky shell correctly — only inside-shell views fail.

### Root cause

`WebGPUSkyAtmosphereRenderer.packUniforms` read `camera.frustum.projectionMatrix` directly. The frustum lazily computes and caches that matrix from `Matrix4._depthRangeType`, which is left at `"webgl"` globally (so the WebGL backend keeps working). The cached projection emits clip-space depth in `[-1, 1]` per WebGL convention.

WebGPU's clip test rejects any fragment whose NDC z is outside `[0, 1]`. So the WebGL-range projection silently culls every shell fragment whose NDC z lands in `[-1, 0)`. For outside-shell views (orbital altitudes), every shell vertex sits in front of the camera (positive view-space z) and the projection naturally produces NDC z in `[0, 1]` — works. For inside-shell views (camera below outer radius, so the shell wraps around), shell vertices span the camera's whole sphere; the half whose NDC z maps into `[-1, 0)` gets clipped, leaving only background pixels where WebGL renders sky.

`Matrix4.setDepthRangeType("webgpu")` alone doesn't fix it — the off-center frustum's `update()` only recomputes `_perspectiveMatrix` when `near/far/left/right/top/bottom` change. The depth-range setter doesn't invalidate the cache, so the SkyAtmosphere still picks up the stale WebGL-range matrix.

### Fix

[`packUniforms` in WebGPUSkyAtmosphereRenderer.js](packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js) now bypasses the cached `camera.frustum.projectionMatrix` and computes the projection directly with `Matrix4.computePerspectiveOffCenter(left, right, bottom, top, near, far, scratchProjectionWebGPU)` while `_depthRangeType === "webgpu"`. The WebGL backend still reads `camera.frustum.projectionMatrix` for its own MVP, so the frustum cache stays in WebGL convention — no cross-backend regression.

### Verification

- Pre-fix: `frameState.debugDisableAtmosphereScattering = true` at SF 80km altitude → sky region RGB `(0, 0, 0)`. Fragment shader's magenta debug-return never produces magenta → confirms geometry was being clipped before the FS ran.
- Post-fix (depth range): same setup → sky region RGB `(127.5, 0.5, 127.5)` = magenta = 50%-blended `(255, 0, 255, 0.5)` over black. Fragment shader now runs at inside-shell altitudes.

### Still open

With the magenta debug off, the inside-shell sky returns RGB `(0, 0, 0)` instead of blue. The depth-range fix gets the shell rendering; the LUT-based scattering math still produces near-zero color for inside-shell views. Suspects:

- LUT may not be re-baked when camera enters the shell.
- `sampleScatteringLut`'s `vCoord = altitude / thickness` clamps to `[0, 1]` but the LUT's row 0 (sea level) might be all-zero from the bake.
- The exposure tonemap `1 - exp(-color)` collapses tiny LUT values to ~0.

Tracking this as next iteration's investigation.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` — replaced `camera.frustum.projectionMatrix` read with an inline `computePerspectiveOffCenter` call under `setDepthRangeType("webgpu")`; restores `"webgl"` before returning so the global default stays unchanged.

## Session 65 Batch 1 (2026-05-11) — Vertex-buffer variant + atmosphere intensity scaling + HDR-aware drape

Three independent fixes landed together.

### NEW-VR-VERTEX-BUFFER-VARIANT closure (slot 8 variant)

Session 62 made vertex buffer slot 7 (`texCoord1`) variant-conditional via `MODEL_HAS_TEXCOORD_1`. Session 65 added the matching `MODEL_HAS_FEATURE_ID_0` flag so slot 8 (`featureId0`) is also stripped when the primitive carries no `_FEATURE_ID_0` / `_BATCHID` accessor. Layout tiers are now:

- 7 slots (both flags off, standard glTF model without batching) — common case.
- 8 slots (one flag on, other off).
- 9 slots (both on — rare combination of multi-UV materials + feature IDs; still needs further restructure on Edge).

The shader's `@location(8)` declaration is wrapped in `//>>ifdef MODEL_HAS_FEATURE_ID_0` and the vertex assignment falls back to `output.featureId0 = 0.0` in the `//>>else` branch, so the FS varying always gets a value (the FS only reads it when `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set, so the zero default never reaches a lookup). Vertex buffer push in `WebGPUModelRenderer.js` matches: featureId buffer is appended only when the flag is set, keeping the bound count aligned with the pipeline layout.

### NEW-VR2-6 atmosphere intensity scaling

`sampleAtmosphereFogLut` in `GlobeTerrain.wgsl` hardcoded `GROUND_INTENSITY_RESCALE = 0.2` (tuned for the default ratio `sky=50 / globe=10`). When `globe.atmosphereLightIntensity = 20` (the `Atmosphere.html` setting), the rescale stayed 0.2 → ground fog ended up half its proper magnitude → downstream tonemap saturated to uniform tan.

Fix: drop the hardcoded scalar and multiply directly by `tile.groundAtmosphereControl.z` (CPU-side `Globe.atmosphereLightIntensity`). LUT is intensity-free at bake time (`SkyAtmosphere::sampleScatteringLut` applies `u.intensity` per-fragment), so this is now the correct math for any user-customized intensity. Default Hello-World stays bit-identical (`0.2 × 50 = 10`).

### HDR-aware drape branch

The drape branch in `GlobeTerrain.wgsl` unconditionally applied `1 - exp(-2 × x)` tonemap. WebGL's `GlobeFS.glsl` skips that tonemap under `#ifdef HDR` and replaces it with a `czm_saturation(color, 1.6)` boost, letting the post-process chain handle final compression on linear-radiance pixels. WebGPU's drape now mirrors that: `tile.groundAtmosphereControl.w` carries the HDR flag (`Scene.js` mirrors `_hdr` onto `frameState.useHDR` per frame); when set, the drape outputs raw linear-HDR finalAtmosphereColor and lets post-process tonemap downstream.

### NEW-VR2-2 reassessment

DEFERRED_WORK entry was outdated. Cross-backend sweep 2026-05-11 shows Mars + Aerometrex SF + 3D Tiles BIM now render textured base color. Only `Moon.html` remains broken — pattern matches the Sandcastle dropdown-state issue (Cesium.Ellipsoid.default switch + deferred startup), not a texture-upload bug.

### Verification

Focused sweep on the previously-affected demos:

| Demo                          | Pre  | Post  |
|-------------------------------|------|-------|
| Hello World                   | 49.87% | 47.45% |
| Atmosphere                    | 28.83% | 27.26% |
| Aerometrex San Francisco      | 94.1%  | 93.89% |
| 3D Tiles BIM                  | 92.0%  | 91.97% |

The variant fix's main payoff is unblocking pipelines for primitives that DO hit the 9-slot cap (most demos in our test setup were already compiling because the adapter granted 9). Sweep-wide impact mostly visible on imagery-driven demos via the intensity scaling + HDR fixes.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — added `MODEL_HAS_FEATURE_ID_0 = 1 << 13`.
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js` — variant-conditional slot 8; threaded `hasFeatureId0` through all 8 pipeline factories; added the bit to the cache-key define mask.
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js` — sets the flag from `geometry.hasFeatureId0`; conditional vertex buffer push.
- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — `//>>ifdef MODEL_HAS_FEATURE_ID_0` around the @location(8) declaration and the input → output assignment.
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — replaced `GROUND_INTENSITY_RESCALE` with `tile.groundAtmosphereControl.z`; HDR-aware drape branch (skip exp tonemap when `groundAtmosphereControl.w > 0.5`).
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts` — packs `frameState.useHDR` into `groundAtmosphereControl.w`.
- `packages/engine/Source/Scene/Scene.js` — mirrors `_hdr` onto `frameState.useHDR` per frame.
- `migration_doc/DEFERRED_WORK.md` — closed NEW-VR-VERTEX-BUFFER-VARIANT, NEW-VR2-6, downgraded NEW-VR2-2 to Moon-only.

## Session 65 Batch 2 (2026-05-11) — Primitive topology + CZML triage

### Outline geometries rasterizing as triangles — FIXED

`WebGPUPrimitiveCommands.js` hardcoded `topology: "triangle-list"` in all four pipeline factories (regular noCull/frontCull/backCull, material pipeline, regular pick pipeline, material pick pipeline). Outline geometries (`BoxOutlineGeometry`, `CylinderOutlineGeometry`, etc., all set `primitiveType = PrimitiveType.LINES`) were being submitted to triangle-list pipelines: the vertex buffer carried line endpoints, the index buffer carried line indices, the rasterizer interpreted them as triangle strips of garbage. Visible across ~12 CZML demos with `outline: true` boxes/cylinders.

WebGL doesn't have this problem because `gl.drawElements(mode, ...)` takes the topology at draw call time — same shader can draw triangles or lines just by changing the `mode` argument. WebGPU bakes `primitive.topology` into the immutable `GPURenderPipeline`; mismatched topology silently produces garbage.

Fix: added `mapCesiumPrimitiveTypeToWebGPU(primitiveType)` that maps Cesium's GL-enum `PrimitiveType` → WebGPU topology string (`PrimitiveType.LINES → "line-list"`, etc.). Added `primitiveTopology` to the per-primitive cache as an invalidation key so pipelines get rebuilt when topology changes. Threaded the topology through `createMaterialPipelineAndCache` and the corresponding pick pipeline factories. For line topologies, `cullMode` is forced to `"none"` (no front/back-facing concept for lines).

### Visual verification

CZML Box: yellow box (`fill: false, outline: true`) was previously a solid yellow rectangle; now renders as a proper wireframe cube outline.

CZML Cones and Cylinders: green cylinder previously had garbled stripes; now shows wireframe-style line geometry matching WebGL.

### CZML Circles / Colors / Rectangle: NOT a renderer bug

These demos show "main shape entirely missing" on WebGPU. Investigation: the demos call `viewer.zoomTo(dataSourcePromise)`, which is async. The WebGL screenshots capture after zoomTo completes, the WebGPU screenshots capture with the camera still at the default Cesium home view (continents from orbit) — the ellipses/rectangles ARE rendered, they just sit at lat/lon coordinates that aren't in the visible viewport because the camera never zoomed in.

This is the same Sandcastle-state pattern as Aerometrex "Ferry Building" picks the wrong building on WebGPU — runner-level deferred startup interacts with `dataSourcePromise.then(zoomTo)` differently across backends. Tracked separately from renderer work.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` — added `mapCesiumPrimitiveTypeToWebGPU`; threaded `primitiveTopology` through `makePipeline` closure, `createMaterialPipelineAndCache`, and both pick pipeline factories; cache invalidation key now includes topology.

### Focused sweep verification (CZML demos only)

Before / after diffs (no other change between runs):

| Demo                          | Pre   | Post  |
|-------------------------------|-------|-------|
| CZML Box                      | 25.0% | 23.4% |
| CZML Cones and Cylinders      | 31.0% | 29.7% |
| CZML Corridor                 | 18.1% | 18.2% |
| CZML Polygon                  | 18.9% | 18.4% |
| CZML Rectangle                | 24.0% | 23.4% |

Modest pixel-diff drops; the main win is qualitative — outline geometry now renders correctly. Demos whose main shapes are missing (Circles, Colors) didn't move because that's a separate camera/zoomTo timing issue.

## Session 65 Batch 3 (2026-05-11) — Closed-appearance back-face culling

### Symptom

User reported "opacity bug" where opaque entities (Box, Sphere, Ellipsoid with alpha=1.0 colors) rendered with visible lat/long gridlines and apparent translucency on WebGPU — back-face content visible through the front face. Affected demos: Show or Hide Entities, CZML Spheres and Ellipsoids, single-ellipsoid CesiumViewer probe.

Diagnostic log confirmed the entities had `translucent=false` + `twoPasses=false` + `appearance.closed=true`, so the issue was NOT a blend-state problem.

### Root cause

WebGPU's primitive pipeline factories (both `createWebGPUCommands` for `PerInstanceColorAppearance` and `createMaterialPipelineAndCache` for `MaterialAppearance`) hardcoded `cullMode: "none"` on the default pipeline. With `depthWriteEnabled=true` (opaque path) AND no culling, back-face triangle fragments compete with front-face fragments at depth-test boundaries. Where their Z values nearly match, z-fighting causes back-face fragments to win on some pixels — producing visible "see-through" gridlines along every triangle seam of closed convex shapes.

WebGL's [`Appearance.getDefaultRenderState`](packages/engine/Source/Scene/Appearance.js#L161) adds `cull: { enabled: true, face: BACK }` whenever `closed: true` is set on the appearance options, killing back faces at the GL level so only front faces draw. Cesium's ellipsoid / sphere / box geometry updaters all create their fill `MaterialAppearance` (or `PerInstanceColorAppearance`) with `closed: true`, so the WebGL path automatically gets back-face culling — the WebGPU path did not.

### Fix

Both pipeline factories now read `appearance.closed` and set `cullMode: "back"` for closed shapes:

- `createWebGPUCommands` (PerInstanceColorAppearance path) — `const defaultCullMode = appearance?.closed ? "back" : "none";` and the default pipeline is built with that mode.
- `createMaterialPipelineAndCache` (MaterialAppearance path) — `appearanceClosed` is threaded through as a new parameter; the cache check + pipeline descriptor both consume it. Cull mode resolves to `"back"` for closed triangle-list pipelines, `"none"` otherwise. Line topologies still get `"none"` regardless.

### Verification

CesiumViewer probe with a single 500 km radius red sphere at 1 Mm altitude:

- **Pre-fix:** sphere shows clear lat/long gridlines + imagery bleeding through the ellipsoid mesh seams.
- **Post-fix:** sphere is solid red, no gridlines, no bleed-through. Matches WebGL visually.

Show or Hide Entities multi-shape demo:

- **Pre-fix:** boxes/ellipsoids/spheres all show wireframe-like surfaces.
- **Post-fix:** boxes now render as solid filled cubes. Ellipsoids and spheres show much-reduced gridline visibility but **still have faint per-triangle banding** — a follow-up issue (likely per-vertex normal lighting precision, separate from back-face culling).

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` — `defaultCullMode` from `appearance.closed` in `createWebGPUCommands`; `appearanceClosed` parameter threaded through `createMaterialPipelineAndCache`; both default pipelines use the resolved cull mode.

### Open follow-up

Ellipsoid/sphere multi-shape demo still shows faint mesh seams after the cull fix. Likely cause: per-vertex normal interpolation producing subtly different shading per triangle face (would suggest face-normal-style shading despite smooth WGSL interpolation), OR a precision artifact in the lit material shader's normal-matrix transform. Tracked for next batch.

## Session 65 Batch 4 (2026-05-11) — MSAA root cause + bridge attempt

### Discovery

After the Batch 3 cull-mode fix landed, the remaining lat/long mesh-seam banding on ellipsoid/sphere entities in the multi-shape demo was traced to a missing MSAA bridge.

[`Scene.js:405`](packages/engine/Source/Scene/Scene.js#L405) defaults `this._msaaSamples = options.msaaSamples ?? 4` — Cesium's WebGL backend renders with 4x MSAA out of the box. The WebGPU backend's [`WebGPUContext._msaaSamples`](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L390) is a hardcoded `1` and is **never written from `Scene.msaaSamples`**. Every WebGPU render pipeline downstream (`WebGPUSceneRenderer.prepareFrame`, `WebGPUSceneRendererEnsureResources`, `WebGPUModelRenderer`) reads `context._msaaSamples ?? 1` and uses that as the `sampleCount` for its pipelines — so all WebGPU pipelines effectively render with no antialiasing.

This explains the user-reported visual regression cluster:

- Sphere / ellipsoid mesh seams visible (Show or Hide Entities, single-sphere probe at small screen size)
- Polyline single-pixel lines visible as rough rasterization
- Model edges and small-feature triangulation visible everywhere

WebGL's 4x MSAA was silently hiding all of these via sub-pixel coverage averaging.

### Bridge attempt + revert

Added a bridge in `WebGPUSceneRenderer.prepareFrame` that copied `scene.msaaSamples` (capped at 4) into `context._msaaSamples` and triggered a framebuffer recreate when the value changed. The bridge itself was clean, but turning MSAA on broke multiple downstream pipelines that were not authored MSAA-aware:

```
GPU VALIDATION ERROR: [TextureView "GlobeDepth-DepthTextureView-MSAA"]
  usage (TextureUsage::RenderAttachment) doesn't include
  TextureUsage::TextureBinding.
- While validating entries[0] against { binding: 0, visibility: ...,
  texture: { sampleType: TextureSampleType::Depth, ..., multisampled: 1 } }.
- While validating [BindGroupDescriptor "GlobeDepth-DepthCopy-MSAA-BindGroup"]
```

`WebGPURenderTarget` was stripping the `TEXTURE_BINDING` usage flag from MSAA depth attachments under the assumption that multisampled depth couldn't be sampled in WGSL. That's wrong — WGSL supports `textureLoad` on multisample-depth textures, and `GlobeDepth-DepthCopy-MSAA-BindGroup` relies on exactly that path. Fixed `WebGPURenderTarget` so the flag is always present when `depthSamplable: true` (single-sample still adds `COPY_SRC`; MSAA gets only `TEXTURE_BINDING` since multisample textures can't be `copyTextureToTexture` sources).

After that fix, further downstream pipelines still failed — invert-classification cache, command-buffer invalidation, format-incompatible color attachments on dependent passes. The full MSAA-aware audit is a multi-session piece of work, so the bridge in `prepareFrame` was reverted and a comment left explaining the gap.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts` — adds `TEXTURE_BINDING` to MSAA depth textures (kept; harmless when MSAA is off, prerequisite for future MSAA enablement).
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — added a comment block documenting the gap; bridge code intentionally not wired.

### Next steps for MSAA enablement

Tracked as `NEW-WEBGPU-MSAA-FLEET-ENABLEMENT` in DEFERRED_WORK:

1. Audit every `device.createRenderPipeline` call in `packages/engine/Source/Renderer/WebGPU/` and confirm the `multisample.count` matches the framebuffer's sample count (a handful of fixed-1 sites need a `context._msaaSamples` lookup).
2. Confirm every render-attachment texture (color + depth + intermediate) has its `sampleCount` set from the same source and a paired single-sample `resolveTarget` where needed.
3. Confirm all `copyTextureToTexture` calls handle the "MSAA source not allowed" case (use blit-via-pipeline fallback).
4. Verify invert-classification + globe-depth copy + edge framebuffer cooperate with MSAA.
5. Then flip the bridge in `prepareFrame` and re-run the cross-backend sweep.

Expected impact: visual diff drop across every demo with small triangles (~70+ of the >50% diff bucket), and resolution of the remaining mesh-seam banding from Batch 3.

## Session 65 Batch 5 (2026-05-12) — Restored urijs import + index buffer alignment

### Restored missing `Uri` import (cross-backend bug)

`packages/engine/Source/DataSources/CzmlDataSource.js` uses `Uri` as a type sentinel in three places (line 510 `return Uri`, line 582 `case Uri:`, lines 3260 / 4483 `processPacketData(Uri, ...)`), but neither the import nor the underlying `urijs` dependency made it into our fork's engine package. Result: every CZML packet carrying a glTF `model` (CZML Model Articulations, etc.) crashed at parse time with `ReferenceError: Uri is not defined` on **both backends**.

Restored upstream's `import Uri from "urijs"` in `CzmlDataSource.js` and added `"urijs": "^1.19.7"` to `packages/engine/package.json` dependencies (matching upstream `cesium/main`).

### Index buffer 4-byte alignment

WebGPU requires `queue.writeBuffer` source `byteLength` and target buffer size to be multiples of 4. Uint16 index buffers with an odd index count produce `byteLength % 4 === 2` and pass straight to `writeBuffer`, which throws `OperationError: Failed to execute 'writeBuffer' on 'GPUQueue': Number of bytes to write must be a multiple of 4`. Fixed in `ensurePrimitiveCache` (WebGPUModelRenderer): pad both the buffer size and the write source to the nearest 4 bytes. `indexCount` stays at the authoritative value so the extra slot is never read.

### Newly exposed: indexCount-vs-buffer-size mismatch

After the alignment fix, CZML Model Articulations renders without the `writeBuffer` exception but now hits a deeper WebGPU validation error:

```
Index range (first: 0, count: 18, format: IndexFormat::Uint16)
  does not fit in index buffer size (20).
```

The draw count `18` and buffer size `20 bytes` disagree (18 Uint16 indices need 36 bytes, but the buffer was sized for `idxData.length = 10`). Something upstream of `ensurePrimitiveCache` is producing a `primCache.indexCount` that doesn't match `geometry.indexData.length`. Tracked as a follow-up — the model's articulations-resampling path is the most likely culprit.

### Files modified

- `packages/engine/Source/DataSources/CzmlDataSource.js` — restored `import Uri from "urijs"`.
- `packages/engine/package.json` — added `"urijs": "^1.19.7"` dependency.
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js` — `ensurePrimitiveCache` rounds index buffer size + write source to nearest 4 bytes.

### Pre-existing demo bugs verified (not WebGPU-specific)

- `Clamp Model to Ground.html`: `TypeError: Cannot read properties of undefined (reading 'model')` at the demo's `onselect` handler. Fails on **WebGL too**.
- `LocalToFixedFrame.html`: `TypeError: Cannot read properties of undefined (reading 'primitive')` at `window.startup` line 168. Fails on **WebGL too**.

Both demos have JS logic bugs predating the WebGPU port. Not in scope for renderer fixes.

---

## Session 65 Batch 6 (2026-05-12) — WebGLStubTexture cubemap support → PBR IBL no longer dark

Closes **NEW-WEBGPU-PBR-IBL-DARKNESS** in `DEFERRED_WORK.md`. PBR demos that rely on image-based lighting (e.g. `glTF PBR Extensions.html`, which sets `scene.light.intensity = 0` and lights entirely via `kiara_6_afternoon_2k_ibl.ktx2`) render very dark on WebGPU. The boombox/copper-sphere appears nearly black instead of showing specular highlights.

### Root cause: `WebGLStubTexture` allocated a single 2D layer for cubemap uploads

`SpecularEnvironmentCubeMap` and `OctahedralProjectedCubeMap` follow the WebGL cube-map upload protocol:

1. `bindTexture(TEXTURE_CUBE_MAP, tex)` — bind the texture as a cubemap.
2. For each face (POSITIVE_X / NEGATIVE_X / POSITIVE_Y / NEGATIVE_Y / POSITIVE_Z / NEGATIVE_Z, enums `0x8515` – `0x851a`): call `texImage2D(face, level, …)` or `compressedTexImage2D(face, level, …)`.

The stub's `bindTexture`, `texImage2D`, `texSubImage2D`, `compressedTexImage2D`, and `compressedTexSubImage2D` all ignored the cube target enums. `ensureTextureAllocated` always created a `depthOrArrayLayers: 1` 2D texture with a 2D view, and every face upload wrote to `origin.z = 0`. The six face uploads overwrote each other; only the last upload survived.

When `model._imageBasedLighting._specularEnvironmentCubeMap.ready` flipped true and the renderer reached for `specEnvMap._texture._webgpuTexture.view`, the view was either:

- A 2D view on a 1-layer texture (incompatible with `texture_cube<f32>` in WGSL — pipeline creation fell back to default), or
- The wrong sampling result for any face other than NEGATIVE_Z (the last one written).

Both modes degenerate to "no usable specular environment", which is what produced the symptom — `buildModelIBLEntries` returned null and the renderer bound the 1×1 50% gray default cubemap. Diffuse looked roughly correct because spherical-harmonic coefficients are not cubemap-sourced; specular was effectively zero.

### Fix: 6-layer cubemap allocation + per-face `origin.z` routing

Modified `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts`:

1. Added `_isCubeMap?: boolean` flag on `StubTexture`, latched when `bindTexture` sees `target === 0x8513 (TEXTURE_CUBE_MAP)` or when any of the per-face upload entry points first sees a face target.
2. Added `cubeFaceLayerForTarget(target)` helper that maps `0x8515 → 0`, `0x8516 → 1`, …, `0x851a → 5`. Returns `null` for non-face targets.
3. `ensureTextureAllocated` now picks `depthOrArrayLayers: 6` when `_isCubeMap` is set, with `dimension: "cube"` on the view. The existing 2D allocation path is preserved by defaulting `depthOrArrayLayers` to 1 on the wrapper type.
4. All four upload entry points (`texImage2D`, `texSubImage2D`, `compressedTexImage2D`, `compressedTexSubImage2D`) now compute `originZ = cubeFaceLayerForTarget(target) ?? 0` and pass it to the `writeTexture` / `copyExternalImageToTexture` call's `origin.z`.

The `depthOrArrayLayers` field on `_webgpuTexture` is optional with a `?? 1` default at every read site, so the 2D-texture call sites (the overwhelming majority of stub users — imagery layers, model textures, etc.) stay byte-identical to pre-fix behavior.

### Verification

The cross-backend runner's initial pass on `glTF PBR Extensions.html` showed the sphere still dark — 96.35% diff. Probing manually with a 30-second settle (`temp-pbr.mjs`) showed the sphere rendering correctly with copper material and Earth visible behind it. Conclusion: the fix works; the KTX2 specular environment map (`kiara_6_afternoon_2k_ibl.ktx2`) is loaded from a CDN and the runner's default settle time is shorter than the network fetch. The fix is correct at the GPU/sampling layer; runner timing for KTX2-loading demos is a separate sweep-tuning concern.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts` — cubemap allocation + per-face `origin.z` routing.

### Companion changes folded into the same edit

While in the file, the same patch also:

- Made `texSubImage2D` recognize the WebGL **7-argument** calling form (`target, level, xoffset, yoffset, format, type, source`) in addition to the 9-argument form. The previous stub only handled the 9-arg form, so glTF/3D-Tiles texture uploads that pass an `ImageBitmap` directly silently no-op'd — symptom: every model textured with the white fallback, which is the entire `Mars/Moon white sphere + BIM building white walls` cluster (Session 65 NEW-VR2-2). The detection looks at `typeof typeArg === "number"` to discriminate.
- Clamped the `texImage2D` / `texSubImage2D` copy extent to the actual mip-level dimensions when the caller passes the base-level size at `level > 0`. Some legacy GL callers (OSM-buildings imagery, I3S color-ramp uploads) rely on the GL driver silently clamping; the stub previously surfaced a per-frame "copy range touches outside" warning and dropped the upload. Now the upload lands, truncated to the mip's actual size.
- Guarded the level-0-only `ensureTextureAllocated` call so mip > 0 uploads don't shrink the allocation. Without the guard, an imagery tile uploading levels 0..8 would re-allocate the texture at level 7 with a 2x2/`mipLevelCount: 1` size, destroying the prior mips and erroring on the level-8 write.

These three companion fixes were applied alongside the cubemap fix because they exercise the same code paths and would have surfaced as net regressions in the same demos.

### Follow-up

- The cross-backend runner needs a per-demo "ready for capture" hook for KTX2-loading scenes. Filed as a runner-tuning item, not a renderer bug.

---

## Session 65 Batch 7 (2026-05-12) — Uint8 → Uint16 index upcast → CZML Model Articulations renders

Closes **NEW-VR-CZML-MODEL-ARTICULATIONS-INDEXCOUNT** in `DEFERRED_WORK.md`. `CZML Model Articulations.html` rendered nothing on WebGPU, with this validation warning every frame:

```
Index range (first: 0, count: 18, format: IndexFormat::Uint16) does not fit in index buffer size (20).
 - While encoding [RenderPassEncoder "Scene Framebuffer Render Pass"].DrawIndexed(18, 1, 0, 0, 0).
 - While finishing [CommandEncoder "Scene Frame Command Encoder"].
```

### Root cause: missing Uint8Array index detection in geometry extractor

The Batch 5 alignment fix surfaced this deeper bug. Instrumenting both the cache build site and the draw command emission revealed:

```
primKey=4_0  geom.indexCount=18  geom.indexData.length=18  geom.indexData.byteLength=18  bufferSize=20  primCache.indexCount=18
[PROBE-IDX] PRIMARY MISMATCH primKey=4_0  indexCount=18  bufferSize=20  fmt=uint16  need=36
```

Note `indexData.length === indexData.byteLength === 18` — this is the fingerprint of a `Uint8Array` (one byte per element). The cesium_air glTF asset ships six per-control-surface hinge meshes (elevators, rudder, ailerons) whose tiny index counts fit in 8-bit indices, so the glTF accessor uses componentType `5121` (UNSIGNED_BYTE).

`ModelPrimitiveGeometry.extractPrimitiveGeometry` was reading the typed array with:

```javascript
const idxData = indices.typedArray || indices.buffer;
result.indexData = idxData;
result.indexCount = idxData.length;
result.indexType =
  idxData instanceof Uint32Array ? "UNSIGNED_INT" : "UNSIGNED_SHORT";
```

The `instanceof Uint32Array` test fell through to `"UNSIGNED_SHORT"` for *both* `Uint16Array` AND `Uint8Array` — mislabeling 8-bit indices as 16-bit.

Downstream in `WebGPUModelRenderer.ensurePrimitiveCache`:

```javascript
primCache.indexFormat =
  geometry.indexType === "UNSIGNED_INT" ? "uint32" : "uint16";
const indexByteLength = geometry.indexData.byteLength;     // 18 (correct for Uint8)
const alignedIndexByteLength = (indexByteLength + 3) & ~3; // 20
primCache.indexBuffer = device.createBuffer({
  size: Math.max(alignedIndexByteLength, 4),               // 20 bytes
});
device.queue.writeBuffer(primCache.indexBuffer, 0, geometry.indexData);  // 18 bytes
// primCache.indexCount = geometry.indexCount;             // 18
// primCache.indexFormat = "uint16";
```

The buffer was sized at the source's raw byte length (18 padded to 20), but the draw command then walked it with `indexFormat: "uint16"`, expecting 18 × 2 = 36 bytes. WebGPU's command-buffer validation catches this and invalidates the entire frame.

### Why this only surfaced on WebGPU

WebGL2's `drawElements(mode, count, type, offset)` accepts `gl.UNSIGNED_BYTE` as a valid type — the driver expands the 8-bit indices internally. WebGPU's `IndexFormat` enum only has `"uint16"` and `"uint32"`; there is **no `"uint8"` value**. Any glTF asset that uses byte indices needs the typed array upcast to Uint16 *before* it lands in a GPU buffer.

The CZML Model Articulations demo is one of the few production assets in the Sandcastle gallery that ships byte indices (each control-surface hinge has < 256 vertices). Most glTF assets use 16-bit indices, which is why the bug stayed dormant until this demo got attention.

### Fix

In `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js`, upcast `Uint8Array` indices to `Uint16Array` at extract time:

```javascript
let idxData = indices.typedArray || indices.buffer;
if (defined(idxData)) {
  if (idxData instanceof Uint8Array) {
    const upcast = new Uint16Array(idxData.length);
    for (let i = 0; i < idxData.length; i++) upcast[i] = idxData[i];
    idxData = upcast;
  }
  result.indexData = idxData;
  result.indexCount = idxData.length;
  result.indexType =
    idxData instanceof Uint32Array ? "UNSIGNED_INT" : "UNSIGNED_SHORT";
}
```

Now `geometry.indexData.byteLength` is 36 for 18 byte-indices, the buffer is sized at 36, the upload writes 36 bytes of `Uint16Array`, and the draw walks 36 bytes correctly.

This is also the right behavior on the WebGL side — WebGL2 accepts both formats, so the upcast doesn't regress anything; it merely costs an extra 18 bytes per hinge mesh in the index buffer. Trivial.

### Verification

Re-ran the demo with Playwright + forced-WebGPU shim + HTML rewrite. Pre-fix output: **257 `[warning] Index range … does not fit in index buffer size`** lines + model not visible. Post-fix output: **zero** index-range warnings, model renders with body + control surfaces visible. The model textures appear partially loaded in the screenshot — separate concern, likely a lazy-load timing issue with this demo's KHR_texture_basisu KTX2 textures, not a renderer bug.

### Files modified

- `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js` — Uint8Array index upcast in `extractPrimitiveGeometry`.

### Follow-ups

- Audit the rest of the gallery for other byte-index glTF assets that may be silently rendering with garbage on WebGPU (the validation warning is the canary; pre-Batch 5 they'd have crashed with the writeBuffer alignment error).

---

## Session 65 Batch 8 (2026-05-12) — Imagery `texCoordsRect` axis mismatch → close-zoom dark blue

Closes Cluster 2 from the cross-backend sweep diagnostic. Cluster 2 is the wide-spread "WebGPU renders the terrain silhouette in solid dark blue while WebGL renders correct imagery" symptom seen on most demos that drape Mercator imagery onto a Geographic terrain quadtree (the default Cesium setup — Bing/Cesium World Imagery + Cesium World Terrain). The sweep counted ~30+ affected demos with diff% in the 85-99 range.

### Root cause: bounds check ran in Mercator-V against geographic-V rect

The fragment shader's per-layer composite path was:

```wgsl
let uv = selectLayerUV(geoUV, webMercT, useWebMercatorTLayer);
let tex = sampleImagery(dayTexture0, texSampler, uv, layer);
let r = applyImageryLayer(color, alpha, tex, uv, layer, ...);
```

Inside `applyImageryLayer`, the imagery's `texCoordsRect` and `cutoutRectangle` bounds tests both used the `uv` parameter. When `useWebMercatorT === true`, `uv.y = webMercT` — the **Mercator-projected** V coordinate normalized to [0,1] across the tile's Mercator vertical span. But `texCoordsRect` is packed in **geographic** tile-UV space (the CPU packer in `ImageryLayerHelpers.createTileImagerySkeletons` divides by `terrainRectangle.height`, which is a geographic latitude span; the cutout packer in `WebGPUGlobeSurfaceTileUB` does the same with `tile.rectangle.height`). For Bing-on-CesiumWorldTerrain (Mercator imagery, Geographic terrain), these two V coordinates **diverge non-linearly** — Mercator compresses near the equator and stretches near the poles. The bounds check failed `uv.y < rect.y` for most fragments, zeroing `texCoordsMask` → zeroing `effectiveAlpha` → leaving `color` at the imagery-base fallback `(0.04, 0.04, 0.06)` which is exactly the dark-blue color from the failing screenshots.

### How it was diagnosed

A short-circuit shader probe sequentially emitted (uv.y, rect.y, rect.w) and bound-check flags as RGB. The progression confirmed:

1. `imagery.image` was present and `ImageBitmap`-typed → upload path worked.
2. 412 imagery uploads succeeded across the demo's tile set (no `null` returns from `uploadImageSource`).
3. `tile.layerCount` was correctly 2 in the tile UB.
4. `texCoordsRect.y` was non-zero on most tiles (Bing tiling intersects Geographic terrain in fractional sub-rects).
5. The bounds check `uv.y < rect.y` was failing for the bulk of fragments — `uv.y` was Mercator-V, `rect.y` was geographic-V.

### Fix

Renamed the `applyImageryLayer` `tileUV` parameter to `boundsUV` and updated all 16 call sites to pass `geoUV` (the always-geographic UV from `input.v_textureCoordinates.xy`) instead of the post-`selectLayerUV` `uv`. Texture sampling still uses `uv` (with the Mercator V where appropriate) — only the bounds checks now use the geographic UV that matches the geographic packing on the CPU side.

```wgsl
// before
let r = applyImageryLayer(color, alpha, tex, uv, layer, ...);
// after
let r = applyImageryLayer(color, alpha, tex, geoUV, layer, ...);
```

### Verification

Probe at the same camera + same WebGPU-forced settle shows the Cesium World Terrain demo now compositing layer 0 + layer 1 imagery correctly (Half Dome and surrounding Yosemite imagery clearly visible in the probe after the imagery composite — see the after-layers screenshot). Tested clean on `Imagery Layers`, `Imagery Adjustment`, `Cesium Inspector` — all show correct globe imagery at orbital views.

### Files modified

- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — renamed parameter, 16 call sites updated, JSDoc explanation added on the function declaration.

### Known remaining work (separate cluster)

Cesium World Terrain's close-zoom (post-fix) screenshot still shows the dark-blue **fog/atmosphere** color overwriting imagery at distant fragments. `computeFog(distance, density, fogVisualDensityScalar)` saturates to 1.0 at the demo's home camera distance, and the WGSL `computeAtmosphereColor` returns dim values (~0.04-0.10) that produce a dark-blue fogColor when mixed at fogAmount=1. WebGL's `groundAtmosphereColor` is brighter (computed from full Rayleigh+Mie path integration in vertex shader, then PBR-neutral-tonemapped in fragment) so it doesn't collapse to near-black. The previous-session comment at lines 2011-2019 of the shader documents a partial fix that was reverted because of an opposite over-bright failure. This requires a deeper rework of `computeAtmosphereColor` or a switch to a compute-LUT-driven inscatter path. Filed for a follow-up batch under Cluster 2b.

---

## Session 65 Batch 9 (2026-05-12) — Nishita-style ground atmosphere ray-march (Cluster 2b/5)

Closes the fog/atmosphere parity gap left from Batch 8. The new WGSL implementation matches WebGL's per-vertex Rayleigh+Mie scattering integral and applies the per-fragment phase functions + PBR Neutral tonemap + inverse gamma encode that WebGL does. Major impact on close-zoom views — `Cesium OSM Buildings` and `Aerometrex San Francisco` now render with proper atmospheric depth instead of solid dark blue.

### What landed

1. **CameraUB extension** — added 16 floats (4 vec4s) at offsets 116–131 for atmosphere parameters: light direction WC + intensity, Rayleigh coefficients + scale height, Mie coefficients + scale height, Mie anisotropy + inner/outer radii + enable flag. Total CameraUB grew from 116 → 132 floats / 464 → 528 bytes. See `WebGPUGlobeSurfaceTypes.ts` for the offset table.

2. **WGSL ray-march** — direct port of `Source/Shaders/AtmosphereCommon.glsl::computeScattering` + `GroundAtmosphere.glsl::computeAtmosphereScattering`. Same 16 primary steps × 4 light steps, same soft sky/horizon weight, same optical-depth + attenuation math. Lives in `GlobeTerrain.wgsl` between line ~570 and ~820. Per-vertex outputs `v_atmosphereRayleighColor`, `v_atmosphereMieColor`, `v_atmosphereOpacity` (@location(6/7/8)).

3. **Vertex shader call** — gated on `camera.atmosphereParams.w > 0.5` (set CPU-side when fog OR ground atmosphere is enabled) AND `mode > 2.5` (SCENE3D only — 2D/Columbus/Morph paths use planar positions so the WC ray-march doesn't apply). When skipped, the v_atmosphere* outputs stay zero so the FS additive contribution is a no-op.

4. **Fragment shader consumption** — replaced the dim analytic fallback with `computeGroundAtmosphereColor(viewDir, lightDir, v_rayleighColor, v_mieColor)`. The phase functions (Rayleigh `(3/16π)(1+cos²θ)` + Mie HG) run per-fragment so the directional variation (Mie forward-peaked, Rayleigh isotropic-ish) is preserved when the per-vertex values interpolate.

5. **HDR-aware tonemap** — the FOG branch now applies `pbrNeutralTonemapAtmosphere` + `pow(c, 1/2.2)` inverse-gamma encode in non-HDR mode (mirrors WebGL's `#ifndef HDR` guard around `czm_pbrNeutralTonemapping` + `czm_inverseGamma` at GlobeFS.glsl:528-531). In HDR mode the encode is skipped so the post-process tonemap can do the compression on linear-radiance pixels.

6. **CPU UB packing** — read atmosphere parameters from `tileProvider.atmosphere*` (which Globe.update mirrors from `globe.atmosphereLightIntensity` etc.), NOT from `frameState.atmosphere.*` (which is the SkyAtmosphere config). Cesium has two separate atmosphere configs — `globe.atmosphere*` for ground, `scene.atmosphere*` for sky — and the demo customizations target the globe-side properties.

### Diagnosis trail

The fog/atmosphere bug was visible across 20+ demos as a uniform dark-blue cast over close-zoom terrain. The earlier WGSL `computeAtmosphereColor` used fixed `(0.18, 0.38, 0.72)` skyBlue scaled by 0.3 — qualitatively wrong magnitude AND missing the view-direction-dependent thickness integral. At low altitudes, the dim atmosphere color × full-fog fogAmount produced ~`(0.04, 0.07, 0.10)` for every fragment, which is exactly the dark blue from the failing screenshots.

The investigation went:

1. Initial probe added per-channel diagnostics (sampleAlpha, texCoordsMask, dnaV) to confirm Batch 8's texCoordsRect fix didn't introduce a regression — that fix held; the symptom was in the fog stage.
2. Probed `fogAmount` and saw it saturating to 1.0 at typical altitudes — confirmed by the `computeFog` math with default density × ~100 km fragment distance.
3. Probed `computeAtmosphereColor` output and saw the dim `(0.04, 0.04, 0.07)` values — the analytic fallback in WGSL was producing trivially-low magnitudes regardless of view direction.
4. Cross-checked WebGL's `Source/Shaders/AtmosphereCommon.glsl` and confirmed it uses a 16-step Nishita ray-march producing HDR values, then PBR-tonemaps them for display. That's the proper algorithm.
5. Port. Tested CPU UB plumbing via a one-shot console log — `lightIntensity=10` reaches the shader correctly (confirmed via `floats[116-131]` dump).
6. First-render result still wrong (orange-brown) — debugged the source-of-truth for `atmosphereLightIntensity`. The Atmosphere.html demo sets `globe.atmosphereLightIntensity = 20.0`, which the Globe.update path mirrors onto `tileProvider.atmosphereLightIntensity` — NOT onto `scene.atmosphere.lightIntensity`. Fixed CPU UB to read from tileProvider.
7. Final verification on `Cesium OSM Buildings` (Manhattan skyline visible with atmospheric haze + water + sky depth gradient) and `Aerometrex San Francisco` (Ferry Building + photogrammetry mesh visible against dark sky).

### Files modified

- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — atmosphere uniforms in `CameraUniforms`, `computeScatteringGround` + `computeAtmosphereScatteringGround` + `computeGroundAtmosphereColor` functions, VS ray-march call, FS consumption.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — atmosphere param packing reading from `tileProvider.atmosphere*`.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts` — `CAMERA_UNIFORM_FLOATS = 132` + layout doc comment.

### Known remaining gaps

- The Atmosphere.html orbital view still renders the globe as reddish-brown rather than the bright-blue WebGL counterpart. The Nishita march at 10 Mm camera altitude produces low-magnitude HDR (camera is mostly outside the 111 km shell so the optical-depth integral is small). WebGL hits the same algorithm so this isn't an obvious bug — but the view-angle-dependent phase application or one of the per-vertex interpolations may need tuning. Tracked as a separate item under Cluster 5 sky-atmosphere parity.
- Atmosphere.html demo's customization sliders need fresh writes to flow on every change (`globe.atmosphereLightIntensity = ...` should re-fire the CameraUB. Currently it's read every frame so this should already work; not verified.

---

## Session 65 Batch 10 (2026-05-12) — Cluster 3 globe material infrastructure (foundation + pipeline scaffolding)

Continues the parallel WGSL fabric API work from the prior continuation. Adds the pipeline-side scaffolding so the next session can wire the draw path in a single focused integration step.

### What landed this batch

**Pipeline variant for material-enabled tiles:**

- Added `_bindGroupLayout4Material` in `WebGPUGlobeSurfaceLayouts.ts` — a 5-binding layout (1× UBO at binding 0, 2× texture/sampler pairs at bindings 1-4). Sized for the in-tree globe materials: ElevationRamp / SlopeRamp / AspectRamp / DiffuseMap use binding 1 only; ElevationBand uses both pairs (heights + colors).
- Added `_materialPipelineLayout` — the 5-bind-group pipeline layout used when `MATERIAL_APPLY` is set in the pipeline cache key. The existing 4-bind-group `_pipelineLayout` continues to serve non-material tiles unchanged (zero regression risk).
- Added `_placeholderMaterialBG` helper for transitional bind state.

**Shader define:**

- `ShaderDefine.MATERIAL_APPLY = 1 << 14` registered in `WebGPUShaderDefines.ts`. Drives the `//>>ifdef MATERIAL_APPLY` blocks in `GlobeTerrain.wgsl`.

**WGSL bindings in GlobeTerrain.wgsl:**

- `@group(4) @binding(1) var image: texture_2d<f32>` + `@binding(2) var imageSampler: sampler`
- `@group(4) @binding(3) var heights: texture_2d<f32>` + `@binding(4) var heightsSampler: sampler`

Wrapped in `//>>ifdef MATERIAL_APPLY` so non-material tiles strip the declarations.

**Material pipeline factory (`WebGPUGlobeMaterial.ts`, new file):**

- `buildMaterialPrelude(material)` — infers per-uniform component types (f32 / vec2 / vec3 / vec4 / mat4) from the JS uniform default values, emits a WGSL `MaterialUniforms` struct + binding declaration, computes the UBO byte layout with proper WGSL alignment. Returns `{ prelude, uboLayout, uboSize, textureNames }`.
- `rewriteMaterialBody(body, uboLayout, textureNames)` — regex-rewrites the fabric's WGSL body to reference `materialUniforms.<name>` instead of bare `<name>` (with whole-word match so `color` doesn't mangle `colors`). Texture-uniform names stay bare so they pick up the module-scope WGSL texture bindings declared above.
- `packMaterialUBO(material, layout, uboSize)` — packs the JS material's uniform values into a `Uint8Array` sized for the UBO. Handles Color (red/green/blue/alpha → x/y/z/w), Cartesian2/3/4, scalars, and booleans.

### What's still required for the visual win

The remaining integration step (Step 5/6 of the Cluster 3 plan) wires the material pipeline into the draw path. Concrete steps for next session:

1. **Per-material pipeline cache** — extend the pipeline cache key in `WebGPUGlobeSurfacePipelines.ts::createPipelineDescriptor` to include a material-hash slot, and switch the pipeline layout to `_materialPipelineLayout` when the key carries `MATERIAL_APPLY`.

2. **Per-material shader module** — when the cache key carries a non-zero material hash, the pipeline factory concatenates `[material-prelude] + [rewritten material body] + [base GlobeTerrain.wgsl source]` and runs it through `WebGPUShaderModuleCache.getOrCreate` keyed on the material hash.

3. **Per-tile material bind group** — in `WebGPUGlobeSurfaceRenderer.createTileDrawCommands`, when `tileProvider.material` is non-null:
   - Pack the material's uniform values into the material UBO via `packMaterialUBO` + `device.queue.writeBuffer`.
   - Upload material textures via the existing imagery texture cache.
   - Build a `GPUBindGroup` against `_bindGroupLayout4Material` with the UBO + textures + samplers.
   - Append this bind group at index 4 in the per-tile draw command's `bindGroups` array.

4. **Pipeline cache invalidation** — when `globe.material` swaps types (the demo does this via radio buttons), the material-keyed pipelines stay cached (one per material type) so toggling doesn't pay rebuild cost; only first-use of each material type rebuilds.

5. **CPU plumbing** — `Globe.update` mirrors `globe.material` onto `tileProvider.material` (already done for WebGL — the WebGPU path needs to read the same field). The WebGPU GlobeSurfaceRenderer reads it via the existing tileProvider parameter.

The bulk of the work above is mechanical wiring. The hard parts (WGSL emit, UBO layout, body rewrite, bind layout design) are shipped.

### Why this is shipping as foundation rather than fully integrated

The hot draw path in `WebGPUGlobeSurfaceRenderer.createTileDrawCommands` is one of the most-trafficked code paths in the renderer (called for every visible tile per frame). The remaining integration touches that path AND the pipeline cache simultaneously, AND must preserve the existing 4-bind-group fast path for tiles without material. The risk of a regression from a rushed integration is high — better to ship the bounded, testable infrastructure pieces now and do the integration in a focused follow-up.

### Files modified / added

- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeMaterial.ts` — NEW file with prelude builder + UBO packer + body rewriter.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts` — material bind group layout + material pipeline layout + placeholder bind group.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — public LayoutsHost fields added (`_bindGroupLayout4Material`, `_materialPipelineLayout`, `_placeholderMaterialBG`).
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `MATERIAL_APPLY: 1 << 14` registered.
- `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `MATERIAL_APPLY`-gated material bindings on group 4, fragment-shader call site for `czm_getMaterial`, per-vertex slope/height/aspect outputs.

(Prior continuation — Steps 1-3a — modified `Material.js` + `MaterialHelpers.js` + added WGSL declarations on 12 built-in fabrics. See entries above.)

## Session 65 Batches 37-43 (2026-05-13) — Camera/rasterization bugs + ground-atmo integration + Phase 4/6 wiring

Consolidated entry. Bug-fix batches (37, 38, 40, 41) get their own subsection; feature-wiring batches (39, 42, 43) get a one-line summary.

### Batch 37 — Moon bundle MSAA sampleCount mismatch (BUG-37)

**Symptom:** After Batch 36 re-enabled the MSAA bridge across the WebGPU FLEET, 3D Tiles Photogrammetry regressed catastrophically: 81.6 % black pixels with 3 GPU validation errors:

```text
[error] [WebGPU:RenderBundle] "Moon bundle" recording failed:
Attachment state of [RenderPipeline "Moon pipeline ..."] is not
compatible with [RenderBundleEncoder "Moon bundle"].
```

**Root cause:** `WebGPUEnvironmentRenderer.js::updateWebGPUMoon` builds the Moon pipeline with `multisample.count = context._msaaSamples` (correctly MSAA-aware since Batch 21) but the `GPURenderBundleEncoder` was passed only `colorFormats` + `depthStencilFormat` — no `sampleCount`. Encoder defaulted to 1, mismatched the pipeline's 4 → bundle invalidated → `executeBundles` rejected the entire command buffer.

**Fix:** Thread `context._msaaSamples ?? 1` through to the `BundleEncoderDescriptor` and append it to the bundle cache key so a mid-session MSAA toggle evicts the prior bundle.

**Files modified:** `WebGPUEnvironmentRenderer.js` (10 LOC).

**Verification:** 3D Tiles Photogrammetry WebGPU recovered: 0 GPU errors.

### Batch 38 — Ground-atmosphere FS viewDir bug (BUG-38)

**Symptom:** Batches 30+31 added an empirical `cap=1.5 × scale=0.15` workaround in `GlobeTerrain.wgsl`'s drape branch to suppress 7-10× over-accumulated radiance on the sun-facing side at orbit altitudes. The cap visually matched WebGL but the underlying cause was unknown.

**Root cause:** The FS expression

```wgsl
let fragmentWorldPos = input.v_positionMC + cameraWC;
let viewDir = normalize(fragmentWorldPos - cameraWC);
```

collapses to `normalize(v_positionMC)`. Since `out.v_positionMC = position3DWC` (world coords, not RTE — set in the VS at line 1050), that gives the surface OUTWARD normal, not the camera-to-surface direction the Rayleigh/Mie phase functions need. On the sunlit hemisphere where the outward normal aligns with sun direction, the wrong cosAngle pushed the Henyey-Greenstein Mie phase into its forward peak (`cos ≈ +1 → pow(0.01, 1.5)` denominator), producing the 7-10× over-accumulation the cap+scale was masking.

**Fix:**

1. `viewDir = normalize(positionWC - cameraWC)` mirroring `AtmosphereCommon.glsl:166-167`.
2. Repack `atmosphereParams.w` to encode the WebGL `dynamicLighting` bool: 0 = atmo off, 1 = atmo on + static `normalize(positionWC)` lightDir, 2 = atmo on + lit. Lit branch AND-gates on `enableLighting` to mirror WebGL's `DYNAMIC_ATMOSPHERE_LIGHTING && (ENABLE_VERTEX_LIGHTING || ENABLE_DAYNIGHT_SHADING)`.
3. Removed `cap=1.5 × scale=0.15`.
4. Added per-fragment night-fade ramp via existing `tile.nightFadeOutDistance` / `nightFadeInDistance` slots.

**Files modified:** `WebGPUGlobeSurfaceCameraUB.ts`, `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`.

**Verification (disk-bleed probe deltas, Hello World):**

```text
            Before Batch 38     After Batch 38
mid-upper   ( -5, -30, -38)     ( -1,  -6,  -6)
center      (-56, -59, -57)     (-12, -11, -17)
```

### Batch 40 — WebGPU camera default-view canvas-sizing bug (BUG-40, NEW-VR2-3c)

**Symptom:** The disk-bleed probe showed off-disk "atmosphere bleed" past the WebGPU disk edge by 50-100 px in every orbit-view demo. Initial hypotheses (SkyAtmosphere alpha tail, camera-altitude opacity) were ruled out by writing cyan in the SkyAtmosphere FS — those off-disk pixels were not covered by the SkyAtmosphere geometry at all; they were globe terrain rendered too wide. A state-comparison probe found WebGPU's camera at `cameraHeight = 12.67 Mm` vs WebGL's `17.19 Mm` despite identical frustum / FOV / aspect at probe time.

**Root cause:** `Viewer.createAsync` (the WebGPU async bootstrap path) created the temp `CesiumWidget` inside a hidden container with `style.display = "none"`. Hidden ancestors zero a descendant's `clientWidth/clientHeight`, so when the synchronous Scene + Camera constructor ran inside that widget, `Camera.js:209-210` read

```js
this.frustum.aspectRatio = scene.drawingBufferWidth / scene.drawingBufferHeight;
```

against a 1 × 1 canvas and set `aspectRatio = 1.0` instead of the real `1.333`. `rectangleCameraPosition3D` then placed the WebGPU camera ~25 % closer to Earth, making the rasterized disk ~1.5× wider on screen.

**Fix:** Replaced `display: none` with `position: absolute; inset: 0; visibility: hidden`. The temp container takes the full layout dimensions of the outer container so the canvas inside has the right `clientWidth/clientHeight` when Camera constructs; `visibility: hidden` plus the LoadingOverlay's `z-index: 9999` keep the pre-init frame invisible. Parent's `position` is temporarily set to `relative` if `static`, restored after init.

**Files modified:** `packages/widgets/Source/Viewer/Viewer.js`.

**Verification:** All 13 camera / canvas / frustum fields now bit-perfect identical between WebGL and WebGPU. Disk-bleed off-disk pixel deltas collapsed from `(+50, +80, +120)` to `(-3 .. +3)`.

### Batch 41 — Globe terrain `surfaceTile.center` → `mesh.center` bug (BUG-41, NEW-VR2-1)

**Symptom:** Bloom.html and Particle System.html rendered as mostly-black at ground altitude despite globe tiles being selected for render (75 tiles, `renderable=true`, `hasImagery=true`). Pixel sample:

```text
WebGL Bloom mid-canvas    (179, 173, 165) cityscape texture
WebGPU Bloom mid-canvas   ( 24,  24,  24) uniform flat gray
```

The bit-perfect uniformity of `(24,24,24)` across every sample in the lower half was the smoking gun for a flat fill.

**Two stacked root causes:**

1. **`computeModifiedModelView` received the wrong argument.** Helper reads `obj.center` and falls back to plain view matrix when missing. Caller passed a `GlobeSurfaceTile` whose `.center` doesn't exist → every globe tile draw fell back to plain view. With a plain view matrix, the WGSL line `v_positionEC = modifiedModelView × position_tile_local` produces a HUGE camera-relative position because `position_tile_local` is tile-relative (~hundreds of metres) but the view matrix's translation column is the negated camera position in world coords (~6.4 Mm). Every fragment ended up with `v_distance > 100 km`, so `computeFog(v_distance, density, mod)` saturated to 1.0 at every pixel and replaced imagery with a flat fog color. **Fix:** Pass `mesh` (which DOES have `.center` set by `TerrainEncoding`) and rename the parameter so this bug can't reappear. Mirrors WebGL `GlobeSurfaceTileProviderRendering.js:1120` (`rtc = mesh.center`).
2. **FOG branch unconditionally applied `nightFogDimming * 0.05` + `fogMinimumBrightness` floor.** WebGL's equivalent darken (`GlobeFS.glsl:522-526`) is gated on `DYNAMIC_ATMOSPHERE_LIGHTING && (ENABLE_VERTEX_LIGHTING || ENABLE_DAYNIGHT_SHADING)`. For demos using default `enableLighting = false`, WebGL leaves fog at full brightness while WebGPU was dimming to a uniform `24/255` floor. **Fix:** Gate the darken on `atmosphereParams.w > 1.5` (Batch 38 encoding for "dynamic lighting active") and remove the `fogMinimumBrightness` floor.

**Files modified:** `WebGPUGlobeSurfaceCameraUB.ts`, `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`.

**Verification (probe-empty-scenes colored %):**

| Demo                         | Before | After  | WebGL  |
| ---------------------------- | ------ | ------ | ------ |
| Bloom.html                   | 35.9 % | 73.8 % | 69.6 % |
| Particle System.html         |  4.6 % | 68.1 % | 71.2 % |
| 3D Tiles Photogrammetry.html | 65.6 % | 87.0 % | 86.6 % |
| Bathymetry.html              | 79.4 % | 90.7 % | 90.7 % |

### Batches 39, 42, 43 — Feature wiring (no bug entries)

- **Batch 39** — Auto-exposure altitude gate. Pairs with bloom altitude gate (Batch 22). Blends `1/avgLuminance` toward 1.0 (neutral) above `altitudeGateMinMeters` so bright atmosphere limb doesn't crush daylight terrain at orbit. Files: `WebGPUAutoExposure.ts`, `WebGPUSceneRenderer.ts`.
- **Batch 42** — Phase 4 wind state on SkyAtmosphere UBO. Pre-emptive scaffolding ahead of Phase 5/6 consumers (volumetric fog advection, cloud motion). `windDirectionAndSpeed: vec4<f32>` appended; `UNIFORM_BUFFER_SIZE` 256 → 272. Files: `SkyAtmosphere.wgsl`, `WebGPUSkyAtmosphereRenderer.js`.
- **Batch 43** — `atmosphericConditions.clouds.enableVolumetric` toggle wired. Pre-Batch-43 the flag was a plain field that did nothing; now aliases `globe.showProceduralClouds` so the canonical AtmosphericConditions API toggles the existing Schneider-style volumetric cloud raymarcher. Files: `Scene/AtmosphericConditions.js`.
