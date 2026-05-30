# Option B — Full Scene-in-Worker Migration

**Status:** Design / blocker inventory. Implementation deferred to a focused multi-week effort.
**Created:** 2026-04-11
**Owner:** WebGPU migration

This document is the answer to "what would it take to run a full Cesium Scene inside a Web Worker?" It is a follow-up to the **Renderer Threading Spike** session that landed:

- A live FPS counter ([PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js)) with 60-second rolling histogram + 1% lows / 1% highs
- A Canvas2D HUD overlay ([FpsOverlay.js](packages/engine/Source/Services/FpsOverlay.js))
- A worker host + worker scaffold with 3-tier crash recovery and shadow-state replay ([WorkerSceneHost.js](packages/engine/Source/Services/WorkerSceneHost.js), [RendererWorker.js](packages/engine/Source/Workers/RendererWorker.js), [WorkerSceneProtocol.js](packages/engine/Source/Services/WorkerSceneProtocol.js))
- A test page that exercises the multi-pane / multi-renderer pattern ([worker-renderers.html](Apps/WebGPUTest/worker-renderers.html))

The scaffolding is ready. The piece that **does not currently work** is `Scene` construction inside the worker — Cesium's `Scene` constructor calls `document.createElement` and `canvas.parentNode.appendChild` directly, neither of which exist in `DedicatedWorkerGlobalScope`. The deep review found that as the single hard blocker; everything else either works today or has a small fallback.

This doc lists every change Cesium needs to make `Scene` worker-safe. It's organized by subsystem, with a difficulty / risk grade for each.

---

## 1. Hard blockers — must fix for the worker to start at all

### 1.1 `Scene` constructor DOM access — **FIXED 2026-04-11**

