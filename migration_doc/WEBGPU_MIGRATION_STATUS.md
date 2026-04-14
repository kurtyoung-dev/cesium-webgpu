# CesiumJS WebGPU Migration -- Consolidated Status

**Last Updated:** April 14, 2026 Session 29 (Sessions 1-28 + Typing Push: co-located .d.ts files + cast cleanup)
**Repository:** Fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) -> [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)
**Overall Progress:** ~92% of full WebGL feature parity. Globe terrain renders in production with imagery, shadows, fog, atmosphere, ocean, day/night, and clipping; all 36 feature renderers registered; 13 of 13 render passes handled; 10 Jasmine spec files; debug visualization stack complete. **2026-04-12 Session 2: massive ES6 modernization (424 files via codemod), TypeScript type-safety sweep (34 fewer `as any` casts), XSS security fix in InfoBox.js, WebGL stub Proton-style overhaul, MaterialUniformBuffer architecture (~56% memory reduction per material), and build variant infrastructure (WebGL-only / WebGPU-only / dual tree-shaken bundles).**

---

## Recent Progress (2026-04-14 Session 29 — Typing Push: co-located .d.ts + cast cleanup)

### JS↔TS boundary cast elimination

- **13 new co-located `.d.ts` files** for CesiumJS JS classes that cross into WebGPU TypeScript code: `Matrix4`, `Cartesian3`, `Color`, `EncodedCartesian3`, `BoundingRectangle` (Core); `UniformState`, `PassState`, `ShaderCache`, `PickId`, `Context`, `Texture`, `CubeMap` (Renderer); `FrameState` (Scene).
- **`as unknown as` in `Renderer/`: 57 → 19 (-67%)**. The 19 survivors are legitimate — centralized helpers in `webgpuTypeHelpers.ts`, a WIP PerformanceManager bridge, a WebGPU-specific `execute(renderPassEncoder)` protocol overload, a forward-compat probe for `GPUTextureUsage.TRANSIENT_ATTACHMENT`, and ~10 that can still be dropped in a follow-up (see `NEXT_SESSION_HANDOFF.md` § "Remaining work toward a fully well-typed codebase").
- **8 stale `@ts-expect-error` directives removed** across 4 Scene `.js` files (they became TS2578 once the `.d.ts` files fixed the underlying errors).

### Notable correctness fixes surfaced by typing work

- **`CesiumMatrix4` ambient type was a lie.** Was declared as `Float64Array & { 0..15; clone; ... }` (intersection) — but `Matrix4` is a plain ES6 class, NOT a Float64Array subclass. The intersection required casts at every JS↔TS boundary. Fixed to structural interface; Matrix4 now flows through WebGPU without casts.
- **`isDestroyed` getter-vs-method drift.** `GraphicsContext.isDestroyed` was declared as an abstract getter, but upstream `destroyObject.js` overwrites `.isDestroyed` with a `returnTrue` **function property** on destroyed objects — a getter can't be overwritten that way without a TypeError. Changed base class to `abstract isDestroyed(): boolean` and `WebGPUContext.isDestroyed` from getter → method. Latent bug fixed: any caller that routed WebGPUContext through `destroyObject()` would have crashed (no code does yet).
- **`@private` JSDoc semantic clash.** CesiumJS uses `@private` to mean "not part of the published API" (upstream doc convention, predates TS tooling). TypeScript correctly interprets `@private` as class-scoped visibility, which **broke structural subtyping** between `Context` (has `@private readPixels`) and `GraphicsContext` (has `public abstract readPixels`). Forced `as unknown as GraphicsContext` at the `ContextFactory` boundary. Fixed via `Context.d.ts` declaring `readPixels`/`readPixelsToPBO` as public. Long-term fix: `@private` → `@internal` sweep on JS methods called cross-module (see backlog).

### Accompanying narrowings

- `GraphicsContextOptions.getWebGLStub` narrowed from the banned `Function` type to a concrete signature.
- WebGPU dispatcher signatures (`WebGPUGPUSortKeysDispatcher`, `WebGPUHiZOcclusionDispatcher`) widened their `context: { device: GPUDevice }` param to match WebGPUContext's nullable `device` getter.
- Sidecar cache types (`_ssrCache`, `_cloudCache`, `_weatherCache`, `_webgpuCache`) replaced `unknown` with real interfaces via `import("...").TypeName` pattern.
- `CesiumGraphicsContext.uniformAllocator` + `_computeCommandClass` + `CesiumFeatureRenderer.RendererClass`/`_instance` typed at source, eliminating ad-hoc cast-narrowing at consumer sites.

### Build / verification

- `npx tsc --project packages/engine/tsconfig.json --noEmit`: clean (0 errors).
- `npx gulp build`: 38s (-14% from 44s baseline).
- All 272 modified files + 13 new files committed and pushed (`1842043179`).

---

## Recent Progress (2026-04-13 Session 28 — Option B Completion, TypeScript Clean Build)

### Option B Material UBO Split — Completed

All WGSL shaders and JS renderers now use the split bind group layout: group(0)=CameraUniforms, group(1)=MaterialUniforms, group(2)=Texture, group(3)=Effects. Key changes:

- **PrimitiveMatGridLit.wgsl** decomposed to match GridFlat field names
- **4 Ramp shaders** converted from monolithic `Uniforms` to `CameraUniforms` + texture at group(2)
- **17 textured material shaders** — texture bindings moved from group(1) to group(2), eliminating binding conflicts
- **WebGPUPolylineRenderer.js** fully refactored — separate camera/material buffers and bind groups, `packMaterialUniforms` deleted, material data sourced from `MaterialUniformBuffer.gpuData`
- **Billboard + Cloud collection shaders** renamed `u.` → `camera.` for consistency

### TypeScript Build — Clean (202 → 0 errors)

Full elimination of all TypeScript build errors from `packages/engine/tsconfig.json`:

- **cesium-js-types.d.ts** — zero `any` in type positions (down from 79). 60+ missing properties added across 15 interfaces. 9 new typed interfaces added.
- **WebGPUContext.ts** — 6 private fields made public for cross-renderer access, 5 dynamic rendering properties declared as typed class fields
- **FeatureRenderer interface** — added optional `update`/`execute`/`render`/`composite` methods
- **esbuild errors** — 15+ missing `async` keywords and 3 setter signature fixes across 13 codemod-affected files
- **CLAUDE.md** — added `any` ban rule for all TypeScript code

### Build Status

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `npx tsc --project packages/engine/tsconfig.json --noEmit` | 0 errors |
| `npx gulp build` | Clean (35s) |

---

## Recent Progress (2026-04-12 Session 2 — ES6 Modernization, TypeScript, Security, WebGL Stubs, MaterialUniformBuffer, Build Variants)

### ES6 Modernization — Massive Batch (424 files)

- **jscodeshift codemod** (`scripts/codemod-es6-class.cjs`): 424 files converted from `var X = function() {}` + `X.prototype.*` patterns to ES6 `class` syntax in a single automated pass. Files that were already ES6 or contained non-trivial inheritance were left untouched by the codemod and handled manually where needed.
- **`.includes()` migration**: All `.indexOf()` comparison patterns replaced across the codebase (~90 patterns reduced to 0). Pattern `arr.indexOf(x) !== -1` → `arr.includes(x)` / `arr.indexOf(x) === -1` → `!arr.includes(x)`.
- **urijs removed**: All 12 source files that imported `urijs` migrated to the native `URL` API. The `urijs` dependency dropped from `package.json`.
- **karma-ie-launcher removed**: Dead IE-targeting dev dependency removed from `package.json`.
- **Remaining `var` declarations**: 3 remaining occurrences confirmed as comments-only or third-party code — zero actionable changes needed.

### TypeScript Type Safety Sweep

- **NEW** `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` — ambient declaration file providing proper types for 20+ CesiumJS JavaScript classes: `FrameState`, `UniformState`, `DrawCommand`, `Scene`, `Globe`, `FrustumCommands`, `PassState`, `ShaderCache`, `RenderState`, `Camera`, `Context`, `BoundingRectangle`, `Cartesian2/3/4`, `Matrix3/4`, `Quaternion`, plus opaque branded types for GPU resource handles (avoids `as any` at GPU boundaries).
- **`as any` cast reduction** (66 → 32, net -34):
  - `WebGPUSceneRenderer.ts`: 46 → 3 (declared missing private fields: `_renderBundleEncoder`, `_currentPassEncoder`, `_sceneFramebuffer`, `_globeDepth`, `_pickFramebuffer`, scene/context handles)
  - `WebGPUGlobeSurfaceRenderer.ts`: remaining casts replaced with proper ambient types via the new `.d.ts` file
- **`: any` parameter annotation reduction** (~55 annotations replaced):
  - `WebGPUBufferPrimitiveRenderer.ts`: 30 → 17 `: any` annotations
  - `WebGPUPickFramebuffer.ts`: 9 → 1 `: any` annotations
  - Remaining reductions spread across renderer files via automated codemod pass + manual review

### Security Fix — XSS Sanitization

- **`InfoBox.js`**: Added DOMPurify sanitization for entity description `innerHTML`. Entity descriptions sourced from external data (KML, GeoJSON, CZML, user-defined) were previously injected raw into the DOM. Now sanitized via `DOMPurify.sanitize(description, { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] })` before assignment.
- **`Credit.js`**: Audited — already sanitized by existing upstream logic. No action needed.

### WebGL Compatibility Stubs — Proton-Style Overhaul

Full rewrite of the WebGL stub layer so CesiumJS WebGL code paths that run inside the WebGPU context produce real GPU work instead of silently no-opping:

- **`WebGLStubTexture.ts`** (full rewrite): `createTexture()` allocates a real `GPUTexture` via the context device. `texImage2D()` performs real WebGL→WebGPU format translation and uploads pixels. `texParameteri()` maps WebGL filter/wrap constants to `GPUSamplerDescriptor`. `pixelStorei()` tracks `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`. `generateMipmap()` dispatches through the real `WebGPUMipmapGenerator`.
- **`WebGLStubShader.ts`** (extended): `getParameter()` now returns real values sourced from `device.limits` for all limit parameters (max texture size, max uniform block size, etc.). `getExtension()` returns populated stubs for 15 common WebGL extensions (`OES_texture_float`, `EXT_color_buffer_float`, `WEBGL_depth_texture`, `EXT_disjoint_timer_query_webgl2`, etc.) so feature-detection code in CesiumJS materials and terrain paths behaves as expected.
- **`WebGLStubPipelineState.ts`** (extended): Full stencil state tracking added — `stencilFunc`, `stencilOp`, `stencilMask`, `stencilFuncSeparate`, `stencilOpSeparate`, `stencilMaskSeparate` all update an internal stencil state object that feeds into pipeline descriptor generation.
- **NEW `WebGLStateConverters.ts`**: Shared mapping functions extracted from the stubs: `webglFormatToGPUFormat()`, `webglFilterToGPUFilter()`, `webglWrapToGPUWrap()`, `webglBlendToGPUBlend()`, `webglCompareToGPUCompare()`. Centralizes all WebGL→WebGPU constant translation so the stub files stay clean.

### MaterialUniformBuffer — New Material Architecture

Zero-copy, Float32Array-backed uniform storage with auto-layout, replacing the old per-property JS object approach for WebGPU material uploads:

- **NEW `packages/engine/Source/Scene/MaterialUniformBuffer.js`**: `Float32Array`-backed storage with automatic std140-compatible layout inference. Dirty tracking (per-property `_dirty` flags + global `_anyDirty`). Scratch-based zero-allocation reads via `getScalar()` / `getVec2()` / `getVec3()` / `getVec4()`. Backward-compatible facade — existing `material.uniforms.color = ...` assignments continue to work via property setter proxies.
- **`Material.js`** wired via `MaterialHelpers.js` `initializeMaterial()` — the existing material construction path now also allocates a `MaterialUniformBuffer` when `isWebGPU` is detected.
- **`WebGPUPrimitiveCommands.js`** fast path: `uploadMaterialUniforms()` checks for `command.material._uniformBuffer._anyDirty`, uploads only changed regions via `device.queue.writeBuffer(buffer, byteOffset, data, dataOffset, size)`, and clears dirty flags. Skips per-property packing entirely for static materials. **~56% memory reduction per material** (Float32Array vs per-property JS heap), **~93% CPU reduction for static scenes** (zero JS work when no property changed).

### Build Variants — Infrastructure (Partial)

The tree-shaking build variant system is now wired end-to-end for all three output targets:

- **NEW `scripts/bundleVariantPlugin.js`**: esbuild plugin that intercepts `onResolve` for `Renderer/WebGPU/*` imports (WebGL-only build) and `Renderer/Context.js` / `Renderer/WebGLStub*` imports (WebGPU-only build), replacing them with synthetic empty-stub modules. Decision cache avoids redundant resolution. Handles both absolute and package-relative import forms.
- **`RendererType.ts`** extended: `setGlobalDefaultRenderer(type: RendererType)` / `getGlobalDefaultRenderer(): RendererType` static functions added. Each variant's entry barrel calls `setGlobalDefaultRenderer` at module init so the runtime default matches the build target. Users override per-Viewer via `contextOptions.renderer`.
- **`gulpfile.js`** extended: Added `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildCesiumDual`, and `buildAllVariants` tasks. Each wires through `createCesiumJs()` and `bundleCesiumJs()` with the appropriate variant parameter.
- **`scripts/build.js`** extended: `createCesiumJs(options)` and `bundleCesiumJs(options)` now accept a `variant` parameter (`"webgl-only" | "webgpu-only" | "dual"`). The variant activates the `bundleVariantPlugin` with the correct alias set and sets `CESIUM_BUILD_VARIANT` define for downstream conditional code.

**Output directories for variant builds:**
- `Build/CesiumWebGPUUnminified/` — WebGPU-only (~32% smaller ESM, GLSL shaders aliased to empty stubs)
- `Build/CesiumWebGLUnminified/` — WebGL-only (WebGPU renderer aliased to empty stubs)
- `Build/CesiumUnminified/` — dual (default, backwards-compatible, ESM code-split)

---

## Recent Progress (2026-04-12 — Phase 5 + HDR Parity)

### Phase 5 Modern WebGPU Features

Three WGF items implemented with independent review + review-driven fixes:

| WGF | Feature | Scope | Activation |
| --- | --- | --- | --- |
| WGF-4 | Camera UBO RTE assertions | `WebGPURTEAssertions.ts` — round-trip + MV-zeroed checks in 3 packers | Always on in debug builds (pragma-guarded) |
| WGF-1 | Hardware clip distances | Globe terrain pipeline variant via source injection + `WebGPUClipDistancePrecompute.ts` | `context.useHardwareClipDistances = true` (SCENE3D + union mode only) |
| WGF-3 | shader-f16 tonemapping | `Tonemapping_f16.wgsl` — all 5 operators in half precision | `context.useShaderF16 = true` |

Supporting changes: EffectsUniforms extended to 240 bytes (all 5 inline definitions synced), effects BGL binding 0 now VERTEX\|FRAGMENT visible, worker feature flag replication via `MSG_SET_FEATURE_FLAGS`.

### HDR Pipeline

- **Bug fixed:** post-process ping-pong textures now use `rgba16float` when `highDynamicRange=true` (was always `bgra8unorm`, silently clamping HDR to [0,1])
- **Stage format fix:** all stage pipelines target `_intermediateFormat` (not `canvasFormat`) so fragment output format matches render attachment
- **Auto-exposure:** two-pass compute shader (`AutoExposure.wgsl` + `WebGPUAutoExposure.ts`) — parallel 16×16 tile reduction → temporal smoothing → feeds tonemapping exposure uniform. Auto-added when HDR is on.
- **WebGL HDR:** already fully implemented upstream (GlobeDepth.js, PostProcessStageCollection, EXT_color_buffer_float). No new code needed.

### Bug Fixes

- **OPEN-5 (fog):** `computeFog()` now uses the 3-parameter formula with `fogVisualDensityScalar` (default 0.15), matching WebGL's `czm_fog` modifier. Was ~6.7x too strong at horizontal viewing angles.
- **OPEN-1 (sky atmo):** added try/catch + `_pipelineFailed` latch around pipeline creation to prevent infinite retry on shader compile failure.
- **BUG-6.1, BUG-38, BUG-39:** documented mitigation/guard status in debugging log.

---

## Recent Progress (2026-04-11 — Renderer Threading Sweep)

This section summarizes the work that landed on top of the 2026-04-09
celestial / phase-1 work. Full design doc:
[OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). Debug
workflow guide: top of [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md).

### Per-renderer FPS measurement

Replaces the legacy "recent average" FPS counter with a continuous
60-second rolling histogram and a Canvas2D HUD overlay component. Two
new files in `Source/Services/`:

- **`PerformanceTracker.js` (extended)** — added `recordFrame()`
  (called every frame from `Scene.render()`, ~50 ns hot-path cost on
  a preallocated 4096-slot Float32 circular buffer, zero per-frame
  GC), `getLiveStats(windowSeconds = 60)` returning average + 1% low
  + 1% high FPS over the rolling window, `getLiveFrameTimeSnapshot(n)`
  for graph rendering, and `resetLiveStats()` for operator forget. The
  existing trace API (`beginTrace` / `endTrace`) is unchanged and
  independent — both can run at once.

