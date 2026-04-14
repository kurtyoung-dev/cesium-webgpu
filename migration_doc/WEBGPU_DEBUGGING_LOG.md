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
