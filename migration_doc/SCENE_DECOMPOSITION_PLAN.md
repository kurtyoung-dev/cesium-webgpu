# Scene.js Decomposition Plan

**Date:** March 22, 2026  
**Context:** Scene.js is ~4,900 lines with 6+ distinct responsibilities crammed into one file. This plan breaks it into focused modules that each do one thing well.

---

## Table of Contents

1. [Current Problem](#1-current-problem)
2. [Responsibility Analysis](#2-responsibility-analysis)
3. [Proposed File Structure](#3-proposed-file-structure)
4. [Detailed Module Breakdown](#4-detailed-module-breakdown)
5. [Migration Strategy](#5-migration-strategy)
6. [What This Achieves](#6-what-this-achieves)

---

## 1. Current Problem

Scene.js has **six distinct responsibilities** packed into one file:

| Responsibility | Lines | Functions |
|---------------|-------|-----------|
| **Public API** (constructor, getters, pick/morph/render methods) | ~1,800 | 35+ class members |
| **Command execution pipeline** (frustum loops, per-pass execution) | ~700 | `executeCommands`, `performPass`, `performTranslucentPass`, `performVoxelsPass`, `performGaussianSplatPass`, `performCesium3DTileEdgesPass`, `performTranslucent3DTilesClassification` |
| **Command sorting** (comparators, OIT function selection) | ~150 | `frontToBack`, `backToFront`, `backToFrontSplats`, `obtainTranslucentCommandExecutionFunction`, `executeTranslucentCommandsBackToFront/FrontToBack` |
| **Environment rendering** (sky, sun, moon, atmosphere) | ~200 | `renderEnvironment`, `updateEnvironment` (the env half) |
| **Framebuffer management** (FBO setup, clear, resolve, OIT, post-process) | ~400 | `updateAndClearFramebuffers`, `resolveFramebuffers` |
| **Viewport orchestration** (2D, 3D, VR, multi-frustum) | ~400 | `executeCommandsInViewport`, `execute2DViewportCommands`, `executeWebVRCommands` |
| **Utilities** (occluder, camera underground, globe height, debug, shadows) | ~500 | `getOccluder`, `isCameraUnderground`, `getGlobeHeight`, `updateShadowMaps`, `executeShadowMapCastCommands`, debug functions |
| **Render loop** (frame lifecycle, pre/post passes) | ~300 | `render` (file-scoped), `prePassesUpdate`, `postPassesUpdate`, `tryAndCatchError`, tileset pass updates |

**Why this is bad:**
1. **Merge conflicts**: Any change to any subsystem conflicts with all others in the same file
2. **Cognitive load**: Developers must scroll 5000 lines to find the function they need
3. **Testing**: Can't unit-test the command pipeline without instantiating an entire Scene
4. **Reuse**: The command execution pipeline is useful for WebGPU but can't be imported separately
5. **Ownership**: Different developers work on picking, sorting, rendering — all touching one file

---

## 2. Responsibility Analysis

### What Scene.js Should Be

Scene.js should be the **facade** — the public-facing API that users interact with. It delegates to specialized subsystems:

```
Scene (facade)
├── SceneRenderer (command execution pipeline)
│   ├── CommandSorter (sort comparators)
│   ├── EnvironmentRenderer (sky, sun, moon, atmosphere)
│   ├── FramebufferOrchestrator (FBO setup/clear/resolve)
│   └── ViewportExecutor (2D, 3D, VR viewport handling)
├── Picking (already extracted ✅)
├── SceneTransitioner (already extracted ✅)
├── ScreenSpaceCameraController (already extracted ✅)
├── PostProcessStageCollection (already extracted ✅)
└── RenderScheduler (already extracted ✅)
```

CesiumJS has already extracted Picking, SceneTransitioner, and ScreenSpaceCameraController into separate files. Scene.js delegates to them. We should do the same for the rendering pipeline.

### What Each Module Contains

| Module | Responsibility | Inputs | Outputs |
|--------|---------------|--------|---------|
| **Scene.js** | Public API facade. Constructor, getters/setters, pick/morph/render entry points. | User calls | Delegates to subsystems |
| **SceneRenderer.js** | Multi-frustum command execution loop. The core render pipeline. | `scene`, `passState`, `frustumCommandsList` | Executes all draw commands |
| **CommandSorter.js** | Sort comparators for opaque, translucent, splats. OIT function selection. | Commands array, camera position | Sorted commands |
| **EnvironmentRenderer.js** | Sky box, atmosphere, sun, moon, panorama rendering. Environment state tracking. | `scene`, `passState`, `frameState` | Environment commands executed |
| **FramebufferOrchestrator.js** | FBO lifecycle: create, update, clear, resolve. Globe depth, OIT, post-process setup. | `scene`, `passState`, `clearColor` | Framebuffers ready for rendering |
| **ViewportExecutor.js** | Viewport setup for 2D, 3D, VR. Manages camera/frustum for each viewport. | `scene`, `passState` | Delegates to SceneRenderer |
| **SceneUtilities.js** | Occluder computation, camera underground detection, globe height, frame numbering. | `scene` | Computed values |
| **SceneDebug.js** | Debug frustum planes, bounding volume visualization, FPS display. | `scene`, command | Debug rendering |

---

## 3. Proposed File Structure

```
packages/engine/Source/Scene/
├── Scene.js                    (~1,200 lines — facade: constructor, getters, public API)
├── SceneRenderer.js            (~800 lines — multi-frustum execution loop)
├── CommandSorter.js            (~200 lines — sort comparators + OIT function selection)
├── EnvironmentRenderer.js      (~250 lines — sky, sun, moon, atmosphere, panorama)
├── FramebufferOrchestrator.js  (~500 lines — FBO setup, clear, resolve, OIT, post-process)
├── ViewportExecutor.js         (~400 lines — 2D/3D/VR viewport dispatch)
├── SceneUtilities.js           (~200 lines — occluder, camera underground, globe height)
├── SceneDebug.js               (~150 lines — debug frustum planes, bounding volumes, FPS)
├── Picking.js                  (existing ✅)
├── SceneTransitioner.js        (existing ✅)
├── RenderScheduler.js          (existing ✅)
└── ...
```

**Total: ~3,700 lines across 8 files** (vs ~4,900 in one file). The reduction comes from eliminating duplicated scratch variables that are shared between functions now in different modules, and from cleaner imports.

---

## 4. Detailed Module Breakdown

### 4.1 Scene.js (~1,200 lines) — The Facade

**Contains:**
- `class Scene` with constructor
- All getters/setters (canvas, camera, globe, mode, etc.)
- Public API methods that delegate:
  - `render(time)` → calls `SceneRenderPipeline.render(this, time)`
  - `pick/pickAsync/drillPick` → delegates to `this._picking`
  - `morphTo2D/3D/CV` → delegates to `this._transitioner`
  - `sampleHeight/clampToHeight` → delegates to `this._picking`
  - `pickAll/pickRayAll/pickColumn` → convenience wrappers
  - `setTerrain/getHeight/updateHeight` → terrain utilities
  - `forceRender/requestRender` — render control
  - `isDestroyed/destroy` — lifecycle
- `static async createAsync()`

**Does NOT contain:**
- Any file-scoped rendering functions
- Sort comparators
- Framebuffer management
- Command execution logic

**Key design**: The `render()` method becomes a thin orchestrator:

```javascript
render(time) {
  this._preUpdate.raiseEvent(this, time);
  this._renderScheduler.beginFrame();
  
  // ... frame number, shouldRender logic (stays here — it's Scene lifecycle) ...
  
  if (shouldRender) {
    this._preRender.raiseEvent(this, time);
    frameState.creditDisplay.beginFrame();
    SceneRenderPipeline.render(this);  // Delegates the heavy lifting
  }
  
  // ... post-render events ...
}
```

### 4.2 SceneRenderer.js (~800 lines) — Command Execution Pipeline

**Contains:**
- `executeCommands(scene, passState)` — the multi-frustum loop
- `executeCommand(command, scene, passState, debugFramebuffer)` — single command dispatch
- `executeIdCommand(command, scene, passState)` — pick ID command dispatch
- `performPass(scene, frustumCommands, passId, passState)` — per-pass command iteration
- `performVoxelsPass`, `performGaussianSplatPass`, `performTranslucentPass`
- `performTranslucent3DTilesClassification`, `performCesium3DTileEdgesPass`
- `executeShadowMapCastCommands(scene)` + `insertShadowCastCommands`
- `executeComputeCommands(scene)`, `executeOverlayCommands(scene, passState)`
- All scratch variables used by these functions

**Exports:**
```javascript
export {
  executeCommands,
  executeComputeCommands,
  executeOverlayCommands,
  executeShadowMapCastCommands,
};
```

**Why this grouping**: These functions form a cohesive unit — they're the "how commands get rendered" pipeline. They share scratch variables (`scratchPerspectiveFrustum`, etc.) and internal helper functions (`createWorkingFrustum`). Moving them together preserves their tight coupling while decoupling them from Scene's public API.

### 4.3 CommandSorter.js (~200 lines) — Sort Comparators

**Contains:**
- `frontToBack(a, b, position)` — opaque multi-level sort (sortKey → sortPriority → materialSortId → distance)
- `backToFront(a, b, position)` — translucent multi-level sort
- `backToFrontSplats(a, b, position)` — Gaussian splat center-distance sort
- `obtainTranslucentCommandExecutionFunction(scene)` — OIT function selector
- `executeTranslucentCommandsBackToFront(scene, executeFunction, passState, commands, invertClassification)`
- `executeTranslucentCommandsFrontToBack(scene, executeFunction, passState, commands, invertClassification)`
- Scratch variables: `scratchCart3`

**Exports:**
```javascript
export {
  frontToBack,
  backToFront,
  backToFrontSplats,
  obtainTranslucentCommandExecutionFunction,
  executeTranslucentCommandsBackToFront,
  executeTranslucentCommandsFrontToBack,
};
```

**Why separate**: Sort comparators are the most likely place to evolve — adding new sort levels, integrating with RenderScheduler's layer-based sorting, adding custom sort overrides. Isolating them makes this evolution clean.

### 4.4 EnvironmentRenderer.js (~250 lines) — Celestial Bodies + Environment State

**Contains:**
- `renderEnvironment(scene, passState)` — execute sky, atmosphere, sun, moon, panorama commands
- `updateEnvironment(scene)` — compute visibility of celestial bodies, update depth plane, specular env maps
- `updateShadowMaps(scene)` — shadow map dirty tracking and update
- Scratch variables: `scratchCullingVolume`

**Exports:**
```javascript
export { renderEnvironment, updateEnvironment };
```

**Why separate**: Environment rendering is visually distinct, has its own state (`environmentState`), and is the part most affected by WebGPU (sky atmosphere, sun, moon all have WebGPU feature renderers). Isolating it makes WebGPU environment testing cleaner.

### 4.5 FramebufferOrchestrator.js (~500 lines) — FBO Lifecycle

**Contains:**
- `updateAndClearFramebuffers(scene, passState, clearColor)` — the large FBO setup function
- `resolveFramebuffers(scene, passState)` — post-render FBO resolution (OIT composite, post-process copy)

These are the two largest file-scoped functions in the current Scene.js. They manage:
- Globe depth framebuffer setup and clearing
- OIT framebuffer setup and clearing
- Post-process framebuffer setup and clearing
- Sun bloom framebuffer
- Invert classification framebuffer
- Edge visibility framebuffer
- Globe translucency framebuffer

**Exports:**
```javascript
export { updateAndClearFramebuffers, resolveFramebuffers };
```

**Why separate**: Framebuffer management is the most complex and error-prone part of the render pipeline. It's also where WebGL and WebGPU diverge most (WebGPU has its own FBO management via `WebGPUSceneRenderer`). Isolating it makes backend-specific framebuffer logic cleaner.

### 4.6 ViewportExecutor.js (~400 lines) — Viewport Dispatch

**Contains:**
- `executeCommandsInViewport(firstViewport, scene, passState)` — the main viewport entry point (including SORT-3 integration)
- `execute2DViewportCommands(scene, passState)` — 2D split-viewport logic
- `executeWebVRCommands(scene, passState)` — stereo VR viewport
- `updateAndRenderPrimitives(scene)` — primitive update + debug frustums + shadow maps + globe render
- Scratch variables: `scratch2DViewport*`, `scratchEyeTranslation`

**Exports:**
```javascript
export {
  executeCommandsInViewport,
  execute2DViewportCommands,
  executeWebVRCommands,
};
```

**Why separate**: Viewport management is the "top level" of the render pipeline — it decides HOW to render (2D, 3D, VR) and then calls into SceneRenderer for the actual execution. Separating it from the execution makes the pipeline's two-phase structure explicit.

### 4.7 SceneUtilities.js (~200 lines) — Pure Computation Helpers

**Contains:**
- `getOccluder(scene)` — central body occluder computation
- `isCameraUnderground(scene)` — camera underground detection
- `getGlobeHeight(scene)` — globe height at camera position
- `getMaxPrimitiveHeight(primitive, cartographic, scene)` — recursive primitive height query
- `updateFrameNumber(scene, frameNumber, time)` — frame number update
- `requestRenderAfterFrame(scene)` — render request callback factory
- Scratch variables: `scratchOccluderBoundingSphere`, `updateHeightScratchCartographic`

**Exports:**
```javascript
export {
  getOccluder,
  isCameraUnderground,
  getGlobeHeight,
  getMaxPrimitiveHeight,
  updateFrameNumber,
  requestRenderAfterFrame,
};
```

**Why separate**: These are pure utility functions with no side effects. They're used by Scene.js (the facade) but don't belong in the render pipeline. Extracting them reduces Scene.js to just its API surface.

### 4.8 SceneDebug.js (~150 lines) — Debug Infrastructure

**Contains:**
- `debugShowBoundingVolume(command, scene, passState, debugFramebuffer)` — bounding volume wireframe rendering
- `updateDebugFrustumPlanes(scene)` — debug frustum plane primitives
- `updateDebugShowFramesPerSecond(scene, renderedThisFrame)` — FPS display management
- Scratch variables: `transformFrom2D`

**Exports:**
```javascript
export {
  debugShowBoundingVolume,
  updateDebugFrustumPlanes,
  updateDebugShowFramesPerSecond,
};
```

**Why separate**: Debug code should not be mixed with production rendering logic. Having it in its own file makes it easy to find, test, and (in the future) tree-shake out of production builds.

---

## 5. Migration Strategy

### Phase 1: Extract Pure Utilities (Zero Risk) — ✅ COMPLETE (March 22, 2026)

Extracted `SceneUtilities.js` (129 lines) and `CommandSorter.js` (161 lines).

**SceneUtilities.js** contains: `getOccluder`, `updateFrameNumber`, `getGlobeHeight`, `getMaxPrimitiveHeight`, `isCameraUnderground`, `callAfterRenderFunctions`, `updateHeightScratchCartographic`.

**CommandSorter.js** contains: `backToFront`, `frontToBack`, `backToFrontSplats`, `distanceSquaredToCenter`, `executeTranslucentCommandsBackToFront`, `executeTranslucentCommandsFrontToBack`, `obtainTranslucentCommandExecutionFunction`.

### Phase 2: Extract Debug (Low Risk) — ✅ COMPLETE (March 22, 2026)

Extracted `SceneDebug.js` (179 lines): `debugShowBoundingVolume`, `updateDebugFrustumPlanes`, `updateDebugShowFramesPerSecond` + `transformFrom2D` scratch variable.

7 imports removed from Scene.js (BoxGeometry, EllipsoidGeometry, GeometryInstance, GeometryPipeline, ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Primitive, DebugCameraPrimitive, PerformanceDisplay, BoundingSphere, Occluder).

### Phase 3: Extract Environment Renderer (Low Risk) — ✅ COMPLETE (March 22, 2026)

Extracted `EnvironmentRenderer.js` (69 lines): `renderEnvironment` with `executeCommand` passed as parameter (since it's still a local function in Scene.js).

Call site updated: `renderEnvironment(scene, passState)` → `renderEnvironment(scene, passState, executeCommand)`.

### Phase 4: Extract Framebuffer Orchestrator (Medium Risk) — ✅ COMPLETE (March 22, 2026)

Extracted `FramebufferOrchestrator.js` (213 lines): `updateAndClearFramebuffers` and `resolveFramebuffers` (extracted from class method, now takes `scene` parameter). Scene.js `resolveFramebuffers` class method now delegates to imported `resolveFramebuffersImpl(this, passState)`.

**Imports:** `Color`, `defined`, `SunPostProcess`.

### Phase 5: Extract Viewport Executor + Scene Renderer (Medium Risk) — ✅ COMPLETE (March 22, 2026)

Extracted simultaneously as ViewportExecutor calls SceneRenderer.

**SceneRenderer.js** (~580 lines): `executeCommand`, `executeIdCommand`, `performVoxelsPass`, `performGaussianSplatPass`, `createWorkingFrustum` + 4 scratch frustums, `performTranslucentPass`, `performTranslucent3DTilesClassification`, `performCesium3DTileEdgesPass`, `executeCommands` (multi-frustum loop with `performPass`/`performIdPass` closures), `executeComputeCommands`, `executeOverlayCommands`, `insertShadowCastCommands`, `executeShadowMapCastCommands`.

**ViewportExecutor.js** (~320 lines): `updateShadowMaps`, `updateAndRenderPrimitives`, `executeWebVRCommands` + `scratchEyeTranslation`, `execute2DViewportCommands` + 8 scratch variables, `executeCommandsInViewport` (with SORT-3 scheduler integration).

**Scene.js changes:** 5 unused imports removed (`mergeSort`, `PerspectiveFrustum`, `PerspectiveOffCenterFrustum`, `Transforms`, `SunPostProcess`). 7 new import lines added. `resolveFramebuffers` class method reduced to 3-line delegation. `updateAndExecuteCommands` class method now calls imported functions.

### Phase 6: Clean Up Scene.js — ✅ COMPLETE (March 22, 2026)

Scene.js reduced from 4,921 to 3,684 lines (-1,237 lines). The file now contains:
- Class definition with constructor, getters/setters, public API methods
- Thin delegation methods (`updateAndExecuteCommands`, `resolveFramebuffers`)
- File-scoped helpers that are Scene-specific (`updateGlobeListeners`, `updateDerivedCommands`, `render`, `tryAndCatchError`, tileset pass updates)
- `scratchCullingVolume` (used by `updateEnvironment` class method)

**No rendering pipeline functions remain in Scene.js.** All command execution, viewport dispatch, and framebuffer management are in their respective modules.

**Verification:** All 8 decomposed files pass `node -c` syntax check. The public API surface (`scene.render()`, `scene.pick()`, etc.) is unchanged.

---

## 6. What This Achieves

### Before (1 file, 4,900 lines)
```
Scene.js (4,900 lines)
  ├── Public API (1,800 lines)
  ├── Command execution (700 lines)
  ├── Sort comparators (150 lines)
  ├── Environment rendering (200 lines)  
  ├── Framebuffer management (500 lines)
  ├── Viewport orchestration (400 lines)
  ├── Utilities (500 lines)
  ├── Debug (150 lines)
  └── Render loop (300 lines)
```

### After (8 files, ~3,700 lines total)
```
Scene.js              (1,200 lines) — facade + public API
SceneRenderer.js        (800 lines) — multi-frustum command execution
CommandSorter.js        (200 lines) — sort comparators
EnvironmentRenderer.js  (250 lines) — sky, sun, moon, atmosphere
FramebufferOrchestrator.js (500 lines) — FBO lifecycle
ViewportExecutor.js     (400 lines) — 2D/3D/VR viewport dispatch
SceneUtilities.js       (200 lines) — pure computation helpers
SceneDebug.js           (150 lines) — debug infrastructure
```

### Benefits

| Benefit | Impact |
|---------|--------|
| **Merge conflicts** | Sorting changes don't conflict with framebuffer changes. Environment rendering doesn't conflict with viewport logic. Upstream syncs touch fewer conflict surfaces. |
| **Testability** | `CommandSorter.js` can be unit-tested with mock commands. `SceneUtilities.js` needs no GPU context. `EnvironmentRenderer.js` can be tested independently. |
| **Cognitive load** | Each file is 150-800 lines. A developer working on sorting only reads `CommandSorter.js`. |
| **WebGPU parity** | `SceneRenderer.js` is the exact WebGL counterpart of `WebGPUSceneRenderer.ts`. Their APIs can be made parallel, enabling easier feature parity verification. |
| **Code navigation** | IDE "Go to Definition" takes you to a focused file, not line 3,847 of a 4,900-line file. |
| **Tree-shaking** | `SceneDebug.js` could theoretically be excluded from production builds. |
| **Future: render pipeline plugins** | `SceneRenderer.js` could be replaced by a plugin system where WebGL and WebGPU each provide their own renderer. |

### Non-Goals

- **NOT breaking the public API** — `Scene` is still the only public class. The extracted modules are `@private`.
- **NOT changing the render pipeline** — The exact same functions execute in the exact same order. We're just reorganizing which file they live in.
- **NOT creating new abstractions** — No new classes, no new interfaces. Just function extraction.

### Compatibility with Upstream Syncs

The extracted modules are all `@private` — upstream CesiumJS won't have them. When syncing:
- Upstream changes to Scene.js's render pipeline → we merge into `SceneRenderer.js` / `ViewportExecutor.js` / etc.
- Upstream changes to Scene.js's public API → we merge into `Scene.js` (now much smaller)
- Since each extracted function was a clearly-delimited block in the original, git's merge tools can often auto-resolve

### Compatibility with WebGPU Architecture

The decomposition aligns perfectly with the WebGPU feature renderer pattern:

| Extracted Module | WebGPU Counterpart | Interaction |
|-----------------|-------------------|-------------|
| `SceneRenderer.js` | `WebGPUSceneRenderer.ts` | WebGPU overrides the entire command execution pipeline via `_alternateSceneRenderer` |
| `CommandSorter.js` | `RenderScheduler.js` | The scheduler's layer-based sorting wraps/replaces the comparators |
| `EnvironmentRenderer.js` | Feature renderers for sky, sun, moon | Environment rendering delegates to feature renderers |
| `FramebufferOrchestrator.js` | `context.updateAndClearFramebuffers()` | WebGPU context method already overrides this |

---

## Summary

Scene.js should be decomposed into 8 focused files. The migration is low-risk (extracting existing file-scoped functions, no behavior changes) and can be done incrementally in 6 phases. The result is a cleaner architecture where each module has a single responsibility, conflicts are minimized, and the WebGL render pipeline becomes a clean counterpart to the existing WebGPU pipeline.

**Recommended execution order:** Utilities → Debug → CommandSorter → EnvironmentRenderer → FramebufferOrchestrator → Viewport+Renderer. Each phase is independently testable and committable.