- **`FpsOverlay.js` (new)** — Canvas2D HUD that draws an
  absolutely-positioned panel inside any DOM container. Header shows
  label + average fps + frame ms. Body shows a 60-second rolling
  graph (red bars for frames over the budget, smoothed y-axis so the
  scale doesn't jitter). Footer shows 1% low + 1% high + sample count.
  Polls at 6 Hz. Pluggable `dataSource` — works against
  `scene.performanceTracker` directly OR a `WorkerSceneHost` (same
  contract).

### Per-renderer worker hosts (Option C of the threading research)

Multi-threaded renderers via `OffscreenCanvas` + DedicatedWorker, with
each renderer running in its own worker thread. Each host owns one
worker; multiple hosts can coexist on the same page (split-screen,
multi-view, dashboards).

Three new files in `Source/Services/` and one in `Source/Workers/`:

- **`WorkerSceneProtocol.js`** — message-type constants + heartbeat /
  restart / burst-window / stats-interval tunables. Both sides import
  from here, neither imports the other (no circular deps).
- **`WorkerSceneHost.js`** — main-thread wrapper. Owns the parent
  `<div>`, manages the child `<canvas>` lifecycle, transfers
  `OffscreenCanvas` to the worker, runs the heartbeat loop,
  implements 3-tier crash recovery, exposes the `getLiveStats()` /
  `getLiveFrameTimeSnapshot()` contract so an `FpsOverlay` can use
  the host as its data source unmodified.
- **`Source/Workers/RendererWorker.js`** — worker-thread bootstrap.
  Receives the OffscreenCanvas, dynamic-imports `@cesium/engine`
  (esbuild code-splits the engine into a 7.9 MB sibling chunk
  loaded on first message), constructs an empty `Scene`, runs its
  own render loop, posts FPS stats every 125 ms, echoes heartbeats.
  Bundled to `Build/CesiumUnminified/Workers/RendererWorker.js`
  (~11 KB tiny bootstrap).

### 3-tier crash recovery

The worker host detects three classes of failure and recovers
automatically:

| Tier | Trigger | Action | Recovery time |
|---|---|---|---|
| **1 — in-thread** | GPU device lost | `WebGPUDeviceLossRecovery` callback fires; recovery happens inside the worker; host posts `MSG_DEVICE_LOST` then `MSG_DEVICE_RESTORED` so the application can flash a UI indicator | ~100-500 ms |
| **2 — soft reset** | Reserved (no host trigger today; `MSG_RESET` constants in place for future use) | Worker tears down its Scene and asks the host to replay shadow state | N/A |
| **3 — hard restart** | `worker.error` event, `messageerror`, or 3 missed heartbeat pongs (~3 seconds) | Host terminates the worker, destroys the dead `<canvas>` (because `transferControlToOffscreen` is one-time), creates a fresh `<canvas>` inside the parent, spawns a new worker, replays shadow state (camera setView, requestRenderMode, maxFps) | ~1-2 s |

**Circuit breaker**: more than 3 crashes within 60 seconds opens the
breaker — the host stops auto-restarting and fires `onFailure`. The
application is responsible for surfacing the hard error to the user.
Prevents infinite-loop crashes from burning CPU.

### Scene/CreditDisplay headless mode (the worker DOM blocker fix)

The deep review found that `Scene` constructor at
[Scene.js:192](packages/engine/Source/Scene/Scene.js#L192) called
`document.createElement("div")` and `canvas.parentNode.appendChild(...)`,
both of which throw in a worker. Patched in three places (zero
behavioral change for main-thread Viewers):

- **`Scene.js`** — detects `typeof document === "undefined" || !canvas.parentNode`
  at constructor time and passes a sentinel `{}` to CreditDisplay
  instead of building a DOM div. The destroy path also skips
  `parentNode.removeChild` in headless mode.
- **`CreditDisplay.js`** — detects `typeof document === "undefined"`
  at the top of its constructor, sets `_headless = true`, skips all
  DOM construction. Internal credit-accumulation state still
  initializes so `beginFrame` / `addCreditToNextFrame` /
  `addStaticCredit` work unchanged. The DOM-touching methods
  (`showLightbox`, `hideLightbox`, `update`, `endFrame`, `destroy`)
  early-return when `_headless`.
- **`RendererWorker.js`** — used to fail-fast at init with a clear
  error message. The fail-fast was removed once the headless path was
  in place.

This unblocks Phase 1 of the [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md)
plan. The worker can now construct an empty Scene against an
OffscreenCanvas. Globe / imagery / terrain / entities are NOT
auto-added — those flow through the protocol messages and require
the Phase 2-7 work documented in the Option B doc to be wired.

### Cross-browser worker render loop

`requestAnimationFrame` is exposed on `DedicatedWorkerGlobalScope` in
Chromium-based browsers since v69, but **NOT in Firefox or Safari**
workers as of 2026. Fix in
[`RendererWorker.js _startRenderLoop`](packages/engine/Source/Workers/RendererWorker.js):
feature-detect at startup; fall back to `setTimeout(tick, 1000/60)`
when missing. Documented as a known limitation (~60 Hz approximation,
not vsync-locked, sub-millisecond jitter).

### maxFps runtime cap (with five operating modes)

`WorkerSceneHost.setMaxFps(value)` exposes a runtime knob with five
distinct modes. Equivalent to upstream `CesiumWidget.targetFrameRate`
for the in-thread case, with two extra modes the upstream API
doesn't support:

| Value | Behavior | Use case |
|---|---|---|
| `null` / `undefined` (default) | rAF in Chromium → display refresh rate (60/120/144/240). setTimeout fallback at 60 in Firefox/Safari. | Normal operation. Same as `targetFrameRate = undefined` upstream. |
| Positive number (e.g. `30`, `60`, `120`) | rAF if available, but skips callbacks that arrive less than `1000/value` ms after the previous render. setTimeout fallback uses `1000/value` directly. Effective rate = `min(displayHz, value)`. | Power saving, mobile battery, matching app frame rate to a video. |
| `0` (uncapped) | Bypasses `requestAnimationFrame` entirely; uses `setTimeout(tick, 0)`. Workers don't have the 4 ms hidden-tab clamp. | Benchmarking the renderer's pure throughput without vsync ceiling. |
| Negative number (e.g. `-1`) | Render loop pauses; the next non-negative `setMaxFps` resumes it. Loop handle is released so no CPU is spent while paused. | Power-saving idle, snapshot mode integration, freezing GPU state for debug snapshots. |
| Anything else (`NaN`, strings, objects) | Coerced to `null` with a warning. | Defensive — mistyped console commands can't wedge the loop. |

The cap is recorded in the host's shadow state and replayed after
every worker restart, so the new worker's first frame already runs at
the user-requested rate.

### Test page

`Apps/WebGPUTest/worker-renderers.html` — multi-pane grid (auto-sizing
1-16 panes). Toolbar:

- "+ WebGPU pane" / "+ WebGL pane" — spawn a new worker host
- "Clear all" — destroy every host
- FPS cap dropdown — vsync / 30 / 60 / 120 / 144 / 240 / uncapped /
  paused, applies to every existing AND newly-spawned pane
- "Crash first worker" — manually terminates the worker so you can
  watch the heartbeat detect the death and run hard-restart

Each pane has its own `FpsOverlay` reading from its host. Console
helpers (`window.setMaxFps`, `window.setPaneMaxFps`,
`window.listPanes`) mirror the toolbar so you can drive the panes
from dev tools.

### Type-check + build status

- `npx tsc --noEmit` — clean
- `npx gulp build` — clean in 41 s
- New worker bundle at `Build/CesiumUnminified/Workers/RendererWorker.js`
  is 11 KB; the engine code is split into a 7.9 MB sibling chunk
  (`./.-XXXXX.js`) loaded on first message via dynamic import

---

## Recent Progress (2026-04-09 — Phase 0 + Phase 1.1 / 1.2)

This section summarizes the work that landed between the original "Sessions 1-26" status and today. For the design rationale see `SESSION_2026-04-08_RESEARCH_REPORT.md` and `CELESTIAL_ATMOSPHERE_DESIGN.md`. For implementation specifics see this file's later sections and `WEBGPU_DEBUGGING_LOG.md`.

### Phase 0 — Foundation (8 sub-phases, all completed 2026-04-08 / 04-09)

**Goal:** introduce all foundation surfaces that Phase 1+ celestial and water work need to register against, with **zero behavior change** for existing upstream Cesium APIs.

**Sub-phases (all completed):**

- **0.1** ✅ Toggle audit — 97 properties across 11 surfaces inventoried (audit report)
- **0.2** ✅ Canonical home shape design — Option A unified scattering, weather branch, leaf naming (design doc)
- **0.3** ✅ `AtmosphericConditions` + `GlobeWater` facade classes with delegating shells → new surfaces `scene.globe.atmosphericConditions.*` and `scene.globe.water.*`
- **0.3a** ✅ `WATER_RENDERING_DESIGN.md` §5 namespace migration `scene.water.*` → `scene.globe.water.*` (doc-only)
- **0.4** ✅ `VisualPerformanceTargetService` skeleton + Scene wiring → new surface `scene.visualPerformanceTarget`
- **0.5** ✅ 3D Tiles Live Invalidation Feed Phase 1 — real producer fixture parsed, 4 path encodings, snapshot version hook, JSON-block-stream parser → new surfaces `Cesium3DTilesInvalidationFeed`, `TilePathEncoding` enum, `Scene._snapshotVersion`
- **0.6** ✅ NEW-5 spec re-verification — C4/C8/C11/C12 verified live, 3 small refinements captured (doc-only)
- **0.7** ✅ Snapshot mode spike — memo + `SnapshotModeService` registration skeleton with `_snapshotVersion` reconciliation → new surface `scene.snapshotMode`

**Files added in Phase 0:** `AtmosphericConditions.js`, `GlobeWater.js`, `VisualPerformanceTargetService.js`, `SnapshotModeService.js`, `Cesium3DTilesInvalidationFeedAdapter.js`, `ProducerListenerAdapter.js`, `Cesium3DTilesInvalidationFeed.js`, `TilePathEncoding.js`, `TilePathResolver.js`, `SNAPSHOT_MODE_SPIKE_2026-04-09.md`, `Specs/Data/Cesium3DTiles/InvalidationFeed/listener_invalidations_25.2.txt` (real producer fixture). New top-level dir `packages/engine/Source/Services/`.

**Behavior change:** zero. Every existing API still works; all opt-in surfaces default disabled. `npx tsc --noEmit` clean throughout.

### Phase 1.1 — Celestial toggle scaffolding (completed 2026-04-09)

- Added 5 new fields to `FrameState`: `atmosphericConditions`, `skyBrightness`, `sunDirectionWC`, `moonDirectionWC`, `moonPhaseFraction`
- `Scene.js` now forwards `scene.globe.atmosphericConditions` onto `frameState` once per frame, alongside the existing `scene.atmosphere` forwarding
- B-series locked defaults verified (sun + moon lighting on, earthshine off, volumetric fog off, varying density off, scattering occlusion off, volumetric clouds off, star modulation `inflection: 0.5` / `steepness: 1.0`, cloud volumetrics 50/100km cutover)
- Renderers now have a stable read surface for B-series toggles via `frameState.atmosphericConditions.*`

### Phase 1.2 — Sun + Moon Sync (completed in three rounds: 1.2a + 1.2b + 1.2c v2, 2026-04-09)

#### 1.2a — Sync data (small new files + frameState population)

- **NEW** `MoonLight.js` — marker class mirroring `SunLight` per locked B14/B2 (not a `DirectionalLight` subclass — opt-in via `scene.light = new MoonLight()`)
- **MODIFIED** `Moon.js` — `update(frameState)` now populates `frameState.moonDirectionWC` from the existing Simon 1994 ephemeris and computes `moonPhaseFraction = 0.5 * (1 - cos(angle(moonDir, sunDir)))` gated on `atmosphericConditions.lighting.enableMoonPhase`
- **MODIFIED** `Scene.js` — populates `frameState.sunDirectionWC` from `uniformState.sunDirectionWC` once per frame

#### 1.2b — Phong lighting + log depth + onlySunLighting + real texture loading + shader extraction

- **NEW** `Shaders/WebGPU/Environment/Moon.wgsl` — extracted from a 60-line inline template literal in `WebGPUEnvironmentRenderer.js`. Source is now a proper `.wgsl` file matching project conventions. `Moon.js` wrapper hand-written (gitignored, regenerated by `gulp build`'s `wgslToJavaScript` step).
- **Real moon texture loading** via `Resource.fetchImage()` + `WebGPUImageUpload.uploadImageToTexture()` — fixes the regression where every WebGPU user saw a 4×4 gray placeholder. Cached, async, retries-once-then-warns on failure, detects URL changes at runtime.
- **Phong lighting** (Lambert diffuse + specular)
- **`onlySunLighting` toggle** honored — picks `sunDirEC` vs `sceneLightDirEC` (matches WebGL `#ifdef ONLY_SUN_LIGHTING`)
- **Log depth write** via `@builtin(frag_depth)` (`log2(1+w) / log2(1+far)`)
- **Earthshine** + **phase gating** (already had stubs from earlier; now wired to atmosphericConditions toggles)

#### 1.2c v2 — Full WebGL parity port (the "skipped items" + Phase 0 leverage)

After an audit revealed the WebGL moon uses **bounding-cube rasterization + analytic ray-march** (not a tessellated UV sphere as I'd assumed), the moon shader was rewritten to match WebGL's geometry approach exactly, plus fork-built improvements:

**Parity items closed:**

- **Bounding-cube rasterization** (8 verts, 36 indices) — matches WebGL `EllipsoidPrimitive` `BoxGeometry.fromDimensions({2,2,2})` exactly. Cube screen footprint scales with the moon's actual size; full-screen quad approach that the first 1.2c attempt used was 100x more expensive at typical viewing distances.
- **Analytic ray-ellipsoid intersection** in moon model space (matches `EllipsoidFS.glsl`)
- **Geodetic surface normal** via `position * oneOverRadiiSq` gradient — analytic, accounts for moon's mild oblateness (1738/1738/1736 km)
- **Back-face / inside pass** with outside-then-inside compositing matching `EllipsoidFS.glsl`'s `outsideFaceColor`/`insideFaceColor` mix (only matters when camera is inside the moon — unreachable in normal use, but matches WebGL bit-for-bit)
- **CsmMaterial-style filling** — texture sample becomes the diffuse channel of a `CsmMaterial`-shaped local; Phong runs through that. Matches `Material.fromType(Material.ImageType)` semantics from the WebGL path.

**Improvements beyond WebGL parity (Phase 0 leverage):**

- **RTE 64-bit precision** in the VS — WebGL's `EllipsoidVS.glsl` uses single-precision `radii * position`. Our VS RTE-encodes the moon center via `(moonH, moonL)` and the camera split via `(camH, camL)`, then sums in single precision per project rule. Costs nothing.
- **Exact log depth** via VS-output clip-space `w` (no approximation)
- **Render bundle pre-encoding** via `WebGPURenderBundleManager.getOrCreate()`. The pipeline + bind group + draw sequence is identical every frame; we cache the encoded `GPURenderBundle` and replay it via `passEncoder.executeBundles([bundle])` from a new fast path in `WebGPUDrawCommand.execute()`. Bundle invalidates on bind group change (texture upgrade). Moon is the **first real consumer** of `WebGPURenderBundleManager`.
- **Snapshot mode freezable registration** — moon registers itself with `scene.snapshotMode` so when snapshot mode is active, per-frame uniform writes become a no-op and the bundle replays the frozen uniforms. Moon is the **first real consumer** of `SnapshotModeService`.
- **Behind-camera early-out** — `dot(cameraToMoon, cameraDirWC) < -maxRadius` skips the entire draw command before any GPU work
- **`WebGPUDrawCommand.bundle` field added** — 5-line addition that lets any draw command opt into bundle replay. Future renderers (sun, sky atmosphere, custom static-pipeline content) can register against the same surface trivially.

### Phase 1.3a — CPU sky brightness estimator (completed 2026-04-09)

- **NEW** `Scene/SkyBrightness.js` — pure helper. `computeSkyBrightness(sunDirWC, moonDirWC, moonPhaseFraction, cameraPositionWC)` returns a 0..1 scalar driven by sun altitude (smoothstep -0.1..+0.4 over the local horizon) and moon altitude scaled by phase fraction (~4% of full sun for full moon overhead).
- **MODIFIED** `Scene.js` — `updateFrameState()` now writes `frameState.skyBrightness` immediately after forwarding `sunDirectionWC`. Uses last frame's `moonDirectionWC` (still on `frameState` from the prior `Moon.update()` call) — visually indistinguishable from current value at any reasonable simulation rate, avoids duplicating the Simon 1994 ephemeris computation.
- **NEW** `Specs/Scene/SkyBrightnessSpec.js` — 8 specs: sun overhead → 1.0, antisun no-moon → 0, full moon overhead at night → ~0.04, phase scaling, twilight monotonicity, degenerate camera handling, clamping.

### Phase 1.3b — Star modulation in cubemap panorama (completed 2026-04-09)

- **MODIFIED** `Shaders/WebGPU/CubeMapPanorama.wgsl` (canonical source) — added `starModulation: vec4<f32>` uniform (offset 208, 16 bytes; total UBO 224 bytes still under the 256-byte alignment). Fragment shader applies `1.0 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))` to the sampled cubemap color when the enable flag is set.
- **MODIFIED** `WebGPUCubeMapPanoramaRenderer.js` — inline `CUBEMAP_PANORAMA_WGSL` (the production path) updated identically. `updateUniforms()` packs `frameState.skyBrightness` into `params.w` and `(curve.inflection, curve.steepness, enableFlag)` into the new `starModulation` slot. Defaults to `enableModulation = true` when `atmosphericConditions.skyAtmosphere.enableStarBrightnessModulation` is undefined or true.
- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildSkyAtmosphere()` adds two new fields to the leaf: `enableStarBrightnessModulation: true` and `enableNightSkyDimming: true`. Apps that want the legacy "always full brightness" behavior set these to false.
- Renderers/scene code can now read `frameState.skyBrightness` to drive any other "is it dark out?" decision; the cubemap shader is the first consumer.

### Phase 1.3c — Dual-light atmosphere LUT (completed 2026-04-09)

The atmosphere LUT pipeline now bakes a SECOND inscatter+transmittance pair for the moon, so the sky atmosphere fragment shader can sum dual-light scattering with one extra texture sample on the LUT path. The moon contribution is scaled by `moonPhaseFraction × moonIntensity`, defaulting to 0.05 (~5% of full sun) at full moon — visible as a gentle blue glow on the night sky without overpowering the sun's daytime contribution.

- **MODIFIED** `WebGPUPerformanceManager.ts` — `_atmosphereLutResources` now holds parallel `transmittance/inscatter/paramsBuffer/paramsData/bindGroup` slots for both sun and moon. New `_moonAtmosphereLUTDirty` flag plus `invalidateMoonAtmosphereLUT()` / `shouldRecomputeMoonAtmosphereLUT()` accessors mirror the sun side. `ensureAtmosphereLUTResources()` allocates BOTH pairs in one shot (~256 KB total). `dispatchAtmosphereLUT()` gains a `target: "sun" | "moon"` parameter and routes to the matching params buffer / textures / bind group; both lights share the bind group layout.
- **MODIFIED** `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — added `moonDirectionWC: vec3` + `dualLightControl: vec4` fields to the Uniforms struct (UBO grew 224→256 bytes, fully utilizing the 256-byte alignment). Two new bind group entries: `moonTransmittanceLut` at `@binding(3)` and `moonInscatterLut` at `@binding(4)`. `sampleScatteringLut` is now parameterized on `inscatterTex` so the same helper handles both lights. The fragment shader's LUT path samples the moon LUT and adds it to the sun result when `dualLightControl.x > 0.5 && dualLightControl.y > 0.001`.
- **MODIFIED** `WebGPUSkyAtmosphereRenderer.js` —
  - Bind group layout extended to 5 entries (sampler + 4 textures); placeholder bind group binds the same 1×1 zero texture to all four LUT slots so the layout stays constant when compute is unavailable.
  - Real bind group cache includes `lutMoonTransmittanceView` / `lutMoonInscatterView` and rebuilds when either of the four views changes.
  - Moon direction tracked alongside sun via the same threshold-gated invalidation pattern (`dot < 0.9999` triggers `invalidateMoonAtmosphereLUT()`); only active when `enableDualLightAtmosphere` is on AND `frameState.moonDirectionWC` is populated (skipped on the very first frame before `Moon.update()` runs).
  - Sun + moon dispatches batched into the same one-shot encoder to avoid an extra `device.queue.submit()` per frame when both LUTs are dirty.
  - `packUniforms()` writes `moonDirectionWC` (offset 56) and `dualLightControl` (offset 60) using `frameState.moonDirectionWC` / `moonPhaseFraction` and the new `enableDualLightAtmosphere` / `moonIntensity` fields on `atmosphericConditions.lighting`. Falls back to a `(0,0,1)` moon direction stand-in when the moon hasn't ticked yet so the shader never sees uninitialised data.
- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildLighting()` adds `enableDualLightAtmosphere: true` and `moonIntensity: 0.05` to the lighting leaf. Apps can disable dual-light scattering or tune the moon intensity per scene without touching shader code.

**Behavior change:** zero on the day side (sun term unchanged at full intensity, moon contribution scaled to ~0% in daylight). On the night side, full-moon-overhead frames now show a gentle blue scattered glow; new moon shows none (gated by `moonPhaseFraction`). All four `tsc --noEmit` checkpoints clean across the four-file change.

### Phase 1.4 — AtmosphericConditions consumers (completed 2026-04-09)

The closing piece of the 1.x feature branch wires three weather state scalars from `atmosphericConditions.weather` into the existing sky/fog/star renderers. Defaults are picked so the change is invisible until an app starts setting them — no behavior change for any existing scene.

- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildWeather()` adds three new fields to the weather leaf:
  - `humidity: 0.5` (plain scalar; 0=dry desert, 1=tropical jungle)
  - `airQuality: 1.0` (plain scalar; 1=clean, <1=dust/haze, >1=very clean)
  - `cloudCover` (delegating getter/setter over `globe.cloudCoverage` so the procedural cloud renderer and the star occlusion path stay in sync — single source of truth)
- **MODIFIED** `Shaders/WebGPU/CubeMapPanorama.wgsl` + inline `CUBEMAP_PANORAMA_WGSL` in `WebGPUCubeMapPanoramaRenderer.js` — `starModulation.w` (formerly `_pad`) now carries `cloudCover`. Fragment shader multiplies the modulated star color by `(1 - cloudCover)` so a fully overcast sky hides stars completely without requiring a separate occlusion pass.
- **MODIFIED** `WebGPUCubeMapPanoramaRenderer.js` `updateUniforms()` — reads `frameState.atmosphericConditions.weather.cloudCover` and writes it to `uniformData[55]`. Defaults to `0` (clear sky) when no globe / weather is wired up.
- **MODIFIED** `WebGPUGlobeSurfaceRenderer.ts` tile uniform packing — fog density is multiplied by `(0.5 + humidity)` before being written to the tile UB. Centered on humidity=0.5 producing 1.0× (no change), 0.0 producing 0.5× (very dry), 1.0 producing 1.5× (humid haze). Linear and bounded so existing fog tuning stays predictable.
- **MODIFIED** `WebGPUSkyAtmosphereRenderer.js` LUT dispatch path:
  - `humidity` scales the Mie coefficient via `(0.5 + humidity)` before being passed to `dispatchAtmosphereLUT()`. Same range and centering as fog density.
  - `airQuality` scales the Rayleigh coefficient via `1.0 / airQuality`. Higher airQuality → less Rayleigh → less blue (cleaner-looking sky); lower airQuality → more Rayleigh → washed-out dusty look.
  - **Cache invalidation:** the renderer caches `lastHumidity` / `lastAirQuality` and calls `invalidateAtmosphereLUT()` + `invalidateMoonAtmosphereLUT()` whenever either changes, forcing the LUT compute to re-bake with the new coefficients on the next frame. Without this the LUT would stay stale until the sun direction moved.
- `windSpeed` / `windDirection` were already on the weather leaf (delegating to `scene.weatherWindSpeed` / `scene.weatherWindDirection` and fanning out to `globe.cloudWindSpeed` / `globe.cloudWindDirection`). No new code; this lays the groundwork for water Phase 1's surface displacement consumer.

**Behavior change:** zero by default. Setting `scene.globe.atmosphericConditions.weather.humidity = 1.0` produces a noticeably hazier horizon and brighter Mie halo around the sun within one frame (LUT recomputes). Setting `cloudCover = 0.8` dims stars to 20% of their normal brightness. Setting `airQuality = 0.5` produces a deeply saturated sky color from doubled Rayleigh scattering. All scaling is linear and bounded so the existing scene tuning still works at default values.

**Phases 1.1–1.4 are now feature-complete.** The 1.x batch ships sun + moon ephemeris sync, dual-light atmosphere LUT, sky brightness CPU estimator, star modulation with cloud occlusion, and weather coefficient consumers as one cohesive feature branch per the B23 lock.

### Phase 1.x consolidation — EllipsoidRenderer extraction (completed 2026-04-09)

Closes the carry-over follow-up "EllipsoidPrimitive feature renderer consolidation" listed against Phase 1.2c v2. The Moon's bounding-cube + analytic ray-march approach was extracted into a shared infrastructure module so future ellipsoid bodies (Sun-as-ellipsoid, custom planets, asteroid models) can share the JS plumbing instead of copy-pasting ~140 lines of uniform-pack scaffolding.

- **NEW** `Renderer/WebGPU/WebGPUEllipsoidRenderer.ts` (~388 lines) exports:
  - `createEllipsoidBoundingCube(device)` — the canonical 8-vert / 36-index unit cube. Per-body code scales by `radii` in the vertex shader.
  - `createEllipsoidBindGroupLayout(device)` — the canonical bind group layout: `(uniform UBO @0, texture_2d @1, sampler @2)`. Stable contract for any future body that uses this module.
  - `packEllipsoidBaseUniforms(uniformData, inputs)` — fills the body-agnostic prefix (offsets 0..63 = 256 bytes) of an ellipsoid uniform buffer. Writes mvpRTE, RTE camera split, RTE body-center split, ivmRow0..2 (eye→model 3×3), cameraPositionMC, radii, oneOverRadiiSq, sunDirMC, sceneLightDirMC. Body-specific writes append at offset 64+.
  - `ELLIPSOID_BASE_UNIFORM_FLOATS = 64` and `ELLIPSOID_BASE_UNIFORM_BYTES = 256` constants.
- **NEW** `Shaders/WebGPU/chunks/functions/csm_intersectEllipsoid.wgsl` — extracted the analytic ray-ellipsoid intersection from the Moon shader into a chunk so any future body can `#import` it instead of inlining the math. The Moon shader currently still inlines its copy (the chunk preprocessor isn't wired through the Moon shader's build path yet); future bodies can adopt the chunk directly.
- **MODIFIED** `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (Moon path):
  - `createMoonBoundingCube()` is now a thin wrapper around `createEllipsoidBoundingCube()`.
  - `createMoonPipeline()` uses `createEllipsoidBindGroupLayout()` instead of inlining the bind group layout.
  - `_packMoonUniforms()` calls `packEllipsoidBaseUniforms()` for offsets 0..63 then writes the moon-specific tail (moonDirWC, phaseFraction, earthshine, useLogDepth, shininess, specularStrength, farPlane) at offsets 64..75.
  - Removed 6 now-unused scratch variables (`scratchInverseModelView3`, `scratchCameraMC`, `scratchSunMC`, `scratchSceneLightMC`, `scratchInverseModelMatrix`, `scratchInverseModelRot3`) and the unused `Matrix3` import. File shrunk from ~1107 to ~967 lines (~13% reduction).
- **NEW** `Specs/Renderer/WebGPU/WebGPUEllipsoidRendererSpec.js` — 11 specs covering layout constants, mvp matrix pack, RTE camera/center splits, radii / oneOverRadiiSq writes, sun direction transformation under model rotation, scene-light fallback, camera-in-model-coords math, and "tail untouched" verification. Pure CPU specs — no GPUDevice required.

**Behavior change:** zero. The Moon renders identically (`tsc --noEmit` clean; the math in the shared packer matches the previous inline pack byte-for-byte). The win is architectural — when the Sun-as-ellipsoid renderer or a custom planet feature renderer arrives, they get the cube + bind group + base pack for free. Documented as the consolidation pattern future ellipsoid bodies follow.

**Stretch follow-up (not done in this consolidation):** The orphan `WebGPUEllipsoidPrimitiveRenderer.ts` still uses the older screen-space-quad approach (~8M FS invocations at 4K). Migrating it to the bounding-cube path is a separate ~1-2 day task and should happen the next time it gets a real consumer. Logged in the backlog.

### Phase 5a — Volumetric fog froxel-grid infrastructure (completed 2026-04-09)

Opens the celestial atmosphere design's heaviest remaining piece (`CELESTIAL_ATMOSPHERE_DESIGN.md` §4.8) — the Frostbite-style three-pass volumetric fog renderer. **Phase 5a ships infrastructure only with zero visual change**: the compute kernels are placeholders that clear their outputs, the integrated 3D volume defaults to `(0, 0, 0, 1)` (no scatter, full transmittance), and the composite pass applies `out = sceneColor × 1 + 0 = sceneColor`. Phase 5b/5c/5d fill in the density / scattering / occlusion math without touching this scaffolding.

- **NEW** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` (~570 lines) — main coordinator. Holds three rgba16float 3D textures (density, scattering, integrated), one params UBO, the compute pipelines for the three passes, and the full-screen composite pipeline. Allocates lazily on first frame and rebuilds when the quality preset changes. Exposes `update(context, frameState, scene)` for the compute path and `composite(context, frameState, colorView, depthView, outputView, format)` for the final blit. Quality bands per the design doc:
  - **low**:    80 ×  45 ×  64  (~230K froxels, ~11 MB)
  - **medium**: 160 ×  90 × 128  (~1.8M froxels, ~84 MB)
  - **high**:   240 × 135 × 192  (~6.2M froxels, ~300 MB)
  - **auto** maps to **low** until the VPT init benchmark wires through (Phase 5a defers the auto-tune since there's nothing to measure with placeholder kernels).
- **NEW** `Shaders/WebGPU/Compute/VolumetricFog.wgsl` — single compute shader with three entry points (`densityInjection`, `lightScattering`, `integrate`) all `@workgroup_size(8, 8, 1)`. Phase 5a kernels clear their outputs to zero (or `(0,0,0,1)` for the integrated volume so transmittance reads as 1). Phase 5b/5c populate with real density / sun + moon scattering / front-to-back integration.
- **NEW** `Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — full-screen triangle vertex shader (no vertex buffer needed) + fragment shader that samples the integrated 3D volume in screen UV + linearized depth and applies the standard alpha-over composite `out = sceneColor × transmittance + scatteredLight`. Bind group layout: `(uniform, sampler, sceneColor, sceneDepth, fogVolume)`.
- **MODIFIED** `Renderer/FeatureRendererKey.js` — added `VOLUMETRIC_FOG: 37`, bumped `COUNT` to 38.
- **MODIFIED** `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — registers the volumetric fog feature renderer with three entry points (`update`, `composite`, `destroy`).
- **MODIFIED** `Renderer/WebGPU/WebGPUSceneRenderer.ts` `_executeEnvironmentalEffects()` — added a 4th step gated on `frameState.atmosphericConditions.volumetricFog.enabled`. Runs the compute passes via `fogFR.update()` then the composite via `fogFR.composite()` after procedural clouds / SSR / weather particles, before post-processing. Matches the B22 placement spec (after opaque + OIT-resolved color, before UI overlay).
- **MODIFIED** `Scene/AtmosphericConditions.js` `buildVolumetricFog()` — extended the leaf with the full set of design-doc tunables: `maxDistance` (50000m), `density` (1.0), `falloff` (0.0001 1/m), `fogAnisotropy` (0.3 HG g), `fogAlbedo` (vec3 0.9/0.92/0.95). The existing `enabled` (B18: false), `quality` ("auto"), and `enableScatteringOcclusion` (B20: false) toggles are preserved.

**Behavior change:** zero. Default `enabled = false` per B18; even with `enabled = true` the placeholder kernels produce a visually identical scene because the integrated volume reads as (0, 0, 0, 1). The win is that **Phase 5b/5c/5d become "fill in the kernels" instead of "build the infrastructure AND fill in the kernels"** — the hardest scaffolding (3D texture allocation, bind group layouts, pipeline creation, scene composite wiring, frame state plumbing) is done. `tsc --noEmit` clean throughout.

**What's NOT in Phase 5a (deferred to 5b/5c/5d):**
- Real density injection (height fog + atmospheric conditions wire-in)
- Sun + moon scattering with Henyey-Greenstein phase function
- Front-to-back depth integration
- Shadow map sampling for scattering occlusion (god rays)
- Ambient term from the atmosphere inscatter LUT
- 3D noise field for varying atmosphere density
- Quality auto-tune via VPT init benchmark

### Phase 5b — Real density / scattering / integration kernels (completed 2026-04-09)

Replaces the Phase 5a placeholder kernels with the actual Frostbite-style three-pass math: log-sliced froxel→world reconstruction, height fog density, sun + moon Henyey-Greenstein scattering, and front-to-back Beer-Lambert integration. **First phase that actually changes pixels** when `enableVolumetricFog` is on.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Extended `VolumetricFogParams` to 40 floats: added `invViewProj`, `cameraAndPlanet`, `sunDirectionAndIntensity`, `moonDirectionAndScale`.
  - **Disjoint @binding numbers** per access mode (binding 1=densityOut, 2=densityIn, 3=scatteringOut, 4=scatteringIn, 5=integratedOut) so the WGSL module declares each only once. Each pipeline's BGL provides only the bindings its entry point references — WebGPU validates per-entry-point.
  - **`froxelWorldPosition()`** helper: builds screen UV from `gid.xy`, unprojects (ndc, 0/1) → world rays via `invViewProj`, places the froxel at log-sliced linear depth `near × pow(maxDistance/near, k/D)`.
  - **`densityInjection`** kernel: writes `baseDensity × exp(-altitude × falloff)` per froxel, where altitude = max(0, length(worldPos) - innerRadius). Anisotropy g goes in the `.a` slot.
  - **`lightScattering`** kernel: reads density, sums sun + moon contributions via Henyey-Greenstein phase function, writes `vec4(scatteredRGB, density)`. Skips empty froxels via early-out.
  - **`integrate`** kernel: one thread per (x, y), serial walk over z = 0..D-1. Standard Beer-Lambert front-to-back integration with `(1 - sliceTransmittance) / extinction` factor (clamped for the limit case).
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - **Three per-pass bind group layouts** + matching pipeline layouts (densityBGL, scatteringBGL, integrateBGL). Each declares only the bindings its entry point uses; the bind groups are pre-built once.
  - Param packing extended for the new fields: composes `view × projection` then inverts via `Matrix4.inverse()` when the camera doesn't cache `inverseViewProjection`. Pulls `sun + moon directions` from `frameState.sunDirectionWC` / `moonDirectionWC` and `moonPhaseFraction × moonIntensity` (matches the SkyAtmosphere dual-light path).
  - Integrate dispatch is now `(ceil(W/8), ceil(H/8), 1)` instead of `× depth` because each thread serial-walks the z axis.
- **MODIFIED** `Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — depth slicing switched from linear to log to match the kernels' slicing. Composite would otherwise sample the wrong depth band.

**Behavior change:** when `enableVolumetricFog = true`, scenes now show actual height fog with sun + moon in-scattering. No god rays yet (those are 5c). Default is still off per B18.

### Phase 5c — Scattering occlusion (god rays) (completed 2026-04-09)

Wires the existing sun shadow map into the scattering kernel via `texture_depth_2d` + `sampler_comparison` and adds a constant ambient term. When `enableScatteringOcclusion = true` AND a shadow map is bound, in-scattered sun light is gated by a per-froxel shadow comparison sample, producing visible god rays where lit and shadowed regions meet at high density gradients.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Added `sunShadowMatrix: mat4x4` and `occlusion: vec4` (enableScatteringOcclusion, ambientStrength, shadowMapValid, shadowDarkness) to the params struct.
  - Added two new bindings to the scattering pass: `@binding(6) sunShadowMap: texture_depth_2d` and `@binding(7) sunShadowSampler: sampler_comparison`.
  - **`sampleSunShadow(worldPos)`** helper: projects worldPos via `sunShadowMatrix`, converts NDC → UV, applies a small bias, calls `textureSampleCompareLevel`, mixes with `darkness` so fully-occluded fragments aren't pitch black. Falls back to 1.0 (fully lit) when occlusion is off OR no real shadow map is bound.
  - **`lightScattering`** kernel multiplies the sun term by the shadow factor and adds an ambient term `albedo × density × ambientStrength` so shadowed froxels still receive a soft fill.
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - Allocated a 1×1 `depth32float` placeholder texture cleared to 1.0 ("fully lit"), bound by default so the scattering bind group always has a valid shadow texture even when no shadow map is active.
  - Created a comparison sampler (`compare: "less-equal"`, linear filtering) for the shadow path.
  - Per-frame: walks `frameState.shadowMaps`, fetches the active sun shadow map's `_shadowMapMatrix` and `_webgpuCache.depthTextureView`, packs the matrix into the params UBO at offsets 28..43, sets `occlusion.z = 1` when valid. Rebuilds the scattering bind group on the rare occasions the shadow texture view itself changes.
- **MODIFIED** `Scene/AtmosphericConditions.js` `buildVolumetricFog()` — added `ambientStrength: 0.05` (constant Phase 5c value; Phase 5e can replace with a real LUT sample).

**Behavior change:** when `enableVolumetricFog = true` AND `enableScatteringOcclusion = true` AND a sun shadow map is active, terrain casts visible shadow shafts through the height fog. The ambient term keeps shadowed regions soft instead of hard black. Default both off per B18/B20.

**Deferred to Phase 5e (future):**
- Real LUT-sampled ambient term — needs the SkyAtmosphere inscatter LUT views routed through to the volumetric fog renderer (currently lives in WebGPUPerformanceManager; cross-renderer plumbing is the only blocker).
- Moon shadow map — moon is dim enough that shadow precision isn't visible in practice; deferred indefinitely.
- PCF shadow filtering — single-tap comparison is currently used; the existing terrain shadow path's PCF can be cribbed if banding becomes visible.
- Cloud volumetric shadow contribution — deferred to Phase 6c per the design doc.

### Phase 5d — Varying atmosphere density (completed 2026-04-09)

Modulates the height-fog density via a 3D fbm noise field so scenes can express ground haze pockets, inversion layers, and pollution domes per the design doc §4.9. Per B19/B21, defaults to OFF and is silently a no-op when `enableVolumetricFog = false`.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Added a `noise: vec4<f32>` field to the params struct (enableVaryingDensity, noiseScale, noiseStrength, _pad).
  - Added `hash13`, `valueNoise3d`, and `fbm3d` helpers — 3 octaves of value noise with smoothstep interpolation. ~30 lines, no precomputed permutation table needed.
  - `densityInjection` kernel multiplies the height-fog density by `(1 + strength × fbm3d(worldPos / scale))` when `noise.x > 0.5`. Clamped to non-negative so large negative noise + low base density doesn't produce anti-fog.
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - Param buffer grew from 60 to 64 floats (256 bytes total).
  - Pulls `enabled` / `noiseScale` / `noiseStrength` from `frameState.atmosphericConditions.varyingAtmosphereDensity` (the existing leaf with B-series-locked defaults).

**Behavior change:** when `enableVolumetricFog = true` AND `varyingAtmosphereDensity.enabled = true`, the height fog gains a 3D noise modulation. Default off; opt-in shows visible haze pockets and density variation per the design doc §4.9.

**Phase 5 status: feature-complete.** All four sub-phases ship as one feature branch per the B23 lock. Phase 5e (real LUT ambient + cloud shadows) is deferred to Phase 6 work which folds cloud rendering into the same froxel grid.

### Snapshot Mode Phases A-D — completed 2026-04-09

Closes the spike memo (`SNAPSHOT_MODE_SPIKE_2026-04-09.md`). The Phase 0.7 skeleton already shipped the registration + version reconciliation; this batch fills in the actual freeze logic, the camera-delta auto-thaw, the markDirty hooks, and the spec coverage. With Phase 5's volumetric fog and Phase 1.x's celestial bundles in production, snapshot mode now has multiple real consumers to validate against — the moon was wired in 1.2c v2 as the first test case.

**Phase A — Bundle manager freeze flag + self-registration**
- **MODIFIED** `WebGPURenderBundleManager.ts`:
  - Added `_isFrozen` flag plus `freeze()` / `thaw()` / `isFrozen` / `asFreezable()` public methods.
  - `beginFrame()` skips eviction entirely while frozen.
  - `getOrCreate()` routes cache misses through a new `_buildEphemeral()` path that records-and-discards instead of admitting to the cache. This prevents transient one-frame additions from polluting a snapshot.
  - On `thaw()`, every cached entry's `lastUsedFrame` is reset to the current frame so the post-thaw scene doesn't trigger a build storm from the next eviction tick.
- **MODIFIED** `Scene/Scene.js`:
  - Per-frame self-registration of the WebGPU bundle manager via `bundleMgr.asFreezable()` → `snapshotMode.registerFreezable("webgpu-bundle-manager", ...)`. Idempotent + gated on `_bundleManagerSnapshotRegistered` flag so it only runs once per scene lifetime.
  - Skipped on WebGL contexts (the bundle manager only exists on WebGPU).

**Phase B — Camera-delta auto-thaw**
- **MODIFIED** `Services/SnapshotModeService.js`:
  - `enter()` now also captures `camera.positionWC` / `directionWC` / `upWC` (defensively cloned because Cesium mutates these in-place each frame).
  - New `tickCamera(scene)` method runs every frame and auto-thaws when:
    - Position delta exceeds `cameraDeltaPositionThreshold` (default 1.0m)
    - Direction angle exceeds `cameraDeltaRotationThreshold` (default ~0.5°)
    - Up vector angle exceeds the same rotation threshold (catches pure roll without forward-axis change)
  - New `cameraDeltaPositionThreshold` / `cameraDeltaRotationThreshold` setters so apps can tune sensitivity per scene.
  - New `cameraThawCount` diagnostic in `getStatistics()`.
- **MODIFIED** `Scene/Scene.js`: `Scene.render()` calls `_snapshotMode.tickCamera(this)` immediately after `_snapshotMode.tick(this)`.

**Phase C — markSnapshotDirty + HDR/depth hooks**
- **MODIFIED** `Services/SnapshotModeService.js` — new `markDirty(reason)` method. Thaws + bumps `manualThawCount` + records the reason in `lastThawReason`. Idempotent / no-op when not frozen.
- **MODIFIED** `Scene/Scene.js`:
  - New public `Scene.prototype.markSnapshotDirty(reason)` API. Documents the contract for user `postUpdate` listeners that mutate entity state silently.
  - HDR + log-depth dirty-flag detection in `Scene.render()` now calls `_snapshotMode.markDirty()` BEFORE the flags get cleared, so cached bundles encoded against the old swap-chain attachments don't survive into the new format.

**Phase D — Spec coverage**
- **NEW** `Specs/Services/SnapshotModeServiceSpec.js` (~250 lines, 18 specs across 7 describe blocks):
  - `enabled` flag toggle + auto-thaw on disable
  - Freezable registry: register / unregister / late-arrival joins active snapshot
  - `enter` / `exit` invariants (idempotent, gated on enabled, version baseline capture)
  - `tick` snapshot-version reconciliation (auto-thaw on bump, no-op on stable)
  - `tickCamera` Phase 6B coverage: stationary, position delta, direction angle, pure roll, sub-threshold jitter
  - `markDirty` Phase 6C coverage: explicit reason, no-op when not frozen, default reason
  - `destroy` releases freezables + auto-thaws

**Behavior change:** zero by default. Opt-in via `scene.snapshotMode.enabled = true`. Once enabled and entered via `scene.snapshotMode.enter(scene)`, the WebGPU bundle manager freezes its cache, the moon's render bundle replays verbatim, and every frame's `tick` + `tickCamera` watches for invalidation (snapshot version bump, camera motion, HDR/depth change, manual `markSnapshotDirty()`).

**Snapshot Mode status: feature-complete.** All four spike-memo phases shipped. Visual verification of the actual perf win (the spike memo's "2-5× CPU reduction for static scenes" claim) is deferred to a separate measurement pass once a real test scene is wired up.

### Three-way coordination — `requestRenderMode` × Snapshot Mode × VPT (completed 2026-04-09)

Audit + tightening pass to make sure the three rendering services compose cleanly without duplication. Identified gaps: snapshot mode couldn't see idle frames, `Scene.requestRender()` didn't notify the snapshot service, VPT had a half-implemented dead-code guard. All three are fixed; the relationship is now documented at the top of `SnapshotModeService.js` and `VisualPerformanceTargetService.js`.

**The three layers compose, they don't duplicate:**

1. **`Scene.requestRenderMode`** (Cesium core, macro-level) decides WHETHER a frame renders. When true, idle frames skip the entire `if (shouldRender)` block at zero CPU cost.
2. **`SnapshotModeService`** (micro-level) makes a render frame cheap when one DOES happen by replaying cached bundles instead of re-encoding draws (~30-60% command-encoding cost eliminated).
3. **`VisualPerformanceTargetService`** (quality-tuning) measures the resulting frame and tunes registered sinks for next time. Skipped while snapshot is frozen so dial outputs don't drift the captured bundles.

**Fixes shipped:**

- **MODIFIED** `Services/SnapshotModeService.js`:
  - **New `notifyFrame(scene, isRenderFrame)`** method called every frame regardless of `shouldRender`. Tracks `_consecutiveIdleFrames` so the service can see idle periods even though the existing `tick()` only runs inside the render block.
  - **New `autoEnterIdleFrames`** setter (default 0 = disabled). When > 0, the service auto-enters snapshot mode after N consecutive idle frames. Recommended preset for FAST-mode-on-idle:
    ```js
    scene.requestRenderMode = true;
    scene.snapshotMode.enabled = true;
    scene.snapshotMode.autoEnterIdleFrames = 120;  // ~2s at 60fps
    ```
  - **New `autoEnterCount` + `lastAutoEnterReason`** diagnostics in `getStatistics()`.
  - `_thawAll()` now resets `_consecutiveIdleFrames` so a thaw doesn't immediately re-enter on the next idle frame.
  - **40-line module-level documentation block** explaining the three-way relationship and how the layers compose.
- **MODIFIED** `Scene/Scene.js`:
  - `Scene.render()` calls `_snapshotMode.notifyFrame(this, shouldRender)` BEFORE the `if (shouldRender)` gate, so the service sees both render and idle frames.
  - `Scene.requestRender()` now also calls `_snapshotMode.markDirty("Scene.requestRender() called")` when a snapshot is active. The caller is asking for a fresh frame because something changed; replaying old bundles would be visually wrong.
- **MODIFIED** `Services/VisualPerformanceTargetService.js`:
  - **Dead-code cleanup**: removed the stale `eslint-disable no-unused-vars` (the parameter IS used).
  - **Half-implemented guard fixed**: the `if (scene._renderRequested === false)` body was empty (a comment block with no `return`); now actually returns. Documented as a defensive safety net for non-Scene callers since the production path already gates VPT on `shouldRender`.
  - **Module-level docs extended** with the three-way relationship reference and a note that the future "VPT adjusted sinks" → `scene.markSnapshotDirty()` hook is queued behind actual auto-tuner implementation.
- **MODIFIED** `Specs/Services/SnapshotModeServiceSpec.js` — added 6 new specs for the coordination behavior:
  - Idle frames tracked when auto-enter disabled
  - Auto-entry after configured threshold
  - Render frame resets the idle counter
  - Disabled service doesn't auto-enter
  - Setting `autoEnterIdleFrames=0` resets the counter
  - Post-thaw counter reset prevents immediate re-entry

**Behavior change:** zero by default. `autoEnterIdleFrames` defaults to 0, so the existing manual `enter()` workflow is unchanged. Users opt into auto-entry by setting it to a positive value alongside `requestRenderMode = true`. The `Scene.requestRender()` → `markDirty` wire is invisible when snapshot mode is off (the markDirty call is a no-op). `tsc --noEmit` clean throughout.

**What's NOT a duplication:**
- `requestRenderMode` skips the entire frame; snapshot mode makes the frame that DOES render cheap. Different layers, different optimizations.
- `Scene._renderRequested` (Cesium core flag) and `_snapshotMode.markDirty()` (snapshot reason) are different concerns: the first asks "should I render?", the second asks "is my cached bundle valid?". Both can fire independently and they often do.
- VPT's `_snapshotMode` flag and SnapshotModeService's `_isFrozen` flag mirror each other one-way (Scene pushes the value into VPT each frame). This isn't duplication — it's a deliberate decoupling so VPT doesn't import the snapshot service and vice versa.

### Phase 6 audit deep-dive — VPT × Snapshot × Cesium core (completed 2026-04-09)

Follow-up to the "Three-way coordination" pass: full deep-dive of every freezable, every dirty path, every service lifecycle hook, every shared-context interaction. Eight findings, seven fixes landed, one documented as a known limitation. `tsc --noEmit` clean.

**Findings + fixes:**

1. **`Scene.destroy()` was leaking the orchestration services** — both `_snapshotMode` and `_visualPerformanceTarget` had `destroy()` methods but `Scene.destroy()` never called them, leaking registered freezables across scene recreation. **FIX:** added explicit cleanup before `destroyObject(this)`.
2. **`_snapshotVersion` was bumped from exactly ONE place** (`Cesium3DTilesInvalidationFeed.apply`). Adding/removing primitives, ground primitives, or imagery layers mid-snapshot would silently leak the new state out of the bundle cache. **FIX:** `Scene` constructor now wires `bumpSnapshotVersion` listeners onto `_primitives.primitiveAdded/Removed`, `_groundPrimitives.primitiveAdded/Removed`, and `updateGlobeListeners` extends to `globe.imageryLayersUpdatedEvent` + `globe.terrainProviderChanged`.
3. **Moon's `destroyWebGPUMoonResources` never unregistered its `"moon-renderer"` freezable** — closure leak holding the entire moon cache alive after destroy. **FIX:** stash `_snapshotService` reference at registration, call `unregisterFreezable("moon-renderer")` on teardown.
4. **Volumetric fog had ZERO snapshot wiring** — three Frostbite-style compute passes (density injection, light scattering, integration) ran every frame even when snapshot mode was frozen, defeating the entire CPU/GPU win for static scenes. **FIX:** `WebGPUVolumetricFogRenderer.update()` now self-registers `"webgpu-volumetric-fog"` with the service on first call; `freeze()` flips `_frozen = true` and `update()` early-returns past `_ensureResources` while frozen. `destroy()` unregisters cleanly.
5. **VPT.tick() ran BEFORE snapshot.tick()** so VPT's `snapshotMode` flag was always one frame stale — its quality dial would adjust during the first frame of a new snapshot. **FIX:** reordered `Scene.render()` to call `_snapshotMode.tick + tickCamera` first, then push `_snapshotMode.isFrozen` into VPT, then `_visualPerformanceTarget.tick`.
6. **Multi-view + shared-context cross-contamination** (KNOWN LIMITATION, no fix shipped) — `WebGPURenderBundleManager` lives on the GraphicsContext and is shared across all Scenes bound to that context. If Scene A enters snapshot mode while Scene B keeps animating, Scene B sees frozen bundles. **DOCUMENTED** in the `SnapshotModeService.js` module header with workarounds (per-Scene context, single-Scene snapshot ownership, per-Scene freezable scope as a future fix).
7. **`WebGPUPerformanceManager.tryExecuteBundle()` was dead code with a latent bug** — it called `bundleMgr.get(bundleKey)` but `WebGPURenderBundleManager` only exposes `getOrCreate / has / invalidate / invalidateByPrefix`. Never invoked from anywhere. **FIX:** removed the dead method; left a comment pointing readers at `getOrCreate` as the real entry point.
8. **`_globeHeightDirty` and `shadowsDirty` were audited but did NOT need snapshot dirty hooks** — `_globeHeightDirty` only updates internal CPU state (camera-under-ground tracking), not pixel-affecting; `shadowsDirty` already invalidates the cached shadow map regardless of snapshot mode. No change needed.

**Files modified:**

- `Scene/Scene.js` — service cleanup in `destroy()`; `bumpSnapshotVersion` listeners on primitive collections + globe events; reordered service ticks in `render()`
- `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — Moon freezable cleanup with `_snapshotService` stash
- `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — three-pass freeze gate + self-registration + cleanup
- `Renderer/WebGPU/WebGPUPerformanceManager.ts` — removed dead `tryExecuteBundle`
- `Services/SnapshotModeService.js` — module-doc "Known limitation: shared-context multi-view" section

**Behavior change:** zero by default. All fixes only matter when snapshot mode is active (`scene.snapshotMode.enabled = true`). Existing WebGL behavior, existing WebGPU non-snapshot rendering, and the existing snapshot spec coverage all unchanged. `tsc --noEmit` clean.

### Phase 6 debug surface — central diagnostic aggregator (completed 2026-04-09)

Follow-up to the audit deep-dive: build a single backend-agnostic surface so an operator (or a test harness) can pull "what is the snapshot service / VPT / bundle cache / volumetric fog / moon doing right now" with one call. Required because the audit work added several invisible orchestration features whose only failure mode is "silently no-op", and we need a way to confirm they're alive before visual smoke testing.

**Design constraints:**

- **Backend-agnostic dispatch** — Scene code can't import from `Renderer/WebGPU/`. Routed through a new `GraphicsContext.getRendererStatistics()` abstract concrete (default empty), overridden by `WebGPUContext`. Per-instance state (Moon cache) is exposed via a `Moon.getDebugStatistics(scene)` method that dispatches through the registered `MOON` feature renderer's `getStatistics(moon)` entry point.
- **Pure read** — every `getStatistics()` is side-effect free; safe to call from any callback at any time, including inside a frozen snapshot.
- **Permissive shape** — every nested field is optional. A WebGL scene without a bundle manager still produces a usable snapshot.

**New APIs:**

- **`Scene.getDebugSnapshot()`** — top-level aggregator. Returns `{ scene, snapshotMode, visualPerformanceTarget, renderer, moon, debugToggles }`.
- **`Scene.logDebugSnapshot()`** — pretty-print of `getDebugSnapshot()` to console using `console.groupCollapsed` + per-section logs. Manual call from DevTools or a postUpdate listener.
- **`GraphicsContext.getRendererStatistics()`** — concrete on the abstract base, returns `{}`. Overridden by `WebGPUContext` to expose backend-specific stats.
- **`WebGPUContext.getRendererStatistics()`** — populates `{ backend, contextId, hasDevice, isDestroyed, bundleManager, performance, timestamps, indirectDraw, volumetricFog }`. Each subsystem field is wrapped in a try/catch so a single broken accessor doesn't poison the dump.
- **`SnapshotModeService.getStatistics()`** — already existed; now reachable through the central path.
- **`VisualPerformanceTargetService.getStatistics()`** — new. Returns `{ enabled, targetFps, snapshotMode, probeCount, sinkCount, probes, sinks }` with each probe queried lazily (errors per probe are isolated, not fatal).
- **`WebGPURenderBundleManager.statistics`** — extended. Original shape `{ cacheSize, totalDrawCalls, currentFrame }` now also includes `{ frozen, maxIdleFrames, maxCacheSize, hits, misses, ephemeralBuilds, evictions, freezes, thaws, hitRate, keyPrefixes }`. Internal counters bumped at the cache-hit, cache-miss, ephemeral-build, eviction, freeze, and thaw points. New `resetStatisticsCounters()` method for "measure the next N frames" workflows.
- **`WebGPUVolumetricFogRenderer.getStatistics()`** — new. Returns `{ enabled, frozen, snapshotRegistered, destroyed, resolutionKey, dimensions, updatesDispatched, updatesSkippedFrozen, composites }`. Counters split between dispatched and frozen-skipped passes so an operator can confirm at a glance whether snapshot mode is biting.
- **`getWebGPUVolumetricFogStatistics(context)`** — module-level entry point that resolves the per-context fog instance through the existing `WeakMap` and forwards to `inst.getStatistics()`. Wired into the `VOLUMETRIC_FOG` feature renderer registration.
- **`getWebGPUMoonStatistics(moon)`** — module-level entry point that reads from `moon._webgpuCache` and unpacks the moon-specific tail of the uniform buffer (offsets 64..75) to surface the most recent `moonDirectionWC`, `phaseFraction`, `earthshineOn`, `useLogDepth`, `shininess`, `specularStrength`. Wired into the `MOON` feature renderer registration.
- **`Moon.getDebugStatistics(scene)`** — backend-agnostic dispatch through `scene.context.getFeatureRenderer(FeatureRendererKey.MOON).getStatistics(moon)`. Returns `null` for WebGL or for moons that haven't yet had their first update.

**Backend-neutral debug toggles inventory** (already wired before Phase 6 — listed for the operator's convenience in the new snapshot's `debugToggles` field):

`debugShowFramesPerSecond`, `debugShowCommands`, `debugShowFrustums`, `debugShowFrustumPlanes`, `debugShowDepthFrustum`, `debugShowGlobeWireframe`, `debugShowCubeMapFace` (1=+X..6=-Z), `debugShowTerrainLOD`, `debugShowTerrainNormals`, `debugShowImageryLayer` (single-layer isolation), `debugShowDepthAsColor`, `debugShowTriangulation`, `debugDisableAtmosphereScattering`. All wired into `WebGPUGlobeSurfaceRenderer` (terrain visual modes) or the cubemap panorama / scene renderer paths.

**Files modified:**

- `Scene/Scene.js` — `getDebugSnapshot()` + `logDebugSnapshot()`
- `Scene/Moon.js` — `getDebugStatistics(scene)`
- `Renderer/GraphicsContext.ts` — concrete `getRendererStatistics()` default returning `{}`
- `Renderer/WebGPU/WebGPUContext.ts` — `override getRendererStatistics()` populates the WebGPU-specific subsystem stats
- `Renderer/WebGPU/WebGPURenderBundleManager.ts` — extended `statistics` getter + counters + `resetStatisticsCounters()`
- `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `getStatistics()` instance method, `getWebGPUVolumetricFogStatistics(context)` entry point, counters at dispatch / freeze-skip / composite points
- `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `getWebGPUMoonStatistics(moon)` reads the moon cache + uniform tail
- `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — `getStatistics` entry on the `MOON` and `VOLUMETRIC_FOG` feature renderer registrations
- `Services/VisualPerformanceTargetService.js` — `getStatistics()` clone-and-return implementation

**Behavior change:** zero. Every new method is pure read; the bundle manager counters are O(1) increments at points that already existed. `tsc --noEmit` clean.

**Operator workflow example:**

```js
// In DevTools, after navigating to a static scene:
viewer.scene.snapshotMode.enabled = true;
viewer.scene.snapshotMode.autoEnterIdleFrames = 120;
// ... wait two seconds ...
viewer.scene.logDebugSnapshot();
// Expect: snapshotMode.isFrozen = true, renderer.bundleManager.frozen = true,
// renderer.bundleManager.hitRate ≈ 1.0 (only hits from here on),
// renderer.volumetricFog.updatesSkippedFrozen rising every frame.
```

### Phase 1 → 3 sweep (completed 2026-04-09)

Continuation of the Phase 6 audit deep-dive. Closes Phase 1 (visual verification + bug closure), most of Phase 2 (testing + quality + perf benchmarking), and the smallest Phase 3 dormant compute shader activation. Backlog `Priority Remediation Order` items 1-9 are now closed or de-risked.

#### Phase 1 — Bug closure & quick wins

- **FORK-8** ✅ **Verified already resolved.** Audit grep against `packages/engine/Source/Scene/` returned zero `isWebGPUDrawCommand` references. The backlog entry was stale — pointed at a line removed during S16 cleanup. Marked resolved (FORK-8 in the resolved-items list).
- **SHADOW-LAYOUT** ✅ **Mostly resolved.** S25 shipped the per-layout pipeline cache (`cache.castPipelines` Map keyed on variant name) + the `registerShadowCastVariant(key, variant)` API + the stride-inference safety net. This sweep added the second built-in variant (`p12` — single-vec3 stride 12 for non-RTE models) so the registry isn't just `rte24` + an empty extension point. Stride inference now picks `p12` for stride-12 commands, falls back to the warn-once dedupe path for unknown strides. Spec coverage: 11 specs over the variant registry, stride inference, warn dedupe, and explicit `_shadowCastLayout` override (`Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`). **Carved out**: SHADOW-LAYOUT-QUANTIZED — quantized terrain stride-8/12 variants need de-quantization in the cast shader and a larger uniform buffer carrying tileRectangle / minMaxHeight; documented separately for a future session.
- **BUG-11 imagery probe** ✅ **Instrumentation landed; visual session still pending.**
  - Hypothesis A defensive fix: changed `WebGPUImageryReprojection.ts` clear alpha from `0` → `1` so any future `discard` path doesn't collapse the downstream `tex.a * effectiveAlpha` composite to zero. The full-screen triangle covers every output pixel today so this is a pure no-op-with-defense.
  - New `scene.debugShowImageryProbe = true` toggle exposes the existing first-4-tile diagnostic on demand. Rising-edge latch reset means the operator can re-sample without restarting the page.
  - The flag flows through `frameState.debugShowImageryProbe` and is reflected in `Scene.getDebugSnapshot().debugToggles.debugShowImageryProbe`.
  - Probe checklist preserved in `WEBGPU_MIGRATION_BACKLOG.md` updated for the visual session: `scene.debugShowImageryProbe = true` → capture dump → toggle `debugShowTerrainLOD` → narrow B / C if A still in play.

#### Phase 2 — Testing & quality

- **FORK-19b** ✅ **Spec coverage delta landed.** Five new spec files totaling ~745 lines and ~70 specs across the audit lockdown + the broader Phase 6 surfaces:
  - `Specs/Scene/SceneSnapshotWiringSpec.js` (190 lines, 11 specs) — Phase 6 audit lockdown: primitive collection mutations bump `_snapshotVersion`, ground primitive add/remove bumps it, globe `imageryLayersUpdatedEvent` + `terrainProviderChanged` bump it, `Scene.destroy()` releases orchestration services, `Scene.getDebugSnapshot()` returns the standard sections.
  - `Specs/Renderer/WebGPU/WebGPUVolumetricFogSnapshotSpec.js` (100 lines, 11 specs) — `WebGPUVolumetricFogRenderer.asFreezable()` contract, freeze/thaw idempotency, integration with `SnapshotModeService.enter()` / `exit()`, `getStatistics()` shape on a fresh renderer.
  - `Specs/Renderer/WebGPU/WebGPUMoonSnapshotSpec.js` (155 lines, 11 specs) — `createMoonFreezable(cache)` contract, late-arrival registration during an active snapshot, `unregisterFreezable` cleanup, `getWebGPUMoonStatistics(moon)` returning the unpacked uniform tail.
  - `Specs/Renderer/WebGPU/WebGPURenderBundleManagerStatsSpec.js` (155 lines, 13 specs) — full `statistics` Phase 6 schema, `asFreezable()` contract, freeze/thaw idempotency + counter bumps, `beginFrame()` advancement during freeze, `invalidate*()` paths against an empty cache, `resetStatisticsCounters()` semantics, `destroy()` safety.
  - `Specs/Services/VisualPerformanceTargetServiceSpec.js` (220 lines, 18 specs) — enabled / targetFps / snapshotMode flags, probe + sink registration, `tick()` no-op contracts under disabled / snapshot-frozen / idle frame, `getStatistics()` lazy probe queries with per-probe error isolation, sink level + cost reporting, `destroy()` cleanup.
  - **Refactor of two registration sites** to make the spec layer reachable: `WebGPUVolumetricFogRenderer.update()` now uses `this.asFreezable()`, and `WebGPUEnvironmentRenderer` Moon path now uses a new `createMoonFreezable(cache)` helper. Both helpers are exported so specs can drive the freezable contract directly without needing a real GPU device.
- **Visual regression CI** ✅ **Workflow added.** New `.github/workflows/visual-regression.yml` (workflow_dispatch trigger) drives `Tools/visual-regression/capture-and-diff.mjs` against the split-screen comparison page. Inputs: `threshold` (per-scene diff ratio failure cutoff, default 0.02) and `update` (true → promote captured outputs to baseline). Uploads `output/**` and `baseline/**` as artifacts (14 day retention). Currently manual-trigger only because GitHub-hosted Linux runners don't ship a WebGPU adapter without extra setup; promote to `pull_request` once that lands or when a self-hosted runner with a WebGPU adapter is available.
- **Perf benchmarking harness + tracking infrastructure** ✅ **New backend-neutral service.** `Source/Services/PerformanceTracker.js` (~370 lines) records per-frame samples (`frameNumber`, `relFrame`, `wallDtMs`, `cpuMs`, `gpuMs`, `drawCount`, `bundleStats` flattened, `snapshotFrozen`, caller `extra`) over a sample window. APIs:
  - `beginTrace(label, { frames })` — auto-ends after N frames, default 600
  - `sample(input)` — one-comparison no-op while inactive
  - `endTrace()` — returns the structured result + retains `lastResult`
  - `toCSV(result)` — stable column order, escapes commas/quotes, 4-decimal float formatting for diff-friendliness
  - `toJSON(result)` — pretty-printed with 4-decimal rounding
  - `logToConsole(result)` — `console.table()` + summary line
  - `traceCount` / `lastResult` getters for late-binding inspection
  - Summary roll-up: per-key (`cpuMs`, `gpuMs`, `wallDtMs`) `{count, avg, min, max, total}`, plus `avgBundleHitRate` and `snapshotFrozenRatio`.
  - Wired into `Scene` via new `Scene.beginPerformanceTrace(label, options)` / `Scene.endPerformanceTrace()` / `scene.performanceTracker` getter. The per-frame `_samplePerformanceTrace(scene)` helper pulls bundle stats from `context.getRendererStatistics()` and the snapshot frozen flag from `scene.snapshotMode.isFrozen`, so all the per-subsystem `getStatistics()` accessors are exercised through one path.
  - `Scene.destroy()` ends any active trace cleanly so a held reference to a result doesn't pin a destroyed scene.
  - Spec coverage: 24 specs across the active flag, beginTrace validation, sample storage + flattening, auto-end, frames=0 indefinite mode, summary roll-up math, CSV / JSON exporters, escape behavior, and the `traceCount` + `lastResult` retention contract (`Specs/Services/PerformanceTrackerSpec.js`, ~280 lines).

#### Phase 3 — Dormant compute shader activation

- **PointCloudSort dispatcher** ✅ **Built + spec'd.** New `Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts` (~370 lines) is a self-contained sort wrapper around `PointCloudSort.wgsl`. Hides the bitonic sort details from the consumer behind a single `sort(encoder, distSq, count)` call:
  - Owns the SortParams UBO + sortKeys + indices storage buffers
  - Handles power-of-two padding (sentinel `0xFFFFFFFFu` keys sort to the back of the network)
  - Encodes the local phase (`localBitonicSort` — one workgroup sorts up to 256 elements via shared memory) once
  - Encodes the global merge phase (`globalBitonicMerge`) over the (k, j) merge network for capacity > 256
  - `sortedIndicesBuffer` / `sortedKeysBuffer` getters expose the result for downstream draws
  - Diagnostic counters via `getStatistics()`: `sortsDispatched`, `localPasses`, `globalMergePasses`, `lastElementCount`, `lastCapacity`
  - `setShaderSource(wgsl)` injection point so the WGSL stays in `Source/Shaders/WebGPU/Compute/`
  - Pure-JS helpers: `nextPow2`, `floatToSortableUint`, `sortableUintToFloat` (matches the WGSL helper exactly so the host-side encoding agrees with the device-side comparison)
  - 11 specs over the helpers — covers `nextPow2` rounding, the float ↔ sortable-uint round trip, ordering preservation across the sample range, and the negative-zero edge case (`Specs/Renderer/WebGPU/WebGPUPointCloudSortDispatcherSpec.js`)
  - **Remaining**: consumer integration in the point cloud collection path. One-line swap: `if (perfMgr.shouldUseGPUPointCloud(N)) sortDispatcher.sort(encoder, distSq, N) else wasmBridge.sortByDistance(distSq, N, outIndices)`. Deferred until a real point cloud scene is wired up since the GPU-side sort is only useful when the consumer is also GPU-side (feeding into a draw indirect rather than reading back to the CPU).
- **HiZ + OcclusionTest** — **Audit complete; activation deferred.** Both WGSL files are complete (~70 + ~180 lines), both dispatchers exist on `WebGPUPerformanceManager` (`dispatchHiZPyramid()` line 1078, `dispatchOcclusionTest()` line 1310). The blocker is `OcclusionCulling.initialize()` — currently an API stub deferred to the "full WebGPU integration phase". Smallest fix is ~200-300 LOC: populate `OcclusionCulling.initialize()` to allocate the Hi-Z mip pyramid texture + wire `testCommands()` to call the dispatcher. Captured in the backlog with the file paths so the next session can pick it up cleanly.
- **GPUSortKeys** — **Audit complete; activation deferred.** WGSL + dispatcher are complete (`dispatchGPUSortKeys()` line 1243). The blocker is the consumer side — it needs SOA buffers for command metadata (centerX/Y/Z, layer, priority, materialId) allocated in Scene + a bind group factory + integration into RenderScheduler's sort pipeline. ~400-500 LOC. Lowest priority of the three since the JS multi-level comparators are not on the hot path until a scene exceeds 50K commands.

**Total deltas this session:**

- **Files added (8):** `PerformanceTracker.js`, `WebGPUPointCloudSortDispatcher.ts`, `SceneSnapshotWiringSpec.js`, `WebGPUVolumetricFogSnapshotSpec.js`, `WebGPUMoonSnapshotSpec.js`, `WebGPURenderBundleManagerStatsSpec.js`, `VisualPerformanceTargetServiceSpec.js`, `PerformanceTrackerSpec.js`, `WebGPUPointCloudSortDispatcherSpec.js`, `.github/workflows/visual-regression.yml`
- **Files modified (~10):** `Scene/Scene.js`, `Scene/Moon.js`, `Renderer/GraphicsContext.ts`, `Renderer/WebGPU/WebGPUContext.ts`, `Renderer/WebGPU/WebGPURenderBundleManager.ts`, `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`, `Renderer/WebGPU/WebGPUEnvironmentRenderer.js`, `Renderer/WebGPU/WebGPUFeatureRenderers.ts`, `Renderer/WebGPU/WebGPUShadowMapRenderer.js`, `Renderer/WebGPU/WebGPUImageryReprojection.ts`, `Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`, `Services/SnapshotModeService.js`, `Services/VisualPerformanceTargetService.js`, `Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`
- **Behavior change:** zero by default. Every new feature is opt-in via either an explicit flag (`debugShowImageryProbe`, `beginPerformanceTrace`) or an existing service toggle (`scene.snapshotMode.enabled`). Existing WebGL behavior, existing WebGPU rendering, and the existing spec suite all unchanged. `tsc --noEmit` clean throughout.

### Phase 3 + 4 + 5 sweep (completed 2026-04-09)

Closes Phase 3 dormant compute shader activation, lands Phase 4's cheapest visual quality win, and lays the Phase 5 capability snapshot + design plan. Backlog `Priority Remediation Order` items 10-25 are now closed or have a concrete spec to execute against.

#### Phase 3 — Dormant compute shader activation (HiZ + OcclusionTest + GPUSortKeys)

- **HiZ + OcclusionTest activation** ✅ **Dispatcher built + wired through OcclusionCulling.**
  - New `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts` (~640 lines): owns the Hi-Z mip pyramid texture (`r32float`, `pyramidMips` levels), the per-mip bind groups + params UBOs, the SOA sphere storage buffers (one per centerX/Y/Z/radius), the OcclusionParams UBO, the visibility output buffer, and the staging buffer for async readback. Pipelines + bind group layouts mirror `HiZPyramid.wgsl` and `OcclusionTest.wgsl` exactly.
  - Three entry points: `buildHiZPyramid(encoder)` records the per-mip compute pass loop, `dispatchOcclusionTest(encoder, soa, params)` uploads SOA + params and records the test compute pass + visibility-to-staging copy, and `readbackVisibility(count)` async-maps the staging buffer (with an `_inFlightReadback` guard so concurrent calls don't double-map).
  - Diagnostic `getStatistics()` exposes `hiZBuilds`, `occlusionDispatches`, `successfulReadbacks`, `failedReadbacks`, `inFlightReadback`, mip count, max command count.
  - Module-level entry points (`initWebGPUHiZOcclusion`, `dispatchWebGPUHiZOcclusion`, `readbackWebGPUHiZOcclusion`, `getWebGPUHiZOcclusionStatistics`, `destroyWebGPUHiZOcclusion`) registered as the `HI_Z_OCCLUSION` feature renderer (`FeatureRendererKey: 38`). Per-context instance cached in a `WeakMap` so the consumer doesn't have to thread the reference through.
  - **`Scene/OcclusionCulling.js` initialize() rewritten** to dispatch through the feature renderer registry. Backend-agnostic: looks up the FR via `context.getFeatureRenderer(FeatureRendererKey.HI_Z_OCCLUSION)`, calls `init(width, height, maxCommands)`, stashes the FR reference, sets `_pipelinesReady = true`. WebGL backends return null from the lookup and the conservative "all visible" path stays active. New `OcclusionCulling.dispatchGPU(encoder, depthTextureView, params)` and `OcclusionCulling.scheduleReadback()` methods drive the per-frame path (called by the future ViewportExecutor integration).
  - `OcclusionCulling.destroy()` now calls the FR's destroy through the cached reference.
  - Spec coverage: 11 specs over the pure-JS helpers (`computeMipLevels`, `halveDim`, `HI_Z_PARAMS_BYTES`, `OCCLUSION_PARAMS_BYTES`) — the dispatcher's `allocate` / `buildHiZPyramid` / `dispatchOcclusionTest` paths need a real GPUDevice and are covered by the in-browser spec runner.
  - **Remaining**: ViewportExecutor needs to call `dispatchGPU()` after the depth pass and `scheduleReadback()` at frame end. That's a Scene-side wiring step, ~50 LOC, deferred to a session that has a real test scene to validate against.
- **GPUSortKeys dispatcher** ✅ **Built + FR registered (consumer integration deferred).**
  - New `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts` (~340 lines): owns the SOA command metadata storage buffers (centerX/Y/Z + renderLayers + sortPriorities + materialSortIds), the packed output buffers (sortKeysHigh + sortKeysLow + commandIndices), the SortKeyParams UBO, the bind group layout, and the compute pipeline. Single `dispatch(encoder, soa, params)` entry point uploads the SOA + params and records the compute pass.
  - Output buffer accessors (`sortKeysHighBuffer`, `sortKeysLowBuffer`, `commandIndicesBuffer`) so a downstream sort pass (PointCloudSort or a future radix sort) can consume the packed keys.
  - Diagnostic `getStatistics()` exposes `dispatches` + `lastCommandCount`.
  - `SORT_MODE_FRONT_TO_BACK = 0` and `SORT_MODE_BACK_TO_FRONT = 1` enum constants matching the WGSL.
  - Registered as the `GPU_SORT_KEYS` feature renderer (`FeatureRendererKey: 39`).
  - Spec coverage: 3 specs over the layout constants + sort mode enum.
  - **Remaining**: RenderScheduler integration (allocate the SOA buffers in Scene, call `dispatch()` after command binning, follow up with a sort pass on the packed keys, rewire RenderScheduler to use GPU-sorted command indices). ~400-500 LOC. Lowest priority since the JS multi-level comparator is fine for <50K commands.

#### Phase 4 — Visual quality closure

- **Color grading LUT post-process** ✅ **Shipped end-to-end.**
  - New `Source/Shaders/WebGPU/PostProcess/ColorGrading.wgsl` (~135 lines): full-screen fragment pass with exposure / brightness / contrast / saturation / temperature / tint / per-tonal-range color balance (shadows / midtones / highlights) / output gamma. Procedural — does NOT require a 3D LUT texture upload, so the migration is purely a uniform buffer + a single pass. Designed to extend with a `texture_3d` LUT slot when a real LUT pipeline is needed.
  - **`WebGPUPostProcessPipeline.ts` extended** with `ColorGradingConfig` interface, `packColorGradingUniforms(c)` packer (20 floats / 80 bytes matching the WGSL struct), `addColorGrading()`, `updateColorGradingUniforms()`, and `setColorGradingScalar()` runtime tuners. Stage inserted between `Tonemap` and `Custom stages` in the single-pass execute chain (after SDR conversion, before any custom passes).
  - `setStageEnabled` / `updateStageUniforms` extended to recognize the `"ColorGrading"` name.
  - `hasActiveStages` getter recognizes the new stage so the pipeline doesn't go dormant when only color grading is enabled.
  - Spec coverage: 6 specs over `packColorGradingUniforms` — default identity pass-through, scalar field order, shadows/midtones/highlights tints, sparse config fall-back, purity (`Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js`).
- **DEFERRED_GBUFFER FR key decision** ✅ **Closed.** The FR key was already removed from `FeatureRendererKey.js` earlier in the session. The reference shaders (`DeferredGBuffer.wgsl`, `DeferredLighting.wgsl`) stay in the tree as documentation of the intended architecture. Decision: skip the full deferred path until a real many-lights scene shows up; if that day comes, build forward-clustered first (better fits the Cesium globe surface workload). Backlog item closed.
- **TAA design doc** ✅ **Written.** New `migration_doc/TAA_DESIGN.md` covers: motivation (FXAA weaknesses for Cesium scenes), architecture (camera jitter, motion vectors, neighborhood clamping, history ping-pong), 4-step implementation plan (~3 days), risks (quantized terrain motion vectors, snapshot mode jitter freeze, MSAA incompatibility), acceptance criteria, and a spec coverage delta. Concrete enough for the next session to execute against.
- **CSM design doc** ✅ **Written.** New `migration_doc/CSM_DESIGN.md` covers: cascade splits (mixed uniform + logarithmic), per-cascade VP fitting with bounding spheres, texel snap stabilization, receive-side cascade selection with blend bands, 5-step implementation plan (~4 days), risks (quantized vertex layout extensibility, RTE precision in texel snap, memory cost on mobile, snapshot mode integration), VSM stretch follow-up. Concrete enough for the next session to execute against.

#### Phase 5 — Modern WebGPU feature adoption

- **Capability snapshot** ✅ **Exposed via the central debug surface.** `WebGPUContext.getRendererStatistics()` now returns a `capabilities` block listing every WebGPU optional feature the device negotiated successfully:
  - `enabledFeatures` (full string list)
  - Per-feature booleans: `hasShaderF16`, `hasDualSourceBlending`, `hasClipDistances`, `hasTimestampQuery`, `hasIndirectFirstInstance`, `hasFloat32Filterable`, `hasSubgroups`, `hasBgra8UnormStorage`
  - This is the source of truth for "can I wire feature X on this adapter today?" — visible from `Scene.getDebugSnapshot().renderer.capabilities`. The migration plan in `PHASE_5_MODERN_WEBGPU_DESIGN.md` assumes the operator has verified the snapshot before opting into a feature.
- **HiZ occlusion + GPU sort keys statistics** ✅ added to `getRendererStatistics()` so the central debug surface now reports both Phase 3 dispatchers' counters alongside the existing fog / bundle / timestamp blocks.
- **Phase 5 design doc** ✅ **Written.** New `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md` covers all five modern WebGPU features:
  - **WGF-4 Standard Layout UBOs** — clarifies that this is *not* a device feature but a WGSL packing rule, enumerates the migration order (camera UBO first → tile UBO → effect UBOs → compute UBOs), per-UBO acceptance criteria, runtime assertion mitigation for off-by-one bugs. ~3-5 days total.
  - **WGF-1 `clip-distances`** — replaces stencil-based clipping with hardware clip distances, ~10-15% fragment cost saving on heavily-clipped scenes, ~1-2 days.
  - **WGF-2 `dual-source-blending`** — single-pass weighted-blended OIT, ~30-50% OIT cost reduction, ~2-3 days.
  - **WGF-3 `shader-f16`** — half-precision math in selected post-process effects (color grading, tonemap, bloom, FXAA), ~20-40% fragment ALU saving on targeted passes, ~2-3 days.
  - **WGF-5 `multi-draw-indirect`** — pairs with `WebGPUIndirectDrawManager` for GPU-driven N-draw rendering, ~3-4 days.
  - Recommended order: capability snapshot → camera UBO → clip-distances → shader-f16 → dual-source → multi-draw. First three are high-leverage and low-risk (~5-6 days); last two are scene-dependent.

**Files added (10):**

- `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts`
- `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts`
- `Shaders/WebGPU/PostProcess/ColorGrading.wgsl`
- `Specs/Renderer/WebGPU/WebGPUHiZOcclusionDispatcherSpec.js`
- `Specs/Renderer/WebGPU/WebGPUGPUSortKeysDispatcherSpec.js`
- `Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js`
- `migration_doc/TAA_DESIGN.md`
- `migration_doc/CSM_DESIGN.md`
- `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md`

**Files modified (~6):**

- `Renderer/FeatureRendererKey.js` — added `HI_Z_OCCLUSION (38)` and `GPU_SORT_KEYS (39)`, bumped `COUNT` to 40
- `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — registered the two new dispatchers as feature renderers
- `Renderer/WebGPU/WebGPUContext.ts` — extended `getRendererStatistics()` with `hiZOcclusion`, `gpuSortKeys`, and `capabilities` blocks
- `Renderer/WebGPU/WebGPUPostProcessPipeline.ts` — added `ColorGradingConfig` interface, `packColorGradingUniforms`, `addColorGrading` / `updateColorGradingUniforms` / `setColorGradingScalar` methods, integration into the execute chain + setStageEnabled + updateStageUniforms
- `Scene/OcclusionCulling.js` — `initialize()` now dispatches through the FR registry; new `dispatchGPU()` and `scheduleReadback()` per-frame methods; `destroy()` releases the FR
- `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — closed the DEFERRED_GBUFFER decision, marked HiZ + OcclusionTest + GPUSortKeys as "dispatcher landed"

**Behavior change:** zero by default. Color grading is opt-in via `pipeline.addColorGrading()`. HiZ occlusion requires `scene.renderScheduler.occlusionCulling.enabled = true` AND the consumer (ViewportExecutor) wiring that's still pending. GPUSortKeys is dispatcher-only — no consumer yet. The capability snapshot is read-only diagnostic. `tsc --noEmit` clean throughout.

### Carry-over follow-ups (not blocking; captured in `WEBGPU_MIGRATION_BACKLOG.md`)

- **NEW-9** — file an upstream PR against `CesiumGS/quantized-mesh` to formally reserve extension ID `0x05` before water Phase 1 ships
- **EllipsoidPrimitive consolidation** — extract the moon's bounding-cube + ray-march math into a generic `EllipsoidRenderer` feature renderer that future ellipsoid bodies (sun, custom planets) can share (the orphan `Generated/EllipsoidPrimitive.wgsl` is the conceptual reference)
- **Render bundle env-pass executor full integration** — currently the bundle is wired into `WebGPUDrawCommand.execute()` so any individual command can replay one. Future: collect bundles from a frustum's command list and submit a single `executeBundles([...])` call per pass, eliminating per-command overhead entirely.
- **Snapshot mode Phases A-D** — see `SNAPSHOT_MODE_SPIKE_2026-04-09.md` (3 days of work after Phase 1+ lands real bundle consumers)
- **C4/C12 wording fixes** in water doc §4.5/§10/DP5 — small refinements from Phase 0.6 verification

---

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Completed Work](#2-completed-work)
3. [What Works End-to-End (Verified)](#3-what-works-end-to-end-verified)
4. [Bug Fix History (Sessions 1-26)](#4-bug-fix-history-sessions-1-26)
5. [WASM & Compute Audit Results](#5-wasm--compute-audit-results)
6. [Render Pass Coverage](#6-render-pass-coverage)
7. [Industry Comparison](#7-industry-comparison)
8. [Relationship with Upstream CesiumJS](#8-relationship-with-upstream-cesiumjs)
9. [Reference](#9-reference)

> **For the full detailed backlog of remaining work, see `WEBGPU_MIGRATION_BACKLOG.md`.**

---

## 1. Architecture

### High-Level Flow

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  +-- Viewer.createAsync() -> shows LoadingOverlay
      +-- CesiumWidget.createAsync() -> Scene.createAsync()
          |-- ContextFactory.createContext() -> WebGPUContext.create() (async GPU adapter/device)
          |-- Shader init in WebGPUContext._initialize() -> imports .wgsl JS wrappers
          +-- Matrix4.setDepthRangeType('webgpu') -> 0-1 NDC depth range

Rendering: Scene.render() -> uniformState.update() -> per-View context update -> Primitive.update()
  |-- WebGL path (existing, untouched)
  +-- WebGPU path:
      |-- Feature renderer via context.getFeatureRenderer(FeatureRendererKey.XXX)
      |-- createWebGPUCommands() -> builds GPU pipelines/buffers
      |-- updateWebGPUCommandUniforms() -> per-frame RTE camera matrices
      +-- executeCommand() -> WebGPUDrawCommand.execute(renderPass)
```

### Core Design Principles

1. **Preserve WebGL functionality** -- WebGL rendering must continue to work. We modify upstream files when it improves architecture (e.g., `Context.js` -> ES6 class + `extends GraphicsContext`), but never break existing behavior.
2. **Backend agnosticism** -- `GraphicsContext` is an abstract base class. Scene code accesses renderers via `context.getFeatureRenderer(FeatureRendererKey.XXX)`, not direct imports. **Zero `isWebGPUDrawCommand` / direct WebGPU imports remain in Scene code** (Session 16 cleanup).
3. **Async-first for WebGPU** -- WebGPU is an async renderer. All GPU readback (depth picking, buffer reads, texture reads) uses async patterns (`mapAsync`, `.then()`, Promises). No sync GPU reads in render loops.
4. **Configuration-based** -- `renderer: 'webgpu'` opt-in, WebGL default. Feature detection falls back to WebGL.
5. **RTE everywhere** -- All WebGPU rendering uses Relative-To-Eye 64-bit emulated precision for planetary-scale accuracy.
6. **Multi-context support** -- `ContextRegistry` tracks all active contexts. Each `View` can target a different `GraphicsContext`. `FrameState.context` updated per-view before each render pass.
7. **WebGL2 only** -- Our fork targets WebGL2 + WebGPU (2 paths), not WebGL1 + WebGL2 + WebGPU (3 paths).

### Backend-Agnostic Architecture (Phases A-G Complete)

```
GraphicsContext (abstract base class)
  |-- id, rendererType, isWebGPU/isWebGL (per-instance)
  |-- log(level, message) -> [CesiumJS:type:shortId] prefix
  |-- registerFeatureRenderer() / getFeatureRenderer()  (O(1) array indexed by FeatureRendererKey enum)
  |-- registerFeatureRendererLoader() (lazy loaders for code-split renderers)
  |-- ContextRegistry (static) -- tracks all active contexts
  |-- 5 concrete command dispatch methods (WebGL defaults, WebGPU overrides)
  |-- Abstract compute capability API (supportsComputeShaders, supportsStorageBuffers, etc.)
  |-- Context.js (WebGL) extends GraphicsContext
  +-- WebGPUContext.ts (WebGPU) extends GraphicsContext

View (per-view context)
  |-- optional graphicsContext constructor param
  |-- effectiveContext -> per-view override OR Scene's default
  +-- scene.createView(camera, viewport, { graphicsContext })

FrameState
  |-- context / graphicsContext -- updated per-view before render
  +-- Matches how CesiumJS already updates frameState.camera per view
```

**Feature Renderer Pattern** (Phase D -- 36 of 36 keys registered):
```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION);
if (fr) { fr.update(this, frameState); return; }
// WebGL code follows as default fallback
```

**Scene.js Backend Agnosticism** (Complete): 5 concrete methods on `GraphicsContext` with WebGL-default behavior. `WebGPUContext` overrides each. Zero `isWebGPUDrawCommand` checks remain in Scene code (Session 16 cleanup replaced all with duck-typing via `defined(command._webgpuShaderType)` / `typeof cmd.execute === "function"` / `defined(cmd.pipeline)`).

### Renderer Threading Topology (Option C — landed 2026-04-11)

The default Cesium runtime is single-threaded: one main-thread JS pump
drives `Scene.render()` per RAF callback. The 2026-04-11 sweep added an
**opt-in** per-renderer worker pattern that lets multiple Scenes run on
separate threads, each with its own `OffscreenCanvas` and its own
render loop. The main thread is freed up during heavy renders and
each renderer reports its own independent FPS.

```
Main thread                                  Worker thread (one per host)
─────────────                                 ────────────────────────────
WorkerSceneHost(parent: <div>)                RendererWorker.js (bootstrap)
  │                                             │
  ├─ creates child <canvas>                     │
  ├─ canvas.transferControlToOffscreen() ───►   ├─ receives OffscreenCanvas
  ├─ new Worker(RendererWorker.js)              ├─ dynamic-imports
  │                                             │   "@cesium/engine" (chunked)
  ├─ posts MSG_INIT { canvas, rendererType,     ├─ Scene.createAsync({canvas})
  │                   sceneOptions, maxFps,     │   ↓
  │                   sessionId } ───────────►  │   Scene constructor detects
  │                                             │   `typeof document === "undefined"`
  │                                             │   → headless mode (no DOM)
  │                                             │
  │                                             ├─ _startRenderLoop()
  │                                             │   ├─ requestAnimationFrame (Chromium)
  │                                             │   └─ setTimeout fallback (FF/Safari)
  │                                             │
  │                                             ├─ scene.render() per tick
  │                                             ├─ scene.performanceTracker
  │                                             │   .recordFrame() per render
  │                                             │
  ├─ heartbeat ping every 1s ─────────────►     ├─ heartbeat pong
  │  (3 missed → restart)                       │
  │                                             │
  ├─ FpsOverlay polls host.getLiveStats()       │
  │  6 Hz (no postMessage cost — host caches    ├─ posts MSG_STATS every 125ms
  │  the latest stats payload from worker)  ◄───┤   { stats, frameTimes (transfer) }
  │                                             │
  ├─ host.setView/setMaxFps/forwardInput        │
  │  records in shadow state → posts ─────►     ├─ applies to scene
  │                                             │
  └─ on crash:                                  X (worker dies)
       Tier 1 (in-thread) device-lost recovery
       Tier 3 hard restart:
         worker.terminate()
         destroy dead canvas (one-time transfer)
         create fresh canvas inside parent
         spawn new worker
         replay shadow state (camera, maxFps,
                              requestRenderMode)
```

**Key constraints documented in code:**

- `OffscreenCanvas.transferControlToOffscreen()` is one-time per DOM
  canvas. Hard-restart paths recreate the entire `<canvas>` element
  inside the stable parent `<div>`.
- `requestAnimationFrame` is Chromium-only inside DedicatedWorker —
  Firefox/Safari fall back to `setTimeout(1000/60)`.
- The headless `Scene` works (Phase 1 of Option B) but most consumer
  features (entity adds, picking, DataSources, time-varying
  properties) still need the Phase 2-7 work in
  [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). Today
  the worker path is best used as a measurement substrate.
- Multiple `WorkerSceneHost` instances coexist on the same page —
  the test page [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html)
  exercises 1-16 simultaneous panes.

### File Organization

```
packages/engine/Source/Renderer/
|-- GraphicsContext.ts          <- Abstract base class
|-- ContextRegistry.ts          <- Multi-context tracking
|-- ContextFactory.ts           <- Async factory with fallback
|-- Context.js                  <- WebGL (extends GraphicsContext)
+-- WebGPU/                     <- 105+ files (~46,000 LOC)
    |-- WebGPUContext.ts         (core, ~3,010 lines)
    |-- WebGPUFeatureRenderers.ts (central registration of 36 renderers + lazy loaders)
    |-- WebGPUSceneRenderer.ts   (multi-frustum, all 13 passes, ~1,400 lines)
    |-- WebGPUGlobeSurfaceRenderer.ts (~2,100 lines)
    |-- WebGPUPerformanceManager.ts (~960 lines, 7 perf systems orchestrator)
    |-- WebGPUNagaTranspiler.ts  (NEW S26: optional GLSL->WGSL via naga-wasm)
    |-- Feature renderers, caching, resources, commands, debug overlays, stubs

packages/engine/Source/Services/    <- Backend-neutral services
|-- PerformanceTracker.js        (live FPS histogram + trace API)
|-- FpsOverlay.js                (Canvas2D HUD component, polls a data source)
|-- WorkerSceneHost.js           (main-thread worker wrapper + 3-tier crash recovery)
|-- WorkerSceneProtocol.js       (host↔worker message constants)
|-- SnapshotModeService.js       (Phase 0.7 freezable registry, integrates with maxFps)
|-- VisualPerformanceTargetService.js (Phase 0.4 VPT)

packages/engine/Source/Workers/
|-- RendererWorker.js            (worker-thread Scene bootstrap, ~11 KB)
|-- (existing terrain / decoder / culling workers)

packages/engine/Source/Shaders/WebGPU/    <- 238+ .wgsl files
packages/engine/Source/Scene/             <- Modified scene files + decomposed modules
Apps/WebGPUTest/                           <- 29 test/demo pages
migration_doc/                             <- This documentation
```

---

## 2. Completed Work

### Architectural Improvements to Upstream Files

| File Modified | Change | Why |
|--------------|--------|-----|
| `Context.js` | ES6 class + `extends GraphicsContext` | Enables shared abstract base |
| `View.js` | Optional `graphicsContext` param, `effectiveContext` getter | Per-view backend selection |
| `Scene.js` | `graphicsContext`/`contextRegistry` getters, `createView()`, per-view context updating, **decomposed into 8 modules**, debug visualization flags forwarded to frameState | Backend-agnostic facade |
| `FrameState.js` | `graphicsContext` alias for `context` | Backend-agnostic access |
| `Matrix4.js` | `setDepthRangeType('webgpu')` | 0-1 NDC depth |
| `Viewer.js` | `_preInitializedScene` forwarded to CesiumWidget | Async WebGPU init path |
| `CesiumWidget.js` | `_preInitializedScene` consumer | Skip sync Scene creation when async-built |
| `InfoBox.js` | DOMPurify sanitization for entity description innerHTML | XSS security fix — entity descriptions from external data sources (KML, GeoJSON, CZML) were injected raw |
| `Material.js` | `MaterialUniformBuffer` allocation via `MaterialHelpers.js initializeMaterial()` | Float32Array-backed uniform storage for WebGPU zero-copy upload path |
| 424 JS files | ES6 class conversion via jscodeshift codemod | Eliminates prototype-based inheritance patterns; consistent with upstream v1.139 ES6 direction |
| All `.indexOf()` comparisons | Replaced with `.includes()` (~90 patterns) | Modernization; clearer intent, same semantics |
| 12 files using urijs | Migrated to native `URL` API | Removed third-party dep; native API has equivalent functionality |

### Infrastructure Layer (105+ files, ~46,000 LOC)

| Category | Key Components |
|----------|----------------|
| **Core Context** (7) | `WebGPUContext.ts`, `GraphicsContext.ts`, `ContextRegistry.ts`, `ContextFactory.ts`, `SharedResourcePool.ts`, `OffscreenContextSupport.ts`, `WebGPUDevicePool.ts` |
| **Resources** (11) | Buffer, Texture, Texture3D, CubeMap, CubeMapFace, TextureAtlas, Sampler, RenderTarget, MipmapGenerator, TextureArray, TextureUtilities |
| **Pipeline & Shaders** (8) | RenderPipelineCache, ShaderModule, ShaderCache, PipelineDescriptorBuilder, WGSLShaderPreprocessor, WGSLBuiltins, AutoUniforms, **NagaTranspiler** |
| **Commands & Rendering** (5) | DrawCommand, ComputeCommand, ComputeEngine, SceneRenderer, PassState |
| **Framebuffers** (8) | FramebufferManager, SceneFramebuffer, MultisampleFramebuffer, GlobeDepth, DepthPlane, PickFramebuffer, etc. (transient attachments wired via `TRANSIENT_ATTACHMENT` feature detection) |
| **Feature Renderers** (15+) | Globe, Primitive, Billboard, Point, Polyline, Cloud, Model, SkyAtmosphere, Sun, Moon, Label (SDF), BufferPrimitive (polygon/polyline/point), Voxel, GaussianSplat, GroundAtmosphere, etc. |
| **Post-Processing** (7) | PostProcessPipeline, PostProcessEffects (Bloom, SSAO, DoF), Tonemapping, FXAA, Edge, Silhouette |
| **Performance** (7) | PerformanceManager, RenderBundleManager, IndirectDrawManager, GPUCuller, TimestampProfiler, BufferMapper, UniformGroupManager |
| **Stubs/Compat** (7) | WebGLStubBuffer, WebGLStubTexture (**Proton-style rewrite** — real texImage2D/texParameteri/pixelStorei/generateMipmap translation), WebGLStubFramebuffer, WebGLStubPipelineState (**full stencil state tracking**), WebGLStubShader (real device.limits values + 15-extension stubs + naga-wasm hookup), WebGLStubTypes, **WebGLStateConverters** (shared WebGL→WebGPU constant mapping functions) |
| **Material Uniforms** (1) | `MaterialUniformBuffer.js` — Float32Array-backed uniform storage, auto-layout, dirty tracking, scratch-based zero-alloc reads, backward-compatible facade. ~56% memory reduction per material; ~93% CPU reduction for static scenes (zero JS work when no property changed). |
| **Type Declarations** (1) | `cesium-js-types.d.ts` — ambient declarations for 20+ CesiumJS JS classes with opaque branded GPU resource types; eliminated 34 `as any` casts across WebGPU renderer files. |
| **Model** (4) | ModelRenderer, ModelPipelineCache, ModelInstancing, ModelFeatureId |
| **IBL/Lighting** (4) | IBLPipeline, ImageBasedLighting, GroundAtmosphere, EffectsBindGroup |
| **Debug Overlays** (3) | DebugDepthOverlay, PrimitiveIndexUtils, augmented globe debug fragment pipeline cache |
| **Services / Threading** (5) | `PerformanceTracker.js` (extended with live histogram + percentiles), `FpsOverlay.js` (Canvas2D HUD with rolling 60s graph), `WorkerSceneHost.js` (main-thread worker wrapper with 3-tier crash recovery + shadow state replay + maxFps), `WorkerSceneProtocol.js` (shared message-type constants), `Source/Workers/RendererWorker.js` (worker-thread Scene host, ~11 KB bootstrap + dynamic-imported engine chunk) |
| **Headless Scene** (2) | Scene.js + CreditDisplay.js detect `typeof document === "undefined"` and skip all DOM construction. Existing main-thread behavior unchanged. Unlocks Phase 1 of [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). |

### WGSL Shader Library (238+ files)

| Category | Count | Details |
|----------|-------|---------|
| Primitive shaders | 28 | PerInstanceColor (flat/lit/pick/ID), Material variants, PBR |
| Collection shaders | 8 | Point, Billboard, Polyline, Cloud, BillboardCollectionSDF (NEW S18), BufferPolygon/Polyline/Point material |
| Environment | 3 | SkyAtmosphere (with `useLut` fast path + `debug` vec4), Sun, Moon |
| Globe/Terrain | 1 | GlobeTerrain.wgsl (full-featured: imagery layers, day/night, ocean, fog, shadows, clipping, 2D/Columbus View, scene-mode branching, debug fields) |
| Struct/Function chunks | 97 | 91 functions + 6 structs (CsmBuiltins.js); includes new `csm_primitiveIndex.wgsl` |
| PostProcess | 12 | Tonemapping (5 modes), FXAA, SSAO, Bloom, DoF, Edge, Silhouette, OIT |
| Compute | 12 | FrustumCull (with `mainSubgroups` variant), HiZ, OcclusionTest, PolygonSDF, AtmosphereLUT (dispatch wired), PointCloudSort/LOD (LOD has `computeMainSubgroups` variant), GPUSortKeys, IBL (3), WeatherParticles, WeatherParticleRender |
| Model | 1 | ModelPBRComplete.wgsl (7 bind groups, 19 material flag bits) |
| Advanced | 10+ | PointCloud, Voxel, GaussianSplat, InvertClassification, GroundAtmosphere, SSR, ProceduralClouds, WeatherParticles, DeferredGBuffer/Lighting, ViewportQuad/ViewportQuadTexture |

### Scene Features -- What Renders

| Feature | Status | Key Details |
|---------|--------|-------------|
| **Globe/Terrain** | **Verified Working** | Uncompressed + quantized terrain (BITS12), unlimited imagery layers, **full shader (Session 17)**: Lambert diffuse lighting, day/night alpha blending with night lights emission, terminator glow, fog with atmosphere-colored blending, shadow receive (PCF), clipping planes with edge highlights, cartographic limit clipping, enhanced ocean (Fresnel, deep water, foam, wave normals, GGX specular, subsurface scattering, sky reflection), water mask. texCoordsRect alpha masking (S15). Multi-LOD rendering (S15). 2D/Columbus View modes (S18). Debug overlays: triangulation, LOD, normals, imagery isolation, depth-as-color, wireframe (S22-24). |
| **Primitive** (flat/lit/pick) | Built | 20 shader variants, RTE, geometry data preservation |
| **PointPrimitive** | Built | Instanced quads, RTE |
| **Billboard** | Built | Instanced quads, atlas textures, RTE |
| **Label** | **Built (S18)** | `WebGPULabelRenderer` registered as `LABEL_COLLECTION` FR (key 36) — SDF text with 5-tap supersampling, outlines, screen-space derivative AA. WebGL fallback preserved. |
| **Polyline** | Built | Screen-space thick lines, per-segment quads, AA |
| **SkyAtmosphere** | **Working + LUT consumer (S26)** | Nishita scattering with Rayleigh + Mie, HSB correction, debug bypass (`debugDisableAtmosphereScattering`). New `useLut` fast path samples precomputed inscatter LUT instead of per-pixel ray march when `WebGPUPerformanceManager.dispatchAtmosphereLUT` has run; falls back to ray march when compute unavailable. |
| **GroundAtmosphere** | Wired (Session 17) | `Globe.js beginFrame()` calls FR; uniform buffer with packed atmosphere parameters |
| **Sun** | Built | Procedural texture, billboard quad |
| **Moon** | Built | UV sphere mesh, textured diffuse lighting, full RTE |
| **Fog** | **Working** | Parameters wired via tile uniform buffer + full shader fog blending (Session 17) |
| **SkyBox/CubeMapPanorama** | Fixed (Session 16) | Cubemap loads and renders. `panoramaCommandList` accumulation bug fixed. Per-face debug isolation (`debugShowCubeMapFace`) added S23. |
| **Model/glTF** | Built | PBR, morph targets, skinning, GPU instancing, feature ID textures, batch table styling |
| **3D Tiles** | Built | Works via Model chain. Zero 3D Tiles code changes needed. Optional indirect-draw fast path added S26 (`context.useIndirectDrawForTiles` flag, `executeBatchIndirect` groups homogeneous runs through `WebGPUIndirectDrawManager.submitBatch`). |
| **Materials System** | Built | All 25 built-in materials mapped to WGSL |
| **Pick System** | **Working** | Async depth readback with staleness validation + distance ratio rejection. Camera jitter significantly reduced (S16). All 3 collection renderers + globe surface support pick. Buffer Primitive picking landed S20 via shader-variant pick pipelines. |
| **Particles (weather)** | **Built (S18)** | GPU compute particle simulation + render pass. 4 weather types (rain/snow/fog/hail). Camera-facing instanced quads. |
| **Particles (general)** | Auto-supported | Delegates to BillboardCollection (confirmed S20) |
| **Viewport Quad** | **Built (S18)** | `WebGPUViewportQuad` utility integrated into `WebGPUContext.createViewportQuadCommand`. Pipeline + bind group caching, 3-vertex fullscreen triangle pattern, blend/depth/stencil configurable. |
| **Buffer Primitives (vector tile)** | **Built (S19)** | `WebGPUBufferPrimitiveRenderer.ts` (~1465 lines) implements polygon (indexed triangle-list), polyline (indexed miter-quad expansion), point (instanced quads). Picking added S20. |
| **2D / Columbus View** | **Built (S18)** | Globe terrain shader branches on `camera.sceneMode` (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. Helper functions: `latitudeToWebMercatorFraction`, `get2DYPositionFraction`, `computePlanarPosition`. |
| **WebGPU Compatibility mode** | Built (S17) | `renderer: "webgpu-compat"` with `featureLevel: "compatibility"` |

### Feature Renderer Registration (36 of 37)

| Status | Count | Details |
|--------|-------|---------|
| Registered + Scene-wired (Phase D) | 31 | Fully functional FR pattern |
| Registered + Scene-wired (Session 17) | +5 | FOG (via tile UB), GROUND_ATMOSPHERE (Globe.js beginFrame), SSR/WEATHER_PARTICLES/PROCEDURAL_CLOUDS (WebGPUSceneRenderer._executeEnvironmentalEffects) |
| Registered (Session 18) | LABEL_COLLECTION (key 36) | `WebGPULabelRenderer` with SDF text path |
| Registered (Session 19) | BufferPolygon/Polyline/Point | Replace v1.140 vector tile no-op stubs |
| Lazy-loaded via `registerFeatureRendererLoader` | 7 | GAUSSIAN_SPLAT, POINT_CLOUD, POINT_CLOUD_EDL, VOXEL_PRIMITIVE, SCREEN_SPACE_REFLECTIONS, WEATHER_PARTICLES, PROCEDURAL_CLOUDS — dynamic import on first frame, ~290 KB shaved from default bundle |
| NOT registered | 1 | DEFERRED_GBUFFER (key defined but never implemented) |

### Sorting System (11 phases, 30+ files)

| Component | Status |
|-----------|--------|
| Foundation types (SortMode, RenderLayer, RenderLayerCollection) | Complete |
| Structured sort properties on DrawCommand/WebGPUDrawCommand | Complete |
| MaterialSortIdAllocator | Complete |
| Scene.js multi-level comparators | Complete |
| RenderScheduler orchestrator + full layer execution (SORT-FULL) | Complete |
| Entity `renderPriority` -> Visualizer -> Collection -> DrawCommand wiring | Complete |
| Geometry batch priority grouping | Complete |
| SceneOctree + OctreeNode (spatial acceleration) | Built, opt-in via `scheduler.octree.enabled = true` |
| OcclusionCulling wiring | Built, opt-in (WebGPU-only, conservative fallback) |
| WASM culling/sorting bridges (JS fallback + Rust crate) | Built (17.2 KB binary) |
| Hi-Z occlusion culling shaders + manager | Built (WebGPU only, not yet wired into ViewportExecutor) |

### Picking System

**What works end-to-end:**
- `WebGPUPickFramebuffer.ts` -- full implementation with async readback
- `WebGPUSceneRenderer._executePickPass()` -- renders GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes
- All 3 collection renderers (Billboard, Point, Polyline) support pick
- `PickDepth.js` -- async readback via staging buffer + `mapAsync`
- Staleness validation -- PlayCanvas-style camera state validation on async resolve
- Pick ID consolidated in `GraphicsContext`
- Globe depth copy pipeline + async readback (FORK-34 — was already complete, never crossed off)
- Buffer Primitive collections pick path (S20)

### WASM Bridges (7 of 7 Complete)

All 7 bridges (`WasmCullBridge`, `WasmSortBridge`, `WasmHeightmapBridge`, `WasmQuantizedMeshBridge`, `WasmRTEBridge`, `WasmMatrixBridge`, `WasmPointCloudBridge`) implement every `.clinerules` mandate:

| Requirement | Status | Implementation |
|---|---|---|
| `destroy()` method | Complete | All bridges expose destroy + `_isDestroyed` guard |
| `free_buffer()` | Complete | Called in destroy |
| Version check | Complete | `WasmFeatureDetection.checkVersionMatch()` (Rust returns `version() = 2`) |
| SIMD detection | Complete | `WasmFeatureDetection.checkSIMDSupport()` + `checkModuleSIMD()` shared utility |
| JS fallback | Complete | Every bridge has full JS implementation; bridges fall back on WASM init failure |
| Error handling | Complete | try/catch in WASM dispatch methods with automatic JS fallback |
| OOM handling | Complete | Rust `lib.rs` uses `try_reserve()` + null pointer (0) on OOM (FORK-46) |

### Compute Shader Engine

`WebGPUComputeEngine.execute()`, `executeMultiple()`, `executeOnEncoder()` all wrapped in try/catch (return `false` on failure), `_validateWorkgroups()` checks `device.limits.maxComputeWorkgroupsPerDimension` before dispatch, pipeline caching by shader source key (FORK-42, FORK-43, FORK-44).

### Performance Infrastructure (All Wired)

| Feature | File | Benefit | Status |
|---------|------|---------|--------|
| Render bundles | `WebGPURenderBundleManager.ts` | 50-80% CPU for static terrain | **Activated** (Session 16) -- Globe pass uses bundle encoder for 8+ tiles |
| Indirect drawing | `WebGPUIndirectDrawManager.ts` | GPU-driven 3D Tiles | **Wired** + `submitBatch`/`executeBatchIndexed` API. Opt-in fast path in scene renderer (S26) via `context.useIndirectDrawForTiles` flag |
| Storage buffers | `WebGPUStorageBufferPool.ts` | Large point cloud data | Wired |
| GPU frustum culling | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` | GPU-side visibility | **Activated** (Session 17) -- Lazy-init via `context.gpuCuller`, 256-command threshold, async readback. Subgroup variant added S20 (`mainSubgroups` entry point with try/catch fallback). |
| Timestamp queries | `WebGPUTimestampProfiler.ts` | GPU profiling | Wired |
| Buffer mapping | `WebGPUBufferMapper.ts` | Async CPU<->GPU access | Wired |
| Uniform grouping | `WebGPUUniformGroupManager.ts` | Per-frame/material/object bind groups | Wired |
| Ring buffer allocator | `WebGPURingBufferAllocator` | Reduce per-frame buffer creation | **Activated** (Session 16) -- 4MB pages, triple-buffered, 256-byte alignment |
| Pipeline warm-up | `_warmUpPipelines()` in WebGPUContext | No first-frame stutter | **Activated** (Session 17) -- Globe renderer + GPU culler pre-initialized at context creation |

### Compute Shader Activation Status

| Shader | Status | Activation Trigger |
|--------|--------|-------------------|
| PolygonSignedDistance.wgsl | **Active** | ClippingPolygonCollection |
| BrdfLutGenerate.wgsl | **Active** | IBL pipeline init |
| IrradianceConvolution.wgsl | **Active** | Env map change |
| RadiancePrefilter.wgsl | **Active** | Env map change |
| AtmosphereLUT.wgsl | **Dispatch + consumer wired (S26)** | `WebGPUPerformanceManager.dispatchAtmosphereLUT()` runs on transient encoder when sun direction changes (>0.0001 cos delta); SkyAtmosphere fragment shader samples LUT on `useLut > 0.5` |
| FrustumCull.wgsl | **Activated** (S17, subgroup variant S20) | GPU culler 256-command threshold, picks `mainSubgroups` entry point on capable devices |
| PointCloudLOD.wgsl | **Variant + dispatcher ready (S26)** | `computeMainSubgroups` variant wired through `WebGPUPerformanceManager.dispatchPointCloudLOD()` with lazy source preprocessing (prepend `enable subgroups;` or strip sentinel block) and entry-point selection per device capability |
| HiZPyramid.wgsl | Dormant | Wire into ViewportExecutor with Hi-Z (3-4 days) |
| OcclusionTest.wgsl | Dormant | Same as HiZ |
| PointCloudSort.wgsl | Dormant | Wire when point cloud visible |
| GPUSortKeys.wgsl | Dormant | Wire when >50K commands |
| WeatherParticles.wgsl | **Active (S18)** | Compute simulation + render pass via `WEATHER_PARTICLES` FR; activated by `scene._enableWeather = true` |

### Build & Tooling

| Component | Status |
|-----------|--------|
| WGSL build integration | `wgslToJavaScript()` (now `await`-correct, S13) in build.js, gulpfile watches .wgsl |
| WASM build pipeline | `npm run build-wasm` (+ debug/check/clean variants) |
| Split-screen comparison | `Apps/WebGPUTest/split-screen-comparison.html` |
| WebGPU feature auto-detection | `_buildFeatureList()` probes adapter; supports `subgroups`, `timestamp-query`, `shader-f16`, `dual-source-blending`, `clip-distances`, `float32-filterable`, `rg11b10ufloat-renderable`, BC/ETC2/ASTC compression |
| Context-aware logging | `[CesiumJS:type:shortId]` prefix on all renderer messages |
| TypeScript | `tsc --noEmit` -- 0 errors |
| Build | `npx gulp build` -- passes (~38-48s) |
| `npm run restart` | clean -> build -> start (S13) |
| **Build variants** | **Tree-shaken WebGL-only / WebGPU-only / dual builds** via `bundleVariantPlugin.js` (synthetic-path resolve, decision cache). `RendererType.ts` `setGlobalDefaultRenderer` / `getGlobalDefaultRenderer` added. New gulp tasks: `buildCesiumDual`, `buildCesiumWebGPUOnly`, `buildCesiumWebGLOnly`, `buildAllVariants`. `createCesiumJs` / `bundleCesiumJs` in `scripts/build.js` accept `variant` param. |
| **Bundle analyzer** | `scripts/analyzeBuild.js` parses esbuild metafile, reports top-N folders/modules, supports `--treemap` |
| **Removed deps** | `urijs` removed (12 files migrated to native `URL` API); `karma-ie-launcher` removed (dead IE-targeting dev dep) |
| **Lazy-loaded deps** | meshoptimizer (~110 KB), @spz-loader/core (~270 KB) split into separate chunks via dynamic `import()`. Per-feature renderers code-split. Dual ESM index.js shrunk 4.23 MB → 3.9 MB (1.18 MB → 1.05 MB gzipped, -11%). |
| Tests | 10 Jasmine spec files: Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler. ~15K green, ~30 pre-existing failures (not from our changes). |
| **Visual regression** | `Tools/visual-regression/capture-and-diff.mjs` — Playwright-driven WebGL↔WebGPU pixel diff (Edge, zero deps, PNG encode built-in) |

#### Build & Debug Command Reference

```bash
# ─── Standard builds ───
npx gulp build              # Dev build (includes WGSL compilation)
npx gulp buildRelease        # Production (minified + unminified, dual variant)
npm run restart              # Clean → build → start dev server

# ─── Build variants (tree-shaking) ───
npx gulp buildCesiumDual          # Both backends, WebGPU-first default
npx gulp buildCesiumWebGPUOnly    # WebGPU only (~32% smaller ESM)
npx gulp buildCesiumWebGLOnly     # WebGL only (no WebGPU chunks)
npx gulp buildAllVariants         # All three side-by-side

# ─── Type checking & tests ───
npx tsc --noEmit             # TypeScript check (0 errors expected)
npm test                     # Jasmine suite

# ─── Visual regression ───
node Tools/visual-regression/capture-and-diff.mjs              # All scenes
node Tools/visual-regression/capture-and-diff.mjs --update      # Save baselines
node Tools/visual-regression/capture-and-diff.mjs --headed      # Show browser

# ─── Runtime diagnostics (DevTools console) ───
viewer.scene.getDebugSnapshot()      # Full system state dump
viewer.scene.logDebugSnapshot()      # Pretty-printed console output
window.webglViewer                   # Split-screen page: WebGL viewer
window.webgpuViewer                  # Split-screen page: WebGPU viewer

# ─── CesiumDebug console commands (after install on a viewer) ───
CesiumDebug.help()              # List all commands
CesiumDebug.snapshot()          # Full debug snapshot (scene + renderer + toggles)
CesiumDebug.showDepth()         # Depth buffer as grayscale
CesiumDebug.hideDepth()         # Restore normal
CesiumDebug.showWireframe()     # Globe wireframe overlay
CesiumDebug.hideWireframe()     # Hide wireframe
CesiumDebug.showFrustums()      # Colorize frustum splits
CesiumDebug.showCommands()      # Command count overlay
CesiumDebug.toggleFPS()         # FPS counter
CesiumDebug.pipelineStatus()    # Shader/pipeline/device health check
CesiumDebug.postProcess()       # Post-process pipeline state table
CesiumDebug.canvasPixels()      # Sample canvas pixel data
CesiumDebug.logImageryProbe()   # Dump next 4 tile updates
CesiumDebug.scene               # Direct scene access
CesiumDebug.context             # Direct context access
CesiumDebug.device              # Direct GPUDevice access
```

#### Build Variant Output Directories

| Variant | Minified | Unminified | Notes |
|---------|----------|------------|-------|
| dual (default) | `Build/Cesium/` | `Build/CesiumUnminified/` | Backwards-compatible, ESM code-split |
| webgpu-only | `Build/CesiumWebGPU/` | `Build/CesiumWebGPUUnminified/` | GLSL shaders aliased to empty stubs |
| webgl-only | `Build/CesiumWebGL/` | `Build/CesiumWebGLUnminified/` | WebGPU renderer aliased to empty stubs |

### Debug Visualization Stack (Sessions 22-24)

All toggles read from `frameState` once outside hot loops; production cost is one bool comparison per pass. Fragment debug pipelines use a unified `DebugFragmentMode` enum + augmented shader module (vertex stages reused, fragment entry points appended).

| Toggle | Effect | Implementation |
|--------|--------|----------------|
| `scene.debugShowGlobeWireframe` | Line-list overlay over terrain tiles | `_wireframePipelineCache` keyed by stride, IB swap to wireframe indices, full vertex layout parity |
| `scene.debugShowTriangulation` | Per-triangle rainbow color via primitive_index | `fragmentDebugTri` entry point + `csm_primitiveIndex.wgsl` chunk |
| `scene.debugShowTerrainLOD` | 12-color tile depth overlay | `fragmentDebugLod` reads `tile.debugFields.x` (LOD level) |
| `scene.debugShowTerrainNormals` | Eye-space normal as RGB | `fragmentDebugNormal` reads + remaps `v_normalEC` |
| `scene.debugShowImageryLayer` | Isolate layer 0..3 (or -1 for all) | Multiplicative mask in production fragmentMain, reads `tile.debugFields.y` |
| `scene.debugShowDepthAsColor` | Linearized/raw/combined depth | `WebGPUDebugDepthOverlay.ts` standalone fullscreen pass; sampleable depth opt-in via `WebGPURenderTarget.depthSamplable` (non-MSAA only) |
| `scene.debugDisableAtmosphereScattering` | Flat magenta sky | Early-out in SkyAtmosphere fragment, reads `u.debug.x` |
| `scene.debugShowCubeMapFace` | Per-face cubemap isolation (1=+X..6=-Z) | Fragment-shader face discard via dominant axis test |

---

## 3. What Works End-to-End (Verified)

These features have been verified working in the split-screen WebGPU viewer through manual testing:

| Feature | Verified Date | Notes |
|---------|---------------|-------|
| Globe terrain geometry | April 4, 2026 | Renders sphere with correct shape |
| Bing Maps imagery | April 4, 2026 | Satellite imagery loads and displays |
| Multi-LOD terrain subdivision | April 4, 2026 | Quadtree subdivides as camera zooms |
| texCoordsRect alpha masking | April 4, 2026 | No more vertical stripes between tile imagery |
| Fill tile rendering | April 5, 2026 | Tiles with no UV data correctly skipped (no black lines) |
| WebMercator texture coordinates | April 4, 2026 | Bing Maps imagery correctly projected |
| SkyAtmosphere glow | April 5, 2026 | Atmosphere haze visible at horizon |
| Async init via Viewer.createAsync | April 2, 2026 | WebGPU context initializes through full Viewer path |
| Split-screen WebGL/WebGPU | April 3, 2026 | Both renderers run simultaneously |
| Context+device init (smoke test) | April 2, 2026 | `scene-webgpu-init-test.html`: adapter, device, canvas, beginFrame/endFrame all green |

---

## 4. Bug Fix History (Sessions 1-26)

This is a consolidated index of every bug fix from `WEBGPU_DEBUGGING_LOG.md`. Each entry references the file(s) touched and the root cause; consult the debugging log for full diffs and reproduction steps.

### Session 1 — Initial Launch Errors
- **1.1 Buffer Size NaN**: `createVertexBuffer`/`createIndexBuffer` callers passing `byteLength` where data was expected. Fixed in `WebGPUEnvironmentRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`. `createUniformBuffer` now auto-detects string-as-label.
- **1.2 `passEncoder.setPipeline is not a function`**: Environment commands tried to execute outside any active render pass. Fixed by skipping `renderEnvironment()` in WebGPU mode and adding `Pass.ENVIRONMENT` execution to `WebGPUSceneRenderer.ts` multi-frustum loop.
- **1.3 Splitscreen Camera Sync**: Bidirectional camera sync added in `CesiumViewer.js` with loop-prevention guards.

### Session 2 — Globe Terrain Rendering
- **2.1 Bind Group Limit (5 → 4)**: WebGPU caps at 4 bind groups. Merged water mask + ocean normal map into single group 2.
- **2.2 writeBuffer 4-Byte Alignment**: `Uint16Array` index buffers padded to 4-byte boundaries before upload.
- **2.3 GlobeTerrain.wgsl 404**: Replaced fetch-based shader loading with ES module import.
- **2.4 WebGLStubBuffer Too Small**: Added regrow logic when incoming data exceeds default 4096-byte buffer.

### Session 3 — Pipeline Stride
- **3.1 Index extends beyond limit**: Hard-coded stride assumptions broke when terrain encoding included webMercator + normals. Fixed by switching `_pipelines` to `Map<string, GPURenderPipeline>` keyed by `(isQuantized, hasNormals, isBlend, strideBytes)` with lazy creation.

### Session 4 — Black Screen Root Cause
- **4.1 `clear()` Color Override**: `clearCommand.color !== undefined` was true even when color was `false`. Fixed with explicit `!== false` guards on color/depth/stencil channels.
- **4.2 "size is zero"**: Three buffer creation methods bypassed `WebGPUBuffer.create()`'s size guard. Added `Math.max(size, 4)`.
- **4.3 Depth/Stencil Boolean Clear**: Passed booleans where `1.0`/`0` numerics were expected.

### Session 5 — Feature Renderer Destroy
- **5.1 Destroy Crashes**: `_destroyFeatureRenderers()` called destroy with no args; FRs needed their owning scene object. Removed the destroy() calls — GPU resources freed automatically on device destruction.
- **5.2 WebGLStubBuffer Regrow**: Padded branch wasn't checking regrow. Moved logic before branch.
- **5.3 Index Validation**: Some terrain tiles had indices beyond vertex buffer size. Added clamp-to-valid-triangles.
- **5.4 Splitscreen Initial Sync**: Added explicit initial `copyCamera()` after listeners.

### Session 6 — Pipeline Compilation
- **6.1 Uniform Control Flow**: `textureSample`/`textureSampleCompare` required uniform control flow. Moved shadow check to top of fragment, replaced `textureSample` with `textureSampleLevel(..., 0.0)`.
- **6.2 DepthPlane Format Mismatch**: rgba8unorm vs bgra8unorm. Pass `presentationFormat` as `colorFormat`.
- **6.3 DepthPlane RTE Encoding**: `EncodedCartesian3.fromCartesian` parameter type mismatch. Rewrote with `encode` per-component.
- **6.4 Billboard Buffer NaN**: `Math.max(Number(options.size) || 4, 4)` handles NaN/undefined.
- **6.5 Readback Buffer Zero**: `Math.max(bytesPerRow * height, 4)`.
- **6.6 Expired Ion Token**: Removed from test page.

### Session 7 — Build System
- **7.1 typescript-eslint version**: Bumped to ^8.58.0.
- **7.2 Asset Path**: `buildCesiumViewer` uses `Build/CesiumUnminified/` for dev mode.
- **7.3 JSDoc Errors**: Multiple files (`RenderCommand.js`, `Scene.js`, `WebGPUPointPrimitiveRenderer.js`).
- **7.4 WebGPU Type Stubs**: Added `Tools/jsdoc/webgpu-stubs.d.ts`.
- **7.5 RenderState.releaseCache()**: Added public wrapper for `removeFromCache()`.
- **7.6 Imagery Texture Cache Fields**: Added `sourceWidth`/`sourceHeight`.

### Session 8 — Environment Command Injection
- **8.1 Environment Commands Not Reaching WebGPU**: Commands stored on `environmentState`, not in frustum command list. Added injection into farthest frustum's ENVIRONMENT pass slot.
- **8.2 setVertexBuffer TypeError**: Some env commands had wrapped buffer objects. Added try-catch in `executeBatch()` with one-shot per-error logging.

### Session 9 — Environment Injection Fix (Take 2)
- **9.1 Bypass Discovery**: Session 8 injection lived in `ViewportExecutor` but Scene bypassed it for WebGPU. Moved injection into `Scene._injectEnvironmentCommandsForWebGPU()` before alternate renderer call.

### Session 10 — Imagery & Cubemap
- **10.1 imagery.image Released Too Early**: `_createTexture()` set `imagery.image = undefined` after WebGL upload. Added `if (!context.isWebGPU)` guard.
- **10.2 First Frustum Color Clear**: First frustum now clears color to background color.
- **10.3 SkyAtmosphere Async Fetch**: Switched to direct ES module import.

### Session 11 — Imagery Reprojection Crash + CubeMap Depth-Stencil
- **11.1 _reprojectTexture Crash**: WebGPU FR path didn't return — fell through to WebGL `ComputeCommand` creation. Added early return + backend-agnostic fallback (FR existence check, not isWebGPU).
- **11.2 CubeMapPanorama Depth-Stencil Mismatch**: Pipeline had `depthStencil: undefined` but render pass had `depth24plus-stencil8`. Added depth-stencil with `depthWriteEnabled: false, depthCompare: "always"`.
- **11.3 setVertexBuffer Edge Cases**: Caught by try-catch from S8.

### Session 12 — Build System + Shader Debug
- **12.1 gulp build Missing WGSL/TSC**: `build()` only ran esbuild bundling. Added `wgslToJavaScript()` and `await tsc()` at top.
- **12.2 writeBuffer Floats vs Bytes**: Third arg should be bytes, was passing float count. Fixed to `data.byteLength`.
- **12.3 Diagnostic Property Typo**: `_diagFrameCount` didn't exist; changed to `_diagTileCount`.
- **12.4 Shader Version Mismatch Discovery**: Two GlobeTerrain.wgsl versions existed. Aligned with the 68-float CameraUniforms.
- **12.5 layerCount Always 0 Investigation**: Bind group + writeBuffer + pipeline all verified correct, but `tile.layerCount` read as 0. Resolved in S13 (Bug 13.5).

### Session 13 — Imagery Pipeline + WebGL Stub Logging
- **13.1 Imagery Stuck in TRANSITIONING**: Catch block left state in TRANSITIONING with no retry. Reset to TEXTURE_LOADED on error.
- **13.2 SkyAtmosphere First-Frame Async Miss**: `await getShaderSource()` deferred to microtask. Removed async/await.
- **13.3 ImageryLayer Creating WebGL Textures via Stub**: Added WebGPU early path with placeholder + image preservation.
- **13.4 Placeholder Texture Missing destroy()**: Crash on tile trim. Added no-op destroy().
- **13.5 layerCount u32 Not Readable in WGSL**: Mixed u32/f32 after array<ImageryLayer> caused read-as-zero. Changed to f32 in struct + writer.
- **13.6 wgslToJavaScript Not Awaited**: Async function called sync, broke clean builds. Added `await`.
- **13.7 Texture Y-Flip**: WebGL bottom-left vs WebGPU top-left. Added `flipY: true` to `copyExternalImageToTexture` calls.
- **13.8 Build System Improvements**: `gulp clean` now removes WGSL→JS wrappers + package builds; `npm run restart`.

### Session 14 — webMercatorT Shader Support + UV Stretching
- **14.1 webMercatorT Not Passed Through Shader**: WGSL had no webMercatorT support. Added 5 vertex entry points + per-layer `useWebMercatorTLayer: vec4<f32>` + fragment `select()` for V coordinate.
- **14.2 Quantized Terrain webMercT Decompression**: `compressed0.w` is webMercT (not encodedNormal) for quantized BITS12. New `vertexMainQuantizedWebMerc` entry point.
- **14.3 Back-Face Culling Regression**: `octDecode(0.0)` produced normal `(0,0,-1)`. Sentinel changed to 32896.0 (≈+Z).
- **14.4 Vertex Format Mismatch (webMercT+Normals)**: 4-float layout needed `float32x4` not `float32x3`.
- **14.5 SceneMode.SCENE2D Check**: `scene.mode !== 0` was wrong (0 = MORPHING). Changed to `!== 2`.
- **14.6 Spammy Per-Tile Logs**: Removed dead `_diagLogged` flag.

### Session 15 — LOD Unlock + texCoordsRect Alpha
- **15.1 Vertical Stripes from texCoordsRect Clamping**: WebGL uses texCoordsRect for alpha masking, not UV clamping. Removed clamp, added `texCoordsAlpha()` `step()`-based mask.
- **15.2 Only LOD 0 Tiles Rendered**: `tile.renderable = defined(surfaceTile.vertexArray)` was false for WebGPU. Added `|| (mesh && mesh.vertices && mesh.indices)` OR.
- **15.3 Fill Tile Stride Mismatch**: Added stride inference: `vertices.length / (maxIdx + 1)`.
- **15.4 Diagnostic Counter Never Stopping**: `_diagTileCount++` was inside its own check.

### Session 16 — Architecture Cleanup, Shadow Casting, Performance
- **16.1 panoramaCommandList Never Cleared**: `updateFrameState()` cleared other lists but not panorama. Added clear.
- **16.2 Camera Jitter (Improved)**: Tightened staleness thresholds (100m→50m, 0.999→0.9995), added `ASYNC_PICK_DISTANCE_RATIO = 1.5x` rejection vs ray pick.
- **16.3 Shadow Cast Lists Cleared Before Reading**: Move clear after collection.
- **16.4 Shadow Map Point Light Guard**: `!shadowMap._isPointLight === false` is `(!_isPointLight) === false`. Fixed to `shadowMap._isPointLight`.
- **16.5 Shadow Map Bias Path**: `_bias` undefined. Use `_primitiveBias || _terrainBias`.
- **16.6 isWebGPUDrawCommand Removed from All Scene Code**: 8 violations across 5 files replaced with duck-typing. Result: zero `isWebGPUDrawCommand` checks in Scene.
- **16.7 Render Bundles Activated**: Globe pass uses bundle encoder when 8+ tiles.
- **16.8 Ring Buffer Allocator Wired**: 4MB pages, triple-buffered, 256-byte alignment.
- **16.9 Shadow Cast Pass Added**: `executeShadowMapCastCommands(scene)` before multi-frustum loop.
- **16.10 First WebGPU Unit Tests**: 5 spec files, ~45 tests.

### Session 17 — Feature Wiring + Full Shader + Performance
- **17.1 GROUND_ATMOSPHERE Wired**: `Globe.js beginFrame()` calls FR.
- **17.2 Full GlobeTerrain.wgsl Restored**: Lighting, fog, atmosphere, shadows, ocean, night effects, clipping. Used `selectLayerUV()` per layer.
- **17.3 GPU Frustum Culler Activated**: Lazy-init singleton, async readback.
- **17.4 Pipeline Warm-up**: Globe renderer + GPU culler pre-init at context creation.
- **17.5 Post-Process Pipeline Verified**: Already complete.
- **17.6 FR Audit**: FOG, PROCEDURAL_CLOUDS, SSR, WEATHER_PARTICLES already wired in `_executeEnvironmentalEffects()`. Only GROUND_ATMOSPHERE was truly unwired.

### Session 18 — Parity Closure
- **18.1 Viewport Quad**: `WebGPUViewportQuad.ts` (NEW) — pipeline cache, bind group auto-detect, fullscreen triangle. Integrated into `WebGPUContext.createViewportQuadCommand`.
- **18.2 Labels with SDF**: `WebGPULabelRenderer.js` (NEW) + `BillboardCollectionSDF.wgsl` (NEW). 5-tap supersampling, outlines, screen-space derivative AA. Added `LABEL_COLLECTION = 36`.
- **18.3 Weather Particle Render Pass**: `WeatherParticleRender.wgsl` (NEW) — camera-facing instanced quads, per-type fragments.
- **18.4 2D / Columbus View Mode**: Globe terrain shader scene-mode branching (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D), planar position helpers, extended CameraUniforms.

### Session 19 — Renderer Verification, BufferPrimitives, Mobile Perf, UBO Cleanup
- **19.1 Renderer Bug Audits**: `WebGPUEllipsoidPrimitiveRenderer` viewport size pack (40→44 floats); `WebGPUGaussianSplatRenderer` focal length from projection matrix; `WebGPUPointCloudEyeDomeLighting` reduced to documented no-op stub.
- **19.2 Buffer Primitive Collections**: NEW `WebGPUBufferPrimitiveRenderer.ts` (~1000 lines) handles polygon/polyline/point. Camera UBO matches standard 368-byte struct. Shader fixes: `camera.projection`/`camera.viewport` → `camera.projectionMatrix` + per-shader viewport.
- **19.3 Transient Render Attachments**: `WebGPUFramebufferManager.getRenderPassDescriptor()` forces `storeOp: "discard"` on MSAA color + non-samplable depth so tile-based mobile GPUs keep them on-chip.
- **19.4 UBO Size Cleanup**: Tightened 256-byte UBOs to 96-176 bytes for static bindings.

### Session 20 — ParticleSystem, BufferPrimitive Picking, WGF-1, WGF-6
- **20.1 General ParticleSystem (no-op closure)**: Already routes through `WebGPUBillboardRenderer` via `BillboardCollection`.
- **20.2 Buffer Primitive Picking**: `PICK_FRAGMENT_SUFFIX` appends `fragmentPickMain` to each preprocessed shader. Per-collection pick pipelines + pick ID allocation via `context.createPickId`.
- **20.3 WGF-1 Subgroups Wired Into GPU Culler**: `FrustumCull.wgsl` `mainSubgroups` entry point uses `subgroupBallot` to collapse per-thread atomicAdd into one per subgroup. `WebGPUGPUCuller.initialize()` picks entry point with try/catch fallback.
- **20.4 WGF-6 `@builtin(primitive_index)`**: NEW `csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` (capability probe via pushErrorScope, face color WGSL, primitive pick WGSL, RGBA decoder).

### Session 21 — Tier-2 Cleanup (WGF-3, WGF-5, WGF-6, WGF-7, WGF-8)
- **21.1 WGF-5 Texture Component Swizzle**: `swizzleChannel()` if-else replaced with dynamic vector subscript `texColor[clamp(i32(idx), 0, 3)]`.
- **21.2 WGF-8 EXIF/orientation**: NEW `WebGPUImageUpload.ts` (~210 lines) + `WebGPUContext.createTextureFromImageAsync()`. Uses `createImageBitmap(source, { imageOrientation: "from-image" })`. Sync fast path preserved.
- **21.3 WGF-6 Wiring**: WebGPUContext caches `WebGPUPrimitiveIndexUtils` after device creation; Scene gets `triangulationDebugSupported` getter.
- **WGF-3 audit**: No work needed — sampler-as-let already used.
- **WGF-7 audit**: No work needed — formats already optimal for current compute kernels.

### Session 22 — Unit Tests + debugShowTriangulation Wiring
- **22.1 Unit Test Coverage**: NEW `WebGPUPrimitiveIndexUtilsSpec.js`, `WebGPUSubgroupUtilsSpec.js`, `WebGPUImageUploadSpec.js`. GPU-gated paths use `pending()` fallback.
- **22.2 debugShowTriangulation Production Wiring**: Scene flag forwarded to frameState; `WebGPUGlobeSurfaceRenderer` augmented shader module (vertex stages reused, `fragmentDebugTri` appended), cold-path `_selectDebugTriPipeline()` separate from production cache.

### Session 23 — Tier 1 Render Debug Features
- **23.1 Globe Wireframe**: Refactored orphaned `_wireframePipelines[4]` array into `_wireframePipelineCache: Map<string, GPURenderPipeline>` keyed by stride. Cold-path selector + IB swap to line-list indices.
- **23.2 SkyAtmosphere Scattering Bypass**: NEW `debug: vec4<f32>` uniform field. `debug.x > 0.5` returns flat magenta. Reserved offsets 53-55 for Tier 3.
- **23.3 SkyBox Cubemap Face Isolation**: Per-face fragment discard via dominant axis test. Encoding 0=all, 1=+X..6=-Z.

### Session 24 — Tier 2 Debug Features + Refactor
- **24.1 Unified Debug Fragment Pipeline**: Replaced per-feature `_debugTri*` cluster with `DebugFragmentMode` enum (NONE/TRIANGULATION/LOD/NORMAL), single `_debugFragmentShaderModule`, single `_debugFragmentPipelineCache` + `_selectDebugFragmentPipeline()`. Adding new variants is now one entry point + one enum value.
- **24.2 tile.debugFields vec4**: `.x = tileLevel`, `.y = isolateImageryLayer`, .z/.w reserved. `TILE_UNIFORM_FLOATS` 92→96.
- **24.3 LOD Color Overlay**: `fragmentDebugLod` 12-color palette via WGSL `switch`.
- **24.4 Normal-as-Color**: `fragmentDebugNormal` reads + remaps `v_normalEC`.
- **24.5 Imagery Layer Isolation**: Multiplicative mask in production fragmentMain.
- **24.6 Depth-as-Color Overlay**: NEW `WebGPUDebugDepthOverlay.ts` (~230 lines). Sampleable depth opt-in via `WebGPURenderTarget.depthSamplable`. Cold-path integration in `_runPostProcessing` swaps in overlay for production post-process chain. Non-MSAA only.

### Session 25 — Architecture Audit + Stale Backlog Cleanup
- **BUG-4 Fix**: Split-screen camera sync `syncingCamera` guard reset deferred to next animation frame.
- **BUG-7 / SHADOW-LAYOUT**: Discovered that shadow cast pipeline assumes single fixed vertex layout (stride 24, two `float32x3` for RTE positionHigh/positionLow). Added stride filter as safety net; per-layout cache deferred.
- **NEW-1 Resolved**: `DynamicEnvironmentMapManager` sync `readPixels` was already on a WebGL-only branch — non-issue.

### Session 26 — Backlog Audit, AtmosphereLUT Consumer, PointCloudLOD Subgroup Dispatcher, 3D Tiles Indirect Draw, BUG-11 Audit, Naga-wasm Spike
- **Backlog audit**: Pruned 9 stale entries (FORK-19 specs exist, FORK-17 mipmaps wired, FORK-34 already done, Labels rendering done S18, Viewport quad done S18, Buffer primitives done S19, WGF-1 subgroups done S20, WGF-2 transient attachments done S19, AtmosphereLUT dispatch done S17). Added SUBGROUP-DISPATCH and ATMOS-LUT-CONSUMER (now both also resolved this session).
- **AtmosphereLUT consumer**: `SkyAtmosphere.wgsl` extended with `useLut` flag in Uniforms struct + `@group(1)` LUT bindings (sampler + transmittance + inscatter views) + `sampleScatteringLut()` fast path. `WebGPUSkyAtmosphereRenderer.js` builds the LUT bind group, dispatches compute on a transient encoder when sun direction changes (>0.0001 cos delta), falls back to a 1×1 placeholder + ray march path when compute is unavailable. `useLut` uniform field set based on dispatch success.
- **PointCloudLOD subgroup dispatcher**: New `WebGPUPerformanceManager.dispatchPointCloudLOD()` lazily preprocesses the WGSL source (prepends `enable subgroups;` on capable devices, strips `__SUBGROUP_BLOCK_*__` sentinels otherwise) and selects `computeMainSubgroups`/`computeMain` accordingly. Cached per device. Plus `pointCloudLODUsesSubgroups()` diagnostic.
- **3D Tiles indirect-draw integration**: New `executeBatchIndirect()` in `WebGPUSceneRenderer.ts` scans command lists for runs of ≥2 commands sharing pipeline + bind groups + index buffer, batches them through `WebGPUIndirectDrawManager.submitBatch` + `executeBatchIndexed`. Wired into `_execute3DTilePasses` behind `context.useIndirectDrawForTiles` flag (off by default). Single setPipeline + N drawIndexedIndirect per homogeneous run.
- **BUG-11 imagery audit (no fix, code-level only)**: Static analysis ruled out bind-group sample-type mismatch, std140 alignment drift, day/night alpha argument swap, stale uniform leakage. Two top runtime suspects documented: (A) reprojection clear alpha=0 collapsing `tex.a * effectiveAlpha` to zero, (B) zero `texCoordsRect`. Probe checklist added for next browser session.
- **Naga-wasm spike**: NEW `WebGPUNagaTranspiler.ts` with lazy `import("naga-wasm")`, FNV-1a-keyed transpile cache, graceful unavailable-fallback. Wired into `WebGLStubShader.shaderSource` + `compileShader` so stub shaders carry `_glslSource`/`_wgslReady`/`_wgsl` fields. Activation: `npm install naga-wasm`. Open follow-ups: bind-set remapping, vertex attribute location remapping.
- **WebGLStubShader fix**: `maxInterStageShaderComponents` renamed to `maxInterStageShaderVariables` in newer `@webgpu/types` — read either via cast.

### Session 27 (2026-04-12 Session 2) — ES6 Modernization, Type Safety, Security, Stubs Overhaul, MaterialUniformBuffer, Build Variants

No new rendering bugs introduced. This session was a quality/architecture sweep:

- **ES6-CODEMOD-1**: 424 files converted from prototype-based classes to ES6 classes via jscodeshift. No behavior changes; pure syntax modernization.
- **ES6-INCLUDES-1**: ~90 `.indexOf() !== -1` patterns replaced with `.includes()`. No behavior changes.
- **SECURITY-1 (InfoBox XSS)**: Entity description `innerHTML` in `InfoBox.js` was assigned unsanitized from external data sources. Fixed by adding DOMPurify sanitization with a configured allowlist. Root cause: direct DOM injection without sanitization. Files: `packages/engine/Source/Widgets/InfoBox/InfoBox.js`.
- **TS-ANY-1**: 34 `as any` casts eliminated in `WebGPUSceneRenderer.ts` and `WebGPUGlobeSurfaceRenderer.ts` by declaring the missing private fields and importing proper types from new `cesium-js-types.d.ts`. Root cause: JS classes used from TS without declarations.
- **TS-ANY-2**: ~55 `: any` parameter annotations replaced with proper ambient types in `WebGPUBufferPrimitiveRenderer.ts`, `WebGPUPickFramebuffer.ts`, and other renderer files. Root cause: same — JS class types unavailable to TS.
- **STUB-OVERHAUL-1**: `WebGLStubTexture.ts` was a near-complete no-op (texImage2D did nothing, generateMipmap did nothing). Fixed by implementing real WebGL→WebGPU translation. Root cause: stub was scaffolded but never filled in.
- **STUB-OVERHAUL-2**: `WebGLStubShader.ts` returned `0` for all `getParameter()` queries. Fixed by reading real values from `device.limits`. Root cause: same scaffolding gap.
- **MATERIAL-UB-1**: Material uniforms were repacked as JS objects every frame regardless of whether any property changed. Fixed by `MaterialUniformBuffer` with dirty tracking + Float32Array backing. Root cause: performance gap in material upload path; not a correctness bug.
- **DEP-REMOVE-1**: `urijs` import caused bundle bloat and an unmaintained third-party dep. Removed; replaced with native `URL` API across 12 files.

### Bug Pattern Analysis (cumulative across all sessions)
1. **API mismatch** (6+): Callers passing wrong parameter types/order to WebGPU buffer/pipeline creation
2. **Silent failures** (5+): Errors swallowed by missing guards
3. **WebGL→WebGPU assumption gaps** (4+): Boolean vs numeric clear values, texture format mismatches, 4-byte alignment, top-left vs bottom-left UV
4. **Buffer sizing** (4+): Zero-size, NaN-size, undersized buffers
5. **Architecture gaps** (2+): Environment pass routing, pipeline stride assumptions
6. **Async/event ordering** (3+): SkyAtmosphere first-frame microtask, splitscreen guard reset, async depth feedback loops

### Most Frequently Modified Files
1. `WebGPUGlobeSurfaceRenderer.ts` — terrain pipeline is the most complex (Sessions 2, 3, 5, 7, 14, 15, 17, 19, 22, 23, 24)
2. `WebGPUSceneRenderer.ts` — frame orchestration touches many systems (Sessions 1, 3, 4, 6, 16, 17, 18, 24, 26)
3. `WebGPUContext.ts` — core context affects everything (Sessions 4, 6, 16, 17, 18, 19, 21)
4. `GlobeTerrain.wgsl` — fragment shader churn (Sessions 2, 6, 14, 15, 17, 18, 23, 24)

---

## 5. WASM & Compute Audit Results

### WASM Bridge Compliance Matrix (All Complete — April 2026)

| Bridge | destroy() | free_buffer() | Version Check | SIMD Detection | JS Fallback | Error Handling |
|--------|-----------|---------------|---------------|----------------|-------------|----------------|
| WasmCullBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmSortBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmHeightmapBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmQuantizedMeshBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmRTEBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmMatrixBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmPointCloudBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`WasmFeatureDetection.js` provides shared `checkSIMDSupport`, `checkModuleSIMD`, `checkVersionMatch`, `freeBuffer`. All bridges have `_isDestroyed` guard + try/catch with automatic JS fallback. Rust `lib.rs` uses `try_reserve()` for OOM-safe allocation.

### GPU Compute vs WASM Decision Matrix

| Task | Best Approach | Shader / Bridge |
|------|--------------|------------------|
| Terrain tessellation | WASM | WasmHeightmapBridge / WasmQuantizedMeshBridge |
| Frustum culling (>50K) | GPU Compute | `FrustumCull.wgsl` (active, with subgroup variant) |
| Frustum culling (<50K) | WASM SIMD | `WasmCullBridge.js` |
| Atmosphere LUT | GPU Compute | `AtmosphereLUT.wgsl` (active, with shader consumer) |
| Point cloud sort | GPU Compute (>50K) / WASM | `PointCloudSort.wgsl` (dispatch wired, host integration pending) / `WasmPointCloudBridge.sortByDistance()` |
| Point cloud LOD | GPU Compute (>50K) / WASM | `PointCloudLOD.wgsl` (subgroup variant + dispatcher) / `WasmPointCloudBridge.lodFilterAndSort()` |
| Sort keys (>50K) | GPU Compute | `GPUSortKeys.wgsl` (dormant — JS comparators always active) |
| Sort keys (5K-50K) | WASM radix sort | `WasmSortBridge.js` |
| Hi-Z occlusion | GPU Compute | `HiZPyramid.wgsl` + `OcclusionTest.wgsl` (dormant) |
| Polygon SDF | GPU Compute | `PolygonSignedDistance.wgsl` (active) |
| IBL (BRDF LUT, irradiance, radiance) | GPU Compute | `BrdfLutGenerate.wgsl`, `IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl` (all active) |

### GLSL Backport Analysis (April 2026) — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping (5 modes), Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA, GroundAtmosphere |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean (Fresnel/GGX/foam/SSS), enhanced night (terminator glow, city lights emission), terminator glow |

### IBL Pipeline (Complete)

| Shader | Purpose | Dispatch Site |
|--------|---------|---------------|
| BrdfLutGenerate.wgsl | BRDF integration LUT (split-sum IBL) | `WebGPUIBLPipeline.ts` (one-time, init) |
| IrradianceConvolution.wgsl | Diffuse irradiance cubemap convolution | `WebGPUIBLPipeline.ts` (env map change) |
| RadiancePrefilter.wgsl | Specular pre-filtered mipchain | `WebGPUIBLPipeline.ts` (env map change) |
| ImageBasedLighting (TS) | SH coefficients + specular orchestration | `WebGPUImageBasedLighting.ts` |
| ModelPBRComplete.wgsl | IBL-aware ambient (split-sum) | Per-frame model fragments |

### Night & Ocean Rendering Enhancements (April 2026)

**Night side**:
- Terminator: `NdotL * 5.0 + 0.5` sharp boundary (matches GLSL)
- Night-side darkness: 0.025 moonlight ambient + 0.04 base color
- City lights emission: additive boost when `nightAlpha > dayAlpha`, luminance-weighted
- Configurable `nightIntensity` uniform (default 2.5x)
- Terminator glow: warm orange Gaussian at NdotL≈0
- Night-side fog: dimmed to 5% on dark side

**Ocean/Water**:
- 3-octave wave normals (400×, 200×, 800× UV) with weighted blend
- Distance-scaled wave strength: `mix(0.25, 0.05, smoothstep(10K, 500K, dist))`
- GGX/Trowbridge-Reitz specular (roughness 0.08) for sun glints
- Schlick Fresnel (F0=0.04, power 5.0)
- Deep water color blend to `(0.008, 0.045, 0.12)`
- Subsurface scattering: forward-scatter turquoise rim at grazing angles
- Foam/whitecaps: steepness-based threshold 0.35, distance-faded
- Sky reflection via Fresnel at 50%
- Smooth coastline transition `smoothstep(0.3, 0.7, waterMask)`
- Night ocean: `mix(0.08, 1.0, dayFade)` very dark at night
- 8 configurable uniform floats: deep color, Fresnel, reflectivity, foam threshold, darkening, night intensity

---

## 6. Render Pass Coverage

All 13 CesiumJS render passes are handled in the WebGPU path. ENVIRONMENT runs before the WebGPU branch via `renderEnvironment()` in SceneRenderer.js; all other passes are in `WebGPUSceneRenderer.ts`.

| Pass | ID | Handler | Status |
|------|----|---------|--------|
| ENVIRONMENT | 0 | `renderEnvironment()` in SceneRenderer.js (before branch) + injected into farthest frustum (S8/S9) | ✅ |
| COMPUTE | 1 | Handled by individual compute dispatches | ✅ |
| GLOBE | 2 | `_executeGlobePass()` (with render bundle when ≥8 tiles) | ✅ |
| TERRAIN_CLASSIFICATION | 3 | `_executePassCommands(Pass.TERRAIN_CLASSIFICATION)` | ✅ |
| CESIUM_3D_TILE_EDGES | 4 | `_execute3DTilePasses()` (optional indirect-draw fast path S26) | ✅ |
| CESIUM_3D_TILE | 5 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION | 6 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW | 7 | `_execute3DTilePasses()` | ✅ |
| OPAQUE | 8 | `_executeOpaquePass()` | ✅ |
| TRANSLUCENT | 9 | `_executeTranslucentPass()` (OIT MRT path with auto-variant creation) | ✅ |
| VOXELS | 10 | `_executePassCommands(Pass.VOXELS)` | ✅ |
| GAUSSIAN_SPLATS | 11 | `_executePassCommands(Pass.GAUSSIAN_SPLATS)` | ✅ |
| OVERLAY | 12 | `_executeOverlayPass()` | ✅ |

Additional WebGPU-specific passes:
- **Pick pass** — `_executePickPass()` (GLOBE, 3D_TILE, OPAQUE, TRANSLUCENT)
- **Shadow cast pass** — `executeShadowMapCastCommands()` before multi-frustum loop (Session 16)
- **Environmental effects** — `_executeEnvironmentalEffects()` (SSR, Weather, Clouds, Weather render)
- **Post-processing** — `_runPostProcessing()` (Tonemapping, FXAA, Bloom, SSAO, DoF, Edge, Silhouette)
- **Debug depth overlay** — `_executeDebugDepthOverlay()` (cold path, swaps in for production post-process)
- **Performance infrastructure** — `beginFrame()`/`endFrame()` for render bundles, indirect draws, profiling, ring buffer

### Init Chain (verified)

```
Viewer.createAsync(container, { contextOptions: { renderer: 'webgpu' } })
  ├─ Creates LoadingOverlay
  ├─ CesiumWidget.createAsync(tempDiv, options, onProgress)
  │   ├─ Scene.createAsync(canvas, options)
  │   │   ├─ ContextFactory.createContext(canvas, { renderer: 'webgpu' })
  │   │   │   ├─ navigator.gpu.requestAdapter()
  │   │   │   ├─ adapter.requestDevice({ requiredFeatures: [...] })
  │   │   │   └─ new WebGPUContext(canvas, device, adapter)
  │   │   │       ├─ _initialize() — creates default texture, sampler, depth format
  │   │   │       ├─ _warmUpPipelines() — pre-compile globe + GPU culler
  │   │   │       ├─ registerWebGPUFeatureRenderers(context) — all 36 FRs (+ 7 lazy)
  │   │   │       └─ Matrix4.setDepthRangeType('webgpu') — 0-1 NDC
  │   │   └─ new Scene(options) with _preInitializedContext
  │   └─ new CesiumWidget(container, { _preInitializedScene: scene })
  ├─ new Viewer(container, { ...options, _preInitializedScene: widget.scene })
  │   └─ new CesiumWidget(cesiumWidgetContainer, { ..., _preInitializedScene })  ← FIXED S0
  └─ Removes LoadingOverlay
```

---

## 7. Industry Comparison

| Engine | Architecture | Shader Strategy | Our Comparison |
|--------|-------------|----------------|----------------|
| **Babylon.js** | `ThinEngine` abstract -> `Engine`/`WebGPUEngine`. Zero `if(isWebGPU)` in scene code. | GLSL -> SPIRV -> WGSL transpilation | We have `GraphicsContext` abstract + Feature Renderer pattern. 36 of 36 keys registered. |
| **Three.js** | `WebGPURenderer` drop-in for `WebGLRenderer`. Node-based TSL generates both GLSL/WGSL. | TSL node graph -> both backends | We use hand-written WGSL (higher quality) + optional Slang + new naga-wasm spike. |
| **PlayCanvas** | `GraphicsDevice` base. GPU-driven rendering with indirect draws. Ring-buffer uniforms. | GLSL + WGSL | Similar abstract base. GPU-driven infrastructure built and selectively activated. |

### Feature Comparison Matrix

| Feature | CesiumJS WebGPU | Babylon.js 7 | Three.js r170 | PlayCanvas 2 | Filament | Bevy 0.15 |
|---------|----------------|--------------|---------------|--------------|----------|-----------|
| **PBR (metallic-roughness)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **IBL (full pipeline)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SSAO** | ✅ | ✅ SSAO2 | ✅ | ✅ | ✅ | ✅ |
| **SSR** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Bloom** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **DoF** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **TAA** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Motion Blur** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Shadow Casting** | ⚠️ stride-24 only | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CSM** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **GPU Particles** | ⚠️ Weather only | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Volumetric Fog** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Render Bundles** | ✅ Activated | ✅ | ⚠️ Partial | ✅ | N/A | ✅ |
| **Indirect Draw** | ✅ Wired (opt-in) | ✅ | ⚠️ Partial | ✅ | ✅ | ✅ |
| **Compute Shaders** | ✅ 6 active / 4 ready / 2 dormant | ✅ | ✅ | ✅ | ✅ | ✅ |
| **f16 Shaders** | ⚠️ Detected unused | ⚠️ Partial | ✅ | ❌ | ✅ | ❌ |
| **Subgroups** | ✅ Wired (FrustumCull, PointCloudLOD) | ❌ | ❌ | ❌ | N/A | ❌ |
| **64-bit Precision (RTE)** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-Frustum** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Globe Terrain** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GIS Picking** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |

### Our Unique Strengths

1. **Planetary-scale RTE 64-bit precision** — No other WebGPU engine handles planetary scale
2. **Multi-frustum depth management** — Depth precision at all zoom levels
3. **Globe terrain with quadtree LOD** — Tile-center RTE encoding (correct approach)
4. **GIS picking** — Height sampling, terrain-aware, async depth readback with staleness validation + distance-ratio rejection
5. **Material system** — All 25 built-in CesiumJS materials mapped to WGSL
6. **3D Tiles integration** — Works automatically via Model chain (zero 3D Tiles code changes)
7. **Subgroup operations in production** — Used in `FrustumCull` mode 2 and `PointCloudLOD` for prefix-sum compaction
8. **Compute-precomputed atmosphere LUT** — `AtmosphereLUT.wgsl` produces transmittance + inscatter tables; `SkyAtmosphere.wgsl` samples them via fast path

---

## 8. Relationship with Upstream CesiumJS

### What We Modify in Upstream

- **Scene files** — WebGPU routing via `getFeatureRenderer()` pattern (~1 line per file, 31+ files)
- **Build system** — WGSL shader compilation, multi-variant build (WebGL-only / WebGPU-only / dual)
- **Package config** — `@webgpu/types` dependency
- **Widget files** — `createAsync()` + `LoadingOverlay`
- **Context.js** — ES6 class + extends `GraphicsContext`

### What We Add (never conflicts)

- `packages/engine/Source/Renderer/WebGPU/` — 105+ files
- `packages/engine/Source/Shaders/WebGPU/` — 238+ WGSL shaders
- `Apps/WebGPUTest/` — 29 test pages
- `migration_doc/` — this documentation
- `scripts/build.js` + `bundleVariantPlugin.js` — multi-variant build infrastructure
- `scripts/analyzeBuild.js` — bundle analyzer
- `Tools/visual-regression/` — Playwright + hand-rolled PNG diff (no new deps)

### Upstream Sync Status

#### Second Sync (April 2, 2026): PR #13121 (Constant LOD) — 45 commits, ZERO conflicts
- **0 commits behind** upstream after sync
- **27 commits ahead** (26 WebGPU additions + 1 merge commit)
- Two-parent merge commit verified
- Build passes (exit code 0)

**New upstream feature (Constant LOD):**
- `computeTextureTransform.glsl` — new `czm_computeTextureTransform()` builtin function for `KHR_texture_transform`
- `ConstantLodStageFS.glsl` + `ConstantLodStageVS.glsl` — distance-based constant LOD texture lookup
- `MaterialPipelineStage.js` — new `processConstantLod()` function

**Our modifications preserved through merge:**
- `InstancingPipelineStage.js` line 77: `|| frameState.context.isWebGPU` (keepTypedArray for WebGPU)
- `SkinningPipelineStage.js` line 5: `extractSkinData` from `ModelSkinData.js`
- `LightingStageFS.glsl`: Full multi-light system

**WGSL equivalent now landed:**
- `csm_computeTextureTransform.wgsl` — built

#### First Sync (March 2026): v1.135–v1.140 — 507 commits, 12 conflicts resolved

| Version | Notable Changes |
|---------|----------------|
| **v1.140** | BufferPrimitive collections (vector tile APIs), Billboards WebGL2 requirement, Gaussian splat perf, ClippingPolygon GPU perf |
| **v1.139** | **Cartesian2/3/4 ES6 classes** (aligned with our modernization), CubeMapPanorama, metadata in custom shaders |
| **v1.138** | Intel Arc GPU jitter fix, Megatexture→Texture3D for voxels, 2D/CV pick fixes |
| **v1.137** | BENTLEY point/line style extensions, edge visibility quad rendering, pickAsync |
| **v1.136** | pickAsync, terrain picking quadtrees |
| **v1.135** | 3D Tiles terrain provider, EXT_mesh_primitive_edge_visibility |

**Conflict Resolution Summary**:
| File | Strategy |
|------|----------|
| `package.json` (4) | Accept upstream versions, keep our additions |
| `Context.js` | Keep ours (ES6 class) |
| `VertexArray.js` | Keep ours + add new methods |
| `SkyBox.js` | Keep ours + apply fix |
| `SSCCModeHandlers.js` | Apply upstream zoom fix |
| `Material.js`, `RenderState.js` | Keep ours |
| `CubeMapPanorama.js` | Keep ours |
| `StaticGeometry*Batch.js` | Keep ours |

---

## 9. Reference

### Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files (GLSL) | ~319 |
| WebGPU shader files (WGSL) | 238+ |
| Compute shaders | 12 (6 active, 4 dispatch-ready, 2 dormant) |
| Shader coverage (file count) | ~75% |
| Shader coverage (functional) | ~95% |
| Builtin function chunks | 91+ WGSL (of 90 GLSL — 101% coverage) |
| CsmBuiltins.js entries | 97 (91 functions + 6 structs) |
| WebGPU renderer files | 108+ |
| WebGPU renderer LOC | ~47,000 |
| Feature renderer keys | 38 (36 registered + COUNT + DEFERRED_GBUFFER reserved) |
| Feature renderers scene-wired | 36 of 36 (100%) |
| Lazy-loaded feature renderers | 7 (Gaussian splat, point cloud, point cloud EDL, voxel, SSR, weather particles, procedural clouds) |
| Scene features with WebGPU | 30+ of 33+ (~92%) |
| Rendering passes functional | 13 of 13 (100%) |
| Test pages | 29 |
| Jasmine unit tests | 10 spec files (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler) |
| ES6 modernized files | ~499 (424 via codemod + ~75 prior manual) |
| TypeScript `as any` casts | 32 (down from 66; -34 this session) |
| TypeScript `: any` parameter annotations | ~20 remaining (down from ~75; -55 this session) |
| Verified working features | 10 (see Section 3) |
| Active bugs (rendering) | 4 (BUG-3 partially S18, BUG-5/6 edge cases, BUG-11 imagery audit) |
| Active bugs (architecture) | 0 (Session 16 cleanup) |
| WASM bridges | 7 of 7 fully compliant |
| Compute shader fallbacks | All have JS or WASM fallback |
| Backend-agnostic Scene code | Zero `isWebGPUDrawCommand` checks |
| Build variants | 3 (WebGL-only, WebGPU-only, dual) |
| Bundle size (dual ESM index.js) | 3.9 MB / 1.05 MB gzipped (-11% from pre-lazy-load baseline) |
| Debug visualization toggles | 8 (wireframe, triangulation, terrainLOD, terrainNormals, imageryLayer isolation, depthAsColor, atmosphereScattering bypass, cubemap face) |
| Removed third-party deps | 2 (`urijs`, `karma-ie-launcher`) |
| Security fixes | 1 (InfoBox.js XSS — DOMPurify sanitization for entity description innerHTML) |

### WebGPU Spec Features Enabled

Auto-detected: `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, `subgroups`, `subgroups-f16`, texture compression (BC/ETC2/ASTC).

### Build & Test Commands

```bash
npx gulp build              # Full build (WGSL → JS, then TSC, then esbuild)
npx tsc --noEmit            # TypeScript type-check
npm run build-wasm          # WASM release build
npm run build-wasm-debug    # WASM debug build
npm test                    # Jasmine spec suite
npm run restart             # clean → build → start
npx gulp buildAllVariants   # WebGL-only + WebGPU-only + dual variants
node scripts/analyzeBuild.js --build --treemap  # Bundle analyzer
```

### Development Workflow

1. **Before starting:** Review `.clinerules` / `CLAUDE.md`, verify backward compatibility
2. **File placement:** Always `packages/engine/Source/`, never root `Source/` (build output)
3. **New WebGPU features:** Use `RenderCommand` (Path B) + `getFeatureRenderer()` pattern
4. **Shared scene logic:** Must run BEFORE `if (context.isWebGPU)` branch
5. **RTE:** Always positionHigh/positionLow, never single position for world-space geometry
6. **ES6:** When touching a file, modernize it if making >10 lines of changes
7. **Feature parity:** Check both backends when adding/fixing features
8. **Async:** Never sync `readPixels` in render loop; always use `mapAsync` + `.then()`
9. **Debug visualization:** Add new toggles via the unified `DebugFragmentMode` enum + augmented shader module pattern (S24 architecture)
10. **Logging hygiene:** Wrap all non-critical `console.log`/`console.warn` calls in
    `//>>includeStart('debug', pragmas.debug);` ... `//>>includeEnd('debug');`
    pragma tags so they strip in production builds (zero runtime cost). The
    `stripPragmaPlugin` now handles both `.js` and `.ts` files. ONLY keep
    permanent (non-pragma) logs for `console.error` that indicates real
    rendering bugs — null blit targets, index buffer overflows, command
    buffer invalidation, device lost, shader/pipeline compile failures,
    infinite-loop sentinels. See the "Logging & Debug Pragmas" section in
    `CLAUDE.md` for the full policy and examples.

---

*For the full backlog of remaining work items, see `WEBGPU_MIGRATION_BACKLOG.md`.*
*For per-session bug fix details, see `WEBGPU_DEBUGGING_LOG.md` (preserved for historical reference; new findings should land here in Section 4 going forward).*