**Where:** [Scene.js:190-225](packages/engine/Source/Scene/Scene.js#L190-L225)

The Scene constructor now detects worker mode (`typeof document === "undefined" || canvas.parentNode == null`) and passes a sentinel `{}` as the credit container instead of calling `document.createElement`. The destroy path was also updated to skip `parentNode.removeChild` in headless mode. Existing main-thread behavior is unchanged — the headless branch is only taken when there's no DOM.

### 1.2 `CreditDisplay` DOM construction — **FIXED 2026-04-11**

**Where:** [CreditDisplay.js:301](packages/engine/Source/Scene/CreditDisplay.js#L301)

`CreditDisplay` now detects `typeof document === "undefined"` at the top of its constructor and short-circuits all DOM construction. Internal state (`_currentFrameCredits`, `_staticCredits`, `_cesiumCredit`) is still initialized so `beginFrame` / `addCreditToNextFrame` / `addStaticCredit` work unchanged — they only manipulate internal data. The DOM-touching methods (`showLightbox`, `hideLightbox`, `update`, `endFrame`, `destroy`) early-return when `_headless === true`. Credits don't visibly appear in the worker pane; if a future iteration wants them, the host can render them on the main thread from a `MSG_CREDITS` payload.

### 1.3 `ScreenSpaceEventHandler` is DOM-bound

**Where:** [ScreenSpaceEventHandler.js](packages/engine/Source/Core/ScreenSpaceEventHandler.js) — instantiated by `Scene` constructor (and by `Camera` for default controls).

`ScreenSpaceEventHandler` calls `addEventListener("mousedown", ...)` etc. on the canvas. `OffscreenCanvas` does not implement `EventTarget`'s mouse/keyboard event interface in any browser as of 2026. Even if it did, the events fire on the main thread, not in the worker.

**Fix:** The worker needs a `WorkerScreenSpaceEventHandler` that:
1. Does NOT subscribe to canvas events.
2. Exposes the same `setInputAction(callback, type, modifier)` API.
3. Receives synthetic events from the host via the `MSG_INPUT_EVENT` protocol message and dispatches them to registered callbacks.

The host side already forwards via `WorkerSceneHost.forwardInput()` — it's a stub today (just logs) because the worker side has no consumer yet.

**Difficulty:** Medium (1-2 days). Mostly mechanical message routing, but the modifier-key tracking and double-click detection logic needs to move from the canvas event listeners to the message handler.
**Risk:** Medium. This is the first place where the `Scene` API surface diverges meaningfully from the in-thread version (no DOM events to subscribe to outside the host).

### 1.4 `requestAnimationFrame` is Chrome-only in workers

**Status:** ALREADY HANDLED — the worker's render loop falls back to `setTimeout(tick, 1000/60)` on Firefox/Safari. See [RendererWorker.js `_startRenderLoop`](packages/engine/Source/Workers/RendererWorker.js).

The fallback is not vsync-locked, so on a 144 Hz display the worker still ticks at ~60 Hz with some micro-jitter. For most use cases this is fine. If we ever need vsync alignment cross-browser, the fix is host-side rAF + `MSG_TICK` posts — adds main-thread coupling but unblocks Firefox.

---

## 2. Soft blockers — fail at runtime in specific paths

### 2.1 `ResizeObserver` and DPR

**Where:** Implicit in `CesiumWidget` and several scene resize hooks.

`Scene` itself doesn't directly call `ResizeObserver`, but anything that derives the canvas size from `getBoundingClientRect()` is broken inside the worker because OffscreenCanvas has no layout box.

**Fix:** The worker scene factory MUST be called with explicit `width` / `height` options (the host already passes them via the canvas size before `transferControlToOffscreen`). Any subsequent resize happens via `MSG_RESIZE` from the host's `ResizeObserver` on the parent `<div>`. The worker handler is in place ([RendererWorker.js `handleResize`](packages/engine/Source/Workers/RendererWorker.js)).

**Difficulty:** Already done in the host. The Scene side might still have a few `canvas.clientWidth` reads to clean up — audit needed.
**Risk:** Low.

### 2.2 `loadImage` / `Resource` use of `HTMLImageElement`

**Where:** [Resource.js](packages/engine/Source/Core/Resource.js) — many code paths use `new Image()` to load textures.

`HTMLImageElement` is **not** available in workers. The replacement is `createImageBitmap(blob)` which IS worker-safe. Cesium has partial support for ImageBitmap loading via `Resource.fetchImage({ preferImageBitmap: true })` but the default still goes through `Image()`.

**Fix:** When running in a worker, all image loading must go through the ImageBitmap path. This is one config flag flip per loader, but the call sites need to be located and audited.

**Difficulty:** Medium (1 day to audit, 0.5 day to switch defaults). Some loaders have already migrated; the remaining ones are likely the legacy WebGL imagery providers.
**Risk:** Medium — image decode behaviour is subtly different between `Image` and `createImageBitmap` (orientation, color space, alpha premultiply). Visual regressions possible.

### 2.3 `XMLHttpRequest` paths

**Where:** Some legacy `Resource` paths still use XHR.

`XMLHttpRequest` IS available in workers but does not honor cookies for cross-origin requests in some configurations (depends on `withCredentials` and CORS policy). For Cesium tile fetches this is rarely a problem because tiles are mostly anonymous, but auth-protected providers (Cesium ion, Bing Maps with SAS) need verification.

**Difficulty:** Easy (test in real scenarios).
**Risk:** Low to medium — depends on which providers users actually use.

### 2.4 `URL.createObjectURL` for video textures

`HTMLVideoElement` is not available in workers. Video billboards / cubemap-from-video features will not work in the worker pane.

**Fix:** Document as unsupported. Worker-side video would need `VideoFrame` from WebCodecs, which is browser-supported but adds significant API surface. Defer indefinitely.

**Difficulty:** N/A (deferred).

---

## 3. Public API changes — what the user sees

### 3.1 Async-everywhere or shadow-state pattern?

The current main-thread API is sync:

```js
viewer.entities.add({ position: ..., point: { color: Cesium.Color.RED } });
viewer.camera.flyTo({ destination: ... });
const picked = viewer.scene.pick(windowPosition);
```

When `Scene` lives in a worker, every one of these has two options:

**A. Become async.** The user writes `await viewer.entities.add(...)`. Picking returns a Promise.
- Pro: actual semantics — the result is available when the worker has processed it.
- Con: every existing Cesium app breaks. Users who haven't `await`ed their setup code will see entities appear "later".

**B. Stay sync, fire-and-forget plus shadow state.** The host records every command in a local mirror and posts it to the worker; reads (`pick`, `getRenderingFrameRate`) return last-known values from the mirror.
- Pro: API stays sync. Existing code keeps working.
- Con: reads are stale by one frame. `pick` returns the result of the LAST frame, not the current one. Camera reads (`viewer.camera.position`) are also one frame stale.

**Recommendation:** Hybrid. Writes are sync fire-and-forget into shadow state (option B). Async-friendly reads (`pickAsync`, `getDebugSnapshotAsync`) live alongside the legacy sync versions. The legacy `pick(...)` returns the cached last-known value with a doc warning that it's worker-side stale.

### 3.2 Entity descriptors must be structured-cloneable

`postMessage` requires its payload to be structured-cloneable. That excludes:
- Functions (user callbacks attached to entities)
- DOM nodes
- WebAssembly modules
- Class instances with prototype-chain methods (everything in Cesium falls into this — Cartesian3, Color, Property, etc.)

**Fix:** Each shadow-state-recorded command needs a *serializer* that turns the rich Cesium object into a plain JS struct on the host side, and a *deserializer* that rebuilds it on the worker side. The protocol's `MSG_ADD_ENTITY` payload becomes a typed JSON struct, not the original entity object.

This is the **biggest implementation cost** of the migration. For every Entity type, every Property type, every Material type, every visualizer — we need a serializer pair. The good news is that most of these are already JSON-friendly value types (Cartesian3 → `{x,y,z}`, Color → `{red,green,blue,alpha}`). The hard ones are `CallbackProperty` (which is a function — has to become a host-side eval that posts result samples to the worker on a tick) and `MaterialAppearance` with custom GLSL.

**Difficulty:** High (~2-3 weeks for the entity / primitive surface alone).
**Risk:** High — the easiest way to cause subtle bugs is a serializer that drops a field nobody noticed was important.

### 3.3 Custom user shaders

`Material` and `CustomShader` accept GLSL/WGSL source as strings. Strings are structured-cloneable, so the source crosses the worker boundary fine. But if the user-supplied shader references a uniform that's a function (e.g., `() => time * 0.001`), the function can't cross. Shadow state needs to wrap function-valued uniforms in a host-side ticker that posts the latest value to the worker each frame.

**Difficulty:** Medium (a few days). Already a known pattern — Cesium's `Property` system does the same thing for time-varying entity values.

### 3.4 Picking results are stale

`scene.pick(windowPosition)` is currently synchronous. In the worker model, the host's local mirror has yesterday's pick result. The fix is to add `scene.pickAsync(windowPosition)` and document the existing `pick(...)` as "use only when no worker is involved."

For the worker case, `pickAsync` posts the request to the worker, the worker performs the pick on the next frame, and returns the result via `MSG_REPLY`. Round-trip latency is one frame plus message-pump latency — typically 16-32 ms. Acceptable for click handlers; visible for hover-style picking that runs every mouse move.

**Mitigation for hover picking:** the host can throttle its own outgoing requests to ~10 Hz and cache the last result for the in-between mousemove events.

---

## 4. Subsystems that need worker-safe equivalents

Ranked by how many user-visible features they touch.

| Subsystem | Difficulty | Worker-safe approach |
|---|---|---|
| **CreditDisplay** | Easy | NullCreditDisplay stub. Real credits rendered host-side from MSG_CREDITS payload. |
| **ScreenSpaceEventHandler** | Medium | WorkerScreenSpaceEventHandler. MSG_INPUT_EVENT routing. Modifier keys + double-click moved into the host's input forwarder. |
| **PickFramebuffer / Picking** | Medium | Pick logic stays in worker. Results post back via MSG_REPLY. Add pickAsync API. |
| **DataSourceCollection** | Hard | Each DataSource (CZML, GeoJSON, KML, GPX, ArcGIS) needs a serializer. The sources currently load directly into the Scene's EntityCollection — need to pivot to "load + serialize + post". |
| **TilesetClickHandler / 3D Tiles selection** | Medium | Selection state moves into the worker's frame state, posted back as part of MSG_STATS. |
| **Animation widget / Timeline / SceneModePicker** | Out of scope | These are widget-side, not Scene-side. They keep running on the main thread and post commands to the worker. |
| **ImageryProvider** | Medium | Most imagery providers fetch tiles and decode them. The fetch path is already worker-safe (Resource.js); the decode path uses ImageBitmap which is worker-safe. Spot-fix the ones that don't. |
| **TerrainProvider** | Medium | Same as imagery — most decode is already in workers. The Provider object itself is constructed on the host and a serialized config posts to the worker. |
| **PostProcessStageCollection** | Easy | Stages take WGSL/GLSL string + uniform map, both serializable. Per-frame uniform updates ride MSG_UPDATE_POSTPROCESS. |
| **Scene.requestRender / requestRenderMode** | Easy | Already covered by MSG_REQUEST_RENDER + MSG_SET_REQUEST_RENDER_MODE in the protocol. |
| **CallbackProperty / SampledProperty** | Hard | Function-valued. The host evaluates these on each frame and posts the resulting value to the worker. Significant CPU on the host for animation-heavy scenes. |
| **Cesium ion auth** | Easy | Token is a string, fetches happen worker-side. |
| **Custom HTML overlay (InfoBox)** | N/A | Stays host-side. The host listens for MSG_PICK_RESULT and updates the InfoBox DOM. |

---

## 5. Critical technical risks (with no obvious mitigation)

### 5.1 GPU resource ownership across the worker boundary

A `GPUTexture` created in the worker cannot be used by the main thread, and vice versa. This means **the host's `pickAsync` cannot return a GPUTexture-backed pixel buffer directly** — it has to post back raw bytes. For pick results that's fine (one pixel). For features that hand a texture to user code (like `Scene.captureToCanvas()`), the host has to receive a `Uint8Array` of raw RGBA bytes, paint them into a 2D canvas context on the host side, and hand that canvas to the user. Adds CPU cost.

### 5.2 SharedArrayBuffer for high-frequency updates

For hover picking or animated entities, posting a new message every mouse move adds overhead. The mitigation is `SharedArrayBuffer`: the host writes the latest mouse position into a shared memory slot, and the worker reads it whenever it's about to render. No postMessage round-trip.

But `SharedArrayBuffer` requires:
- Cross-Origin-Isolation (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`)
- This breaks third-party iframes, breaks some script tags, breaks `<img crossorigin>` patterns

CesiumJS apps embedded in third-party sites typically can't enable COOP/COEP. So SharedArrayBuffer is **off the table** for the general case. We rely on plain postMessage and accept the overhead.

### 5.3 Garbage collection across the boundary

Every command we post creates an object that gets serialized, deserialized into a new object on the worker side, processed, and discarded. For animation-heavy scenes (1000 entities * 60 fps * a few-byte position update each = ~250 KB/s of garbage on each side), the GC pressure adds up. Mitigations:

1. Use `Transferable` ArrayBuffers for any bulk binary data (already done for the FPS frame-time snapshot).
2. Use object pools on both sides for hot-path message types.
3. Batch updates (one MSG_BATCH_ENTITY_UPDATE per frame instead of N individual messages).

These are all standard worker-design tricks. None of them are blockers; all of them are work.

### 5.4 Debugging is harder

Stack traces inside the worker show only worker-side frames. The main-thread call site is invisible. Source maps work but only inside the worker's own bundle. Existing Cesium debug tooling (`scene.logDebugSnapshot()`, `scene.beginPerformanceTrace`) all need worker-aware variants that round-trip the result back to the host.

The current scaffold has `WorkerSceneHost.fetchDebugSnapshot()` as a starter, but the broader debug surface (probes, breakpoints, render-mode toggles) needs a host-side façade for every entry point.

---

## 6. Estimated effort breakdown

Assuming a single experienced engineer working full-time on this and treating it as a focused branch (not interleaved with other migration work):

| Phase | Work | Effort |
|---|---|---|
| **Phase 1** | Hard blockers fixed (CreditDisplay stub, Scene constructor guard, WorkerScreenSpaceEventHandler) — Scene constructs cleanly in worker, no entities yet, no input | 1 week |
| **Phase 2** | Static scene works end-to-end: imagery + terrain + camera setView. The test page renders Bing Maps in two worker panes (WebGL + WebGPU) with correct FPS counters. | 1 week |
| **Phase 3** | Entity / primitive serialization for the common types (Point, Billboard, Polyline, Polygon, Model). Single-update only — no animation. | 2-3 weeks |
| **Phase 4** | Picking (sync fallback + pickAsync), input forwarding round-trip, mouse-driven camera controls. | 1-2 weeks |
| **Phase 5** | Property system (CallbackProperty, SampledProperty, time-varying entities). | 1-2 weeks |
| **Phase 6** | DataSources (CZML, GeoJSON, KML). Cesium ion auth. Tilesets. | 2-3 weeks |
| **Phase 7** | Polish: postprocess stages, custom shaders, performance tuning, debug surface, doc update. | 1 week |
| **Total** | | **9-13 weeks** |

The first two weeks (Phase 1 + Phase 2) are the highest-value because they unblock the worker-renderers test page and let us get real cross-browser FPS comparisons. Everything after Phase 2 is incremental — each phase adds another set of usable features without breaking the previous ones.

---

## 7. What's already done (the deep-review summary)

The 2026-04-11 spike landed the following, all type-checked + building cleanly:

| Component | File | Status |
|---|---|---|
| Live FPS histogram (60s rolling) | [PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js) | **Done.** `recordFrame()` called every Scene render. `getLiveStats()` returns avg/1%-low/1%-high. `getLiveFrameTimeSnapshot(n)` returns the chronological tail for graph rendering. |
| Canvas2D FPS HUD | [FpsOverlay.js](packages/engine/Source/Services/FpsOverlay.js) | **Done.** Draws header (label + avg fps + ms), 60s graph (red bars for >budget frames), footer (1% low + 1% high + sample count). Polls at 6 Hz by default. |
| Worker protocol | [WorkerSceneProtocol.js](packages/engine/Source/Services/WorkerSceneProtocol.js) | **Done.** All message type strings + heartbeat/restart/burst-window constants in one place, shared by host + worker without circular imports. |
| Worker host (main thread) | [WorkerSceneHost.js](packages/engine/Source/Services/WorkerSceneHost.js) | **Done with caveats.** Owns the parent div, manages canvas lifecycle, spawns/terminates worker, runs heartbeat loop, implements 3-tier crash recovery, exposes the FpsOverlay data-source contract. The `onCrash` / `onFailure` callbacks fire correctly. Shadow state currently records only `lastView` and `requestRenderMode` — entity / imagery / terrain shadow recording is Phase 2. |
| Renderer worker (worker thread) | [RendererWorker.js](packages/engine/Source/Workers/RendererWorker.js) | **Done with one BLOCKER.** Bootstrap, message routing, heartbeat echo, FPS reporting, soft-reset hook, device-loss notifier all wired. The `handleInit` Scene-creation path **fails fast** with a clear error explaining the DOM dependency described in §1.1-§1.3. The blocker is documented in code so future sessions know what's needed. ***(Stale as of 2026-05-30 — `handleInit` no longer fails fast; it attempts real headless `Scene` construction. See the dated note below the table.)*** |
| Cross-browser RAF fallback | [RendererWorker.js `_startRenderLoop`](packages/engine/Source/Workers/RendererWorker.js) | **Done.** Detects `requestAnimationFrame` at startup; falls back to `setTimeout(tick, 16.6)` on Firefox/Safari workers. |
| Test page | [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html) | **Done with caveats.** Demonstrates spawning multiple workers in a 2D grid layout (auto-resizes for 1-16 panes). Has buttons to spawn WebGL pane, spawn WebGPU pane, clear all, and "crash first worker" to manually trigger the heartbeat-timeout recovery path. Each pane has its own FPS overlay reading from its host. **What works today:** worker spawn + heartbeat + crash detection + auto-restart + circuit breaker. **What does NOT work today:** the actual Scene rendering, because of §1.1-§1.3. The page is still useful for testing the host/worker plumbing in isolation. |
| Build wiring | [scripts/build.js bundleWorkers()](scripts/build.js) | **Done implicitly.** The existing `bundleWorkers()` glob picks up `Source/Workers/RendererWorker.js` automatically. The worker bundle is emitted at `Build/CesiumUnminified/Workers/RendererWorker.js` (9.5 KB tiny bootstrap that dynamic-imports the engine on first message). |
| Type-check | `npx tsc --noEmit` | **Clean.** |
| Build | `npx gulp build` | **Clean** in 41 seconds. |

### Gaps found in the deep review and addressed in the same pass

| Gap | Severity | Resolution |
|---|---|---|
| `requestAnimationFrame` is Chrome-only inside workers | Medium | Added `setTimeout` fallback with feature detection (see RendererWorker.js `_startRenderLoop`). |
| `_wireDeviceLossRecovery` assumed a non-existent `onDeviceRestored` event | Medium | Rewrote against the actual `WebGPUDeviceLossRecovery.onDeviceLost(callback)` signature. The single callback synthesizes both LOST and RESTORED messages from `info.recovered`. |
| Several protocol message types had no host sender (MSG_ADD_ENTITY, MSG_REMOVE_ENTITY, MSG_SET_IMAGERY_LAYER, MSG_SET_TERRAIN, MSG_CAMERA_UPDATE) | Low | Documented in this file as Phase 2. The constants stay so the message-type wire format is stable. |
| Shadow state replay only handles `lastView` + `requestRenderMode` | Medium | Documented in this file as Phase 2. Each subsystem that gets a host method also gets a corresponding shadow field. |
| Soft reset (Tier 2) is documented but no host code triggers it (MSG_RESET has no sender) | Medium | The recovery service is in place; the trigger will be added when a real soft-reset use case appears. For now, the host goes straight from "GPU device lost (Tier 1, in-thread)" to "hard restart (Tier 3)" on any worker-level fault. Tier 2 is reserved. |
| Scene constructor DOM dependency | **HIGH BLOCKER** | Added a `typeof document === "undefined"` early-throw in `handleInit` so the host gets a CLEAR error instead of a confusing stack trace deep inside Scene.js. The error message points the reader at this doc. ***(Superseded — see the 2026-05-30 note below; the early-throw no longer exists.)*** |

> **Update 2026-05-30 (HEAD `88b111e49c`, re-verified against code):** The `typeof document === "undefined"` early-throw described in the row above **no longer exists** in `handleInit`. [RendererWorker.js:138-175](packages/engine/Source/Workers/RendererWorker.js#L138-L175) now **attempts headless `Scene` construction** — it dynamic-imports `@cesium/engine` and calls `_createWebGLScene` / `_createWebGPUScene` against the OffscreenCanvas (consistent with the §1.1/§1.2 "FIXED 2026-04-11" entries, which made `Scene` and `CreditDisplay` detect `typeof document === "undefined"` and skip DOM construction). The only remaining `typeof document` reference in the file is a comment at line 140 documenting that the Scene/CreditDisplay path was updated to do that detection. There is no hardcoded blocker throw.
>
> **Current first-failure point — re-verify before asserting:** init no longer fails fast at a sentinel guard. Any missed DOM dependency now surfaces as an exception thrown from inside real `Scene` construction (`_createWebGLScene` at :193 / `_createWebGPUScene` at :215), caught by the `try`/`catch` at [RendererWorker.js:176-184](packages/engine/Source/Workers/RendererWorker.js#L176-L184) and posted to the host as `MSG_ERROR` with `phase: "init"` plus the real `message`/`stack`. The §1.3 `ScreenSpaceEventHandler` DOM binding (still OPEN — instantiated by the `Scene` constructor) is the most likely actual first failure, but this has not been re-confirmed by running the worker since the early-throw was removed. **Do not re-assert a specific first-failure line in §7/§8 without re-running the worker init path and reading the captured `MSG_ERROR` stack.**

### What works today (without the blocker)

1. The FPS counter improvements work fully on the main-thread Scene. Any existing CesiumViewer can drop in `new FpsOverlay({ parent: viewer.container, dataSource: viewer.scene.performanceTracker })` and get a live HUD.
2. The worker host spawns and tears down workers correctly. Heartbeat detects unresponsive workers within ~3 seconds and triggers restart. The circuit breaker opens after 3 crashes in 60 seconds.
3. The worker bundle is emitted at the right path and the host's URL resolution works for the bundled case (see the path-resolution comment in `_spawnFreshWorker`).
4. Multi-pane layout in [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html) auto-arranges 1-16 worker hosts in a grid. Each one has its own independent FPS overlay.

### What doesn't work today (the blocker)

> ***Stale as of 2026-05-30** — this narrative predates the early-throw removal documented in the dated note above. `handleInit` no longer short-circuits before `Scene` construction; it now attempts a real headless `Scene` build and reports any DOM-dependency failure via `MSG_ERROR` from the `try`/`catch`, not via the §1.1 sentinel throw. Re-verify the actual failure path (likely §1.3 `ScreenSpaceEventHandler`) before relying on the description below.*

When the worker tries to construct a `Scene` against the OffscreenCanvas, it hits the DOM dependency in §1.1 and throws. The host's `onCrash` callback fires; the recovery loop attempts a fresh worker; that one also throws. After 3 attempts (within 60 seconds) the circuit breaker opens and the test page label flips to `FAILED`.

This is the EXPECTED behavior given the blocker. To unblock, do Phase 1 of the §6 plan (1 week of work).

---

## 8. Recommended next steps

In priority order, with the rationale:

1. **Validate the FPS counter on a real scene.** It's done and works on the main thread; we just need to confirm the overlay renders correctly against an active CesiumViewer. Add `new FpsOverlay({ parent: viewer.container, dataSource: viewer.scene.performanceTracker })` to a sandcastle demo and visually check.

2. **Phase 1 of Option B** (1 week): unblock the worker. CreditDisplay stub + Scene constructor guard + WorkerScreenSpaceEventHandler stub. After this, the test page renders something in each worker pane.

3. **Phase 2** (1 week): static scene with terrain + imagery. This delivers the multi-renderer FPS comparison that motivated the spike in the first place.

4. **Decide whether to continue past Phase 2.** Phases 3-7 are 7-11 more weeks of work and committed to the public API change in §3.1. That decision should be informed by real measurements from Phase 2 — if the worker isolation gives us 2x scaling on multi-renderer scenes, it's clearly worth it; if it gives us 5%, we should reconsider.

5. **Defer indefinitely** if Phase 2 doesn't deliver enough benefit. The infrastructure built in this spike isn't wasted — the FPS counter is independently valuable, and the worker scaffolding can be kept around as the foundation for any future worker-based feature (compute-only workers, file processing, etc.).
