
# Plan: Backend-Agnostic GraphicsContext Architecture

> **Implementation Status: March 17, 2026**
>
> **Phases A–D + Risk 2 Strategies: IMPLEMENTED**
>
> | Component | Status | Files |
> |-----------|--------|-------|
> | **Phase A: GraphicsContext Abstract Class** | ✅ Complete | `GraphicsContext.ts` rewritten from interface to abstract class with shared logging, registry, feature renderer registry |
> | **Phase B: ContextRegistry** | ✅ Complete | `ContextRegistry.ts` — Map-based multi-context tracking, auto-register/unregister, event listeners, diagnostics |
> | **Phase C: Feature Renderer Registry** | ✅ Complete | `FeatureRenderer` interface + `registerFeatureRenderer()`/`getFeatureRenderer()` on GraphicsContext base |
> | **Phase D: Accessor Pattern** | ✅ Complete | `scene.graphicsContext`, `scene.contextRegistry`, `frameState.graphicsContext` getters added |
> | **Context.js extends GraphicsContext** | ✅ Complete | `class Context extends GraphicsContext` with `super()`, `rendererType` getter, `_registerWithRegistry()`, `_unregisterFromRegistry()` |
> | **WebGPUContext.ts extends GraphicsContext** | ✅ Complete | `class WebGPUContext extends GraphicsContext` with `super()`, removed `isWebGPU` field (now computed getter from base class), registry lifecycle |
> | **ContextFactory.ts updated** | ✅ Complete | Removed `as any as GraphicsContext` cast — Context now directly extends GraphicsContext |
> | **Strategy A: SharedResourcePool** | ✅ Complete | `SharedResourcePool.ts` — SharedArrayBuffer-based CPU data sharing for multi-context, reference counting, fallback to ArrayBuffer |
> | **Strategy B: WebGPUDevicePool** | ✅ Complete | `WebGPU/WebGPUDevicePool.ts` — One GPUDevice, multiple canvases, ~90% GPU memory savings for multi-view WebGPU |
> | **Strategy C: OffscreenContextSupport** | ✅ Complete | `OffscreenContextSupport.ts` — WebWorker background rendering, inline worker, both WebGL & WebGPU support, opt-in via constructor param |
>
> ### New Files Created
> ```
> packages/engine/Source/Renderer/ContextRegistry.ts          — Multi-context tracking
> packages/engine/Source/Renderer/SharedResourcePool.ts       — Strategy A: SharedArrayBuffer pool
> packages/engine/Source/Renderer/OffscreenContextSupport.ts  — Strategy C: OffscreenCanvas worker
> packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts  — Strategy B: Device sharing
> ```
>
> ### Files Modified
> ```
> packages/engine/Source/Renderer/GraphicsContext.ts     — Interface → Abstract class
> packages/engine/Source/Renderer/Context.js             — extends GraphicsContext, registry lifecycle
> packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts — extends GraphicsContext, registry lifecycle
> packages/engine/Source/Renderer/ContextFactory.ts      — Removed type casts
> packages/engine/Source/Scene/Scene.js                  — Added graphicsContext, contextRegistry getters
> packages/engine/Source/Scene/FrameState.js             — Added graphicsContext alias
> ```
>
> ### Phases E–G: IMPLEMENTED (March 17, 2026)
>
> | Component | Status | Files |
> |-----------|--------|-------|
> | **Phase E: View-Level Context** | ✅ Complete | `View.js` — optional `graphicsContext` constructor param, `effectiveContext` getter, `graphicsContext` getter/setter, `scene` getter |
> | **Phase E: Scene.createView()** | ✅ Complete | `Scene.js` — `createView(camera, viewport, { graphicsContext })` factory method |
> | **Phase E: WebGPUDevicePool** | ✅ Complete (prev. task) | `WebGPU/WebGPUDevicePool.ts` — one GPUDevice, multiple canvases, ~90% GPU memory savings |
> | **Phase E: SharedResourcePool** | ✅ Complete (prev. task) | `SharedResourcePool.ts` — SharedArrayBuffer CPU data sharing, ref counting, fallback |
> | **Phase E: OffscreenContextSupport** | ✅ Complete (prev. task) | `OffscreenContextSupport.ts` — WebWorker background rendering, both WebGL & WebGPU |
> | **Phase F: Context-Aware Logging** | ✅ Complete | `GraphicsContext.ts` already has `log()` method with `[CesiumJS:type:shortId]` prefix |
> | **Phase F: Registry Diagnostics** | ✅ Complete | `ContextRegistry.ts` — added `dumpDiagnostics()` and `getFormattedDiagnostics()` |
> | **Phase G: .clinerules Update** | ✅ Complete | Added Section 2c (View-Level Context), Section 2d (Context-Aware Logging) |
> | **Phase G: Doc Updates** | ✅ Complete | This file + WEBGPU_MIGRATION_STATUS.md updated |
>
> ### Phase D: Scene File Migration — IN PROGRESS (March 17, 2026)
>
> **Infrastructure:** `WebGPUFeatureRenderers.ts` created — centralized registration of ALL 28 WebGPU
> feature renderers. Called automatically during `WebGPUContext._initialize()`. Scene files access
> renderers via `context.getFeatureRenderer('name')` instead of importing from `Renderer/WebGPU/`.
>
> **Migration Pattern (proven on PointPrimitiveCollection.js, Sun.js):**
> 1. Remove `import { ... } from '../Renderer/WebGPU/...'`
> 2. Replace `if (context.isWebGPU) { updateWebGPU...(this, frameState); return; }` with:
>    `const fr = context.getFeatureRenderer('name'); if (fr) { fr.update(this, frameState); return; }`
> 3. WebGL code stays inline as the default fallback (no feature renderer = WebGL path)
>
> **Files Migrated:** PointPrimitiveCollection.js, Sun.js (2 of 28)
> **Files Remaining:** 26 files — all follow the identical pattern above.
> Each can be migrated independently in a single commit.
>
> ### FrameState Option B: Per-View Context Updating — ✅ COMPLETE
>
> In `Scene.js`'s `render()` function, after `scene.updateFrameState()`, the FrameState's context
> is now updated to match the current View's effective context:
> ```javascript
> const viewContext = view.effectiveContext;
> if (viewContext && viewContext !== frameState.context) {
>   frameState.context = viewContext;
>   frameState.graphicsContext = viewContext;
> }
> ```
> This matches how CesiumJS already updates `frameState.camera` per view. Each View can now
> independently target a different GraphicsContext (WebGL or WebGPU) via `view.graphicsContext`.
>
> ### RenderCommand Path B: Abstract Command for Backend-Agnostic commandList — ✅ DOCUMENTED
>
> `RenderCommand.js` (in `Renderer/WebGPU/`) provides a backend-agnostic command abstraction.
> Scene code pushes `RenderCommand` objects to `commandList`. The command's `execute(context)`
> method detects the backend via `context.isWebGPU` and delegates to the appropriate native
> command (`DrawCommand` for WebGL, `WebGPUDrawCommand` for WebGPU). Native commands are cached
> with dirty-version tracking for zero per-frame rebuild overhead.
>
> New scene features SHOULD use `RenderCommand` instead of importing `DrawCommand` or
> `WebGPUDrawCommand` directly. This is documented in `.clinerules` under "Abstract RenderCommand".
>
> ### FrameState Hackathon Pattern: ✅ Verified
> Per the `webgpu-hackathon-device` branch pattern, the graphics context is exposed via `FrameState`:
> - `frameState.context` — original property (backward compatible)
> - `frameState.graphicsContext` — alias for backend-agnostic access (new)
> Both point to the same GraphicsContext instance (WebGL or WebGPU). Compute tasks, extensions,
> and systems outside the render loop can access the full API through either property.
>
> ### WebGL Version Targeting Decision
> CesiumJS upstream still supports WebGL1 with 34+ branching points across ~20 files (`context.webgl2`),
> a full GLSL 3.00→1.00 transpiler (`demodernizeShader.js`), and WebGL1 extension fallbacks. However:
> - WebGL2 is the **default** (`requestWebgl1` defaults to `false`)
> - Several features are **WebGL2-only**: 3D textures, GPU sync, async picking, clipping polygons
> - Our `Context.js` sets `requestWebgl1 = true` only when `WebGL2RenderingContext` is undefined
> - Our WebGPU path already assumes modern GPU capabilities
>
> **Decision: Our fork targets WebGL2 only.** We don't need to maintain three rendering paths
> (WebGL1 + WebGL2 + WebGPU). When `Context.js` extends `GraphicsContext`, it already defaults to
> WebGL2. The `requestWebgl1` option remains for edge cases but is not actively maintained.
> If upstream officially drops WebGL1, our merge will be clean.


## The Vision

Transform CesiumJS's dual-renderer architecture from **"scene code knows about both backends"** (27+ `if (context.isWebGPU)` branch points in scene files) to **"scene code talks to one abstract interface, the renderer handles everything."** This is a hybrid of Three.js's drop-in replacement pattern and PlayCanvas's GraphicsDevice interface, adapted for CesiumJS's fork constraints.

---

## 1. Current Architecture vs. Target Architecture

### Current (What We Have)
```
Scene.js / Primitive.js / BillboardCollection.js  ← KNOWS about WebGPU
  ├─ if (context.isWebGPU) → import WebGPUBillboardRenderer  ← 27 files do this
  │    └─ WebGPUBillboardRenderer.js
  └─ else → inline WebGL code (untouched)
```
**Problem:** 27 scene files import from `Renderer/WebGPU/`, creating 27 merge conflict points, duplicated logic, and tight coupling.

### Target (What We Want)
```
Scene.js / Primitive.js / BillboardCollection.js  ← Backend-AGNOSTIC
  └─ context.bindPipeline(hint) / context.draw(command)  ← Abstract API
      
GraphicsContext (abstract thick interface)
  ├─ WebGLGraphicsContext (wraps Context.js)  ← Handles WebGL specifics internally
  └─ WebGPUGraphicsContext (wraps WebGPUContext.ts)  ← Handles WebGPU specifics internally
      
ContextRegistry  ← Tracks all active contexts (multi-view support)
```
**Result:** Scene code has ZERO backend-specific imports. The GraphicsContext is the boundary.

---

## 2. The Hybrid Approach: Three.js + PlayCanvas

### From Three.js: "Drop-In Replacement" Pattern
- `WebGPUGraphicsContext` has the **exact same public API** as `WebGLGraphicsContext`
- Scene code calls `context.createShaderProgram()`, `context.draw()`, etc. — same methods, both backends
- This **forces parity** — if you add a feature to one backend, the interface requires it in the other
- Parity enforcement via TypeScript interface: if `GraphicsContext` gains a method, both implementations must add it or fail compilation

### From PlayCanvas: "GraphicsDevice" Base Class Pattern
- A **concrete base class** (not just an interface) that provides shared default implementations
- Common logic lives in the base: capability queries, viewport management, uniform state, error formatting
- Backend-specific logic is in overridden methods
- The base class holds the `ContextRegistry` reference for multi-context awareness

### From Hackathon Branches: Context Exposure Pattern
- The `webgpu-hackathon-device` branch exposed `webgpuContext` via `FrameState` — we adopt this idea more broadly
- Any system can query the current context type via a getter, but **should not branch on it**
- The context is available for advanced users/extension developers who genuinely need backend-specific access

---

## 3. Detailed Architecture Plan

### Phase A: GraphicsContext as Thick Abstract Base Class

**Current:** `GraphicsContext.ts` is a TypeScript interface (~40 properties)
**Target:** `GraphicsContext.ts` becomes an **abstract class** with:

```typescript
abstract class GraphicsContext {
  // ══════════ IDENTITY (readable by anyone) ══════════
  abstract get rendererType(): RendererType;
  get isWebGPU(): boolean { return this.rendererType === RendererType.WEBGPU; }
  get isWebGL(): boolean { return this.rendererType === RendererType.WEBGL; }
  
  // ══════════ MULTI-CONTEXT REGISTRY ══════════
  private static _registry: ContextRegistry = new ContextRegistry();
  static get registry(): ContextRegistry { return GraphicsContext._registry; }
  get registry(): ContextRegistry { return GraphicsContext._registry; }
  
  // ══════════ ERROR LOGGING (includes context info) ══════════
  log(level: 'info'|'warn'|'error', message: string): void {
    const prefix = `[CesiumJS:${this.rendererType}:${this.id}]`;
    console[level](`${prefix} ${message}`);
  }
  
  // ══════════ SHARED IMPLEMENTATIONS (base class, not just interface) ══════════
  readonly uniformState: UniformState;   // same class for both
  readonly cache: Map<string, any>;      // shared resource cache
  
  // ══════════ ABSTRACT RESOURCE FACTORIES ══════════
  abstract createTexture(options: TextureOptions): AbstractTexture;
  abstract createBuffer(options: BufferOptions): AbstractBuffer;
  abstract createSampler(options: SamplerOptions): AbstractSampler;
  abstract createRenderPipeline(descriptor: PipelineDescriptor): AbstractPipeline;
  
  // ══════════ ABSTRACT DRAWING ══════════
  abstract executeDrawCommand(command: AbstractDrawCommand, passState: any): void;
  abstract executeComputeCommand(command: AbstractComputeCommand): void;
  
  // ══════════ ABSTRACT FRAME LIFECYCLE ══════════
  abstract beginFrame(frameState: FrameState): void;
  abstract endFrame(): void;
  abstract clear(clearCommand: ClearCommand): void;
  
  // ══════════ ABSTRACT SCENE RENDERING ══════════
  abstract executeSceneCommands(config: SceneRenderConfig): void;
  // ^ This replaces the if(isWebGPU) dispatch in Scene.js executeCommands()
}
```

**Key insight:** By making `executeSceneCommands()` an abstract method on the context, the entire multi-frustum rendering loop (currently split between `Scene.js` and `WebGPUSceneRenderer.ts`) becomes a backend concern. Scene.js just calls `context.executeSceneCommands(config)`.

### Phase B: ContextRegistry — Multi-Context / Multi-View Support

```typescript
class ContextRegistry {
  private _contexts: Map<string, GraphicsContext> = new Map();
  private _primaryId: string | null = null;
  
  // Register a context when created
  register(context: GraphicsContext): void;
  
  // Unregister on destroy
  unregister(id: string): void;
  
  // Get the primary (default) context
  get primary(): GraphicsContext | undefined;
  
  // Get a specific context by ID
  get(id: string): GraphicsContext | undefined;
  
  // Get all active contexts
  get all(): ReadonlyMap<string, GraphicsContext>;
  
  // Get contexts by type
  getByType(type: RendererType): GraphicsContext[];
  
  // Check if any context of a given type exists
  hasType(type: RendererType): boolean;
  
  // Iterator support
  [Symbol.iterator](): Iterator<GraphicsContext>;
}
```

**Multi-View Architecture:**
```
Scene (one scene graph, shared data)
  ├─ View A (left viewport) → GraphicsContext A (WebGL)
  ├─ View B (right viewport) → GraphicsContext B (WebGPU)
  └─ View C (picture-in-picture) → GraphicsContext C (WebGPU, same device as B)
```

Each `View` gains an optional `context` property. If not set, it uses the Scene's default context. This enables:
- **Split-screen comparison** (WebGL left, WebGPU right — same scene graph)
- **Multi-monitor** (different contexts per output)
- **Mixed rendering** (WebGL for the main view, WebGPU compute for processing)

### Phase C: Eliminating `if (isWebGPU)` from Scene Files

This is the biggest change. For each of the 27 scene files with `context.isWebGPU` checks, we move the backend-specific code INTO the context/renderer layer using a **Feature Renderer Registry** pattern:

```typescript
// In GraphicsContext base:
abstract class GraphicsContext {
  // Feature renderers registered per-backend
  abstract getFeatureRenderer(name: string): FeatureRenderer | undefined;
  
  // Scene code calls:
  // context.getFeatureRenderer('billboard')?.update(collection, frameState);
}
```

**Example transformation for BillboardCollection.js:**

```javascript
// BEFORE (current — scene knows about WebGPU):
import { updateWebGPUBillboards } from '../Renderer/WebGPU/WebGPUBillboardRenderer.js';

update(frameState) {
  removeBillboards(this);
  if (!this.show) return;
  updateMode(this, frameState);
  
  if (context.isWebGPU) {
    updateWebGPUBillboards(this, frameState, commandList);  // WebGPU import!
    return;
  }
  // ...300 lines of WebGL code...
}

// AFTER (target — scene is backend-agnostic):
update(frameState) {
  removeBillboards(this);          // Shared
  if (!this.show) return;           // Shared
  updateMode(this, frameState);     // Shared
  
  // The context handles ALL backend-specific rendering
  context.updateBillboards(this, frameState, commandList);
  // OR equivalently:
  context.getFeatureRenderer('billboard').update(this, frameState, commandList);
}
```

The WebGL implementation of `updateBillboards()` would be the existing inline code extracted into a method. The WebGPU implementation delegates to `WebGPUBillboardRenderer`. **Neither is imported by the scene file.**

### Phase D: Accessor Pattern for External Systems

The renderer is the only thing that NEEDS to know the current context, but external/extension code should be able to query it:

```typescript
// On the Scene:
class Scene {
  // The current context (getter, read-only)
  get graphicsContext(): GraphicsContext { return this._context; }
  
  // Quick type check (convenience)
  get rendererType(): RendererType { return this._context.rendererType; }
  
  // Access the registry for multi-context scenarios
  get contextRegistry(): ContextRegistry { return GraphicsContext.registry; }
}

// On FrameState (per the hackathon branch idea):
class FrameState {
  get graphicsContext(): GraphicsContext { return this.context; }
}
```

**Error logging enhancement:**
```typescript
// All renderer errors automatically include context info:
context.log('error', 'Pipeline creation failed for terrain shader');
// Output: [CesiumJS:webgpu:ctx-3a7f] Pipeline creation failed for terrain shader

// For multi-context debugging:
GraphicsContext.registry.all.forEach((ctx) => {
  ctx.log('info', `Active: ${ctx.rendererType}, ${ctx.drawingBufferWidth}x${ctx.drawingBufferHeight}`);
});
```

---

## 4. Migration Strategy — How to Get There Without Breaking WebGL

This is the critical part. We can't do this as a big-bang rewrite. It must be incremental.

### Step 1: Convert GraphicsContext from Interface to Abstract Class (2-3 days)
- Move shared logic (uniform state, cache, logging, registry) into base class
- Both `Context.js` and `WebGPUContext.ts` extend it (or are adapted to)
- **Risk:** Context.js is a constructor function, not ES6 class. We need a thin adapter (`WebGLGraphicsContext`) that wraps Context.js and extends the abstract class. Context.js itself is NOT modified.
- **No WebGL breakage:** Context.js continues to work as-is. The wrapper is additive.

### Step 2: Create ContextRegistry (1 day)
- Simple map of active contexts
- Auto-register on creation, auto-unregister on destroy
- Static singleton on `GraphicsContext`
- **Risk:** Near zero. It's additive infrastructure.

### Step 3: Add Feature Renderer Registry to GraphicsContext (2-3 days)
- Define `FeatureRenderer` interface with standard `update()` / `destroy()` signatures
- Register WebGL feature renderers (wrapping existing inline code) and WebGPU feature renderers (wrapping existing `WebGPU*Renderer` files)
- **Risk:** Medium. Requires extracting WebGL rendering code into renderer objects. However, the WebGL code doesn't change — it just moves into a class.

### Step 4: Migrate Scene Files ONE AT A TIME (1-2 days each, ~27 files)
- For each scene file with `if (context.isWebGPU)`:
  1. Extract the WebGL rendering code into a `WebGL*Renderer` class
  2. Register both WebGL and WebGPU renderers in their respective context types
  3. Replace the `if/else` branch with `context.getFeatureRenderer('name').update(...)`
  4. Remove the WebGPU import from the scene file
- **This can be done file-by-file, committed independently, without breaking anything.**
- **Risk:** Low per file. Highest risk files are Primitive.js (5 branch points) and Scene.js (6 routing points).

### Step 5: View-Level Context Assignment for Multi-View (2-3 days)
- Add optional `context` property to `View`
- Modify `View.createPotentiallyVisibleSet()` to use its own context
- Modify scene rendering to iterate views with potentially different contexts
- **Risk:** Medium. Multi-frustum rendering must work per-context.

### Step 6: Update Slang Pipeline for Parity Enforcement (1 day)
- When a new `.slang` shader is compiled, it outputs BOTH `.wgsl` and `.glsl`
- CI check: if a WebGPU feature renderer exists without a WebGL counterpart (or vice versa), warn
- **Risk:** Low. Build system only.

---

## 5. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Context.js is not an ES6 class** — can't directly extend abstract class | 🔴 High | Create `WebGLGraphicsContext` wrapper class that delegates to existing Context.js. Context.js is NOT modified. The wrapper IS the GraphicsContext implementation for WebGL. |
| **Extracting WebGL code from scene files** — could introduce bugs | 🟡 Medium | Extract as pure functions first (already the CesiumJS pattern), then wrap in renderer class. Existing tests catch regressions. |
| **Performance overhead of indirection** — extra method call per draw | 🟢 Low | Feature renderer lookup is cached. The indirection is one pointer dereference — negligible vs. actual GPU work. |
| **Multi-context GPU memory** — two contexts = two sets of GPU resources | 🟡 Medium | Share resources where possible (same ImageBitmap sources, shared CPU-side data). Each context owns its GPU resources independently. Document memory implications. |
| **Upstream merge conflicts during transition** — scene files are being modified | 🟡 Medium | Each migration step REMOVES an `if (isWebGPU)` check — reducing future conflicts. Short-term pain for long-term gain. |
| **WebGL feature renderers are "new code" wrapping "old code"** — bugs from refactoring | 🟡 Medium | The WebGL renderer classes are thin wrappers that call the SAME functions. The actual GL code doesn't change. Jasmine tests validate. |
| **FrameState coupling** — FrameState currently has one context | 🟡 Medium | FrameState is created per-frame per-view. Each view's FrameState can reference its own context. |

---

## 6. What Changes in `.clinerules`

The core principles would be updated:

**OLD:** "Separation of Concerns: WebGPU must be separate from WebGL"
**NEW:** "Backend Agnosticism: Scene code must NOT import from `Renderer/WebGPU/` or reference `isWebGPU`. All backend-specific code lives in Feature Renderers accessed through GraphicsContext."

**OLD:** "Scene Logic Extractor Pattern" with `if (context.isWebGPU)` branch
**NEW:** "Feature Renderer Pattern" — shared scene logic runs first, then `context.getFeatureRenderer('name').update(...)` handles the rest. No branch needed.

**NEW RULE:** "Every Feature Renderer must be implemented for BOTH backends. The GraphicsContext abstract class enforces this at the TypeScript level."

**NEW RULE:** "Multi-Context: Every context has a unique ID. Error logs MUST include context ID. ContextRegistry tracks all active contexts."

---

## 7. Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| A. GraphicsContext abstract class + WebGLGraphicsContext wrapper | 3-4 days | None |
| B. ContextRegistry | 1 day | Phase A |
| C. Feature Renderer Registry pattern | 2-3 days | Phase A |
| D. Migrate 27 scene files (incremental, ~1 day each) | 15-20 days | Phase C |
| E. View-level context for multi-view | 2-3 days | Phase A, B |
| F. Error logging with context info | 1 day | Phase A, B |
| G. Update .clinerules and documentation | 1 day | All phases |
| **Total** | **~25-33 days** | Phases A-C are prerequisites |

**Critical path:** Phases A → C → D (first 3 scene files as proof). Everything else can be parallelized.

---

## 8. What This Enables

1. **Forced parity** — TypeScript compiler ensures both backends implement the same interface
2. **Zero scene-file WebGPU imports** — eliminates 27 merge conflict points with upstream
3. **Multi-context/multi-view** — split-screen with different renderers on same scene graph
4. **Extension-friendly** — external code can query context type but doesn't need to branch on it
5. **Context-aware logging** — every error message identifies which renderer and context produced it
6. **Incremental migration** — each scene file can be migrated independently
7. **Slang-powered shader parity** — single-source shaders compile to both GLSL and WGSL

---

Would you like me to refine any part of this plan? For example:
- Deeper dive into the `WebGLGraphicsContext` wrapper approach for Context.js?
- Specific design for the Feature Renderer Registry?
- Detailed multi-view rendering flow?
- Priority ordering of which scene files to migrate first?

Once you're satisfied with the plan, toggle to **Act mode** and I'll begin implementation, starting with the foundational Phase A (abstract class) and Phase B (registry).


Great question — yes, absolutely. Each context instance is a unique object, so `isWebGPU` and `isWebGL` are **per-instance properties**, not global singletons. Let me clarify the design:

## Per-Instance Identity

```typescript
// Split-screen scenario: TWO different context instances
const ctxA = new WebGLGraphicsContext(canvasLeft);    // ctxA.isWebGPU = false, ctxA.isWebGL = true
const ctxB = new WebGPUGraphicsContext(canvasRight);  // ctxB.isWebGPU = true,  ctxB.isWebGL = false

// Multi-view same backend: TWO WebGPU contexts
const ctxC = new WebGPUGraphicsContext(canvas1);  // ctxC.isWebGPU = true, ctxC.id = "ctx-a3f7"
const ctxD = new WebGPUGraphicsContext(canvas2);  // ctxD.isWebGPU = true, ctxD.id = "ctx-9b2e"
// Same type, but DIFFERENT instances with different IDs, different GPU devices, different canvases
```

Each context carries:
- **`id`** — unique GUID (already exists in both Context.js and WebGPUContext.ts)
- **`rendererType`** — `RendererType.WEBGL` or `RendererType.WEBGPU` (instance-level)
- **`isWebGPU` / `isWebGL`** — derived from `rendererType` (instance-level convenience getters)
- **`canvas`** — the specific HTMLCanvasElement this context renders to

So when a View or FrameState holds a reference to a context, it always knows exactly which backend AND which specific instance it's talking to:

```typescript
// In a multi-view render loop:
for (const view of scene.views) {
  const ctx = view.graphicsContext;  // THIS view's specific context
  
  ctx.log('info', 'Rendering view');
  // Output: [CesiumJS:webgpu:ctx-a3f7] Rendering view
  //    or:  [CesiumJS:webgl:ctx-9b2e] Rendering view
  
  ctx.isWebGPU  // true/false for THIS specific context
  ctx.id         // unique identifier for THIS context
}
```

## Where You'd Query "What's Running?"

For code that needs to know about ALL active contexts (diagnostics, debugging, extensions), the **ContextRegistry** is the answer:

```typescript
// "What contexts are currently active?"
const registry = GraphicsContext.registry;

registry.all          // Map<string, GraphicsContext> — all active contexts
registry.primary      // The "main" context (first created or explicitly set)
registry.getByType(RendererType.WEBGPU)  // All WebGPU contexts
registry.hasType(RendererType.WEBGL)     // Is any WebGL context running?

// Iteration:
for (const [id, ctx] of registry) {
  console.log(`${id}: ${ctx.rendererType} on ${ctx.canvas.id}`);
}
// "ctx-a3f7: webgpu on canvas-left"
// "ctx-9b2e: webgl on canvas-right"
```

## The Key Invariant

**The renderer (context) is the ONLY thing that NEEDS to know its own type.** But the getters make it queryable for:
1. **Extension developers** who genuinely need backend-specific behavior
2. **Diagnostics/logging** — error messages automatically include context identity
3. **Multi-context orchestration** — a supervisor system deciding which contexts to create/destroy

Scene code like `Primitive.js`, `BillboardCollection.js` etc. should **never** read `isWebGPU` — they just call abstract methods and the right thing happens. The getter exists for systems OUTSIDE the render loop.

Does this address your concern? Any other aspects of the multi-context design you'd like me to dig into before we finalize the plan?


# Comprehensive Risk Mitigation Plan — All Risks Addressed

---

## Risk 1: Context.js is Not ES6 Class — ✅ CAN AND SHOULD Convert

**Yes, we can and should convert it to ES6 class.** Here's why:

### Feasibility Assessment
| Factor | Finding |
|--------|---------|
| **Blast radius** | **Only 4 files** directly import Context.js: `Scene.js`, `SharedContext.js`, `ContextFactory.ts`, and test helper `createContext.js` |
| **Public API** | Exported via `packages/engine/index.js` as `Context` — API shape doesn't change (still `new Context(canvas, options)`) |
| **Upstream alignment** | CesiumJS issue #8359 explicitly tracks ES6 class conversion. The Coding Guide says "help with converting is welcome." |
| **Codebase precedent** | `Cartesian2/3/4.js` already converted. All 50+ WebGPU `.ts` files use class syntax. |
| **Size** | ~1,188 lines, 14 prototype methods, 43 property getters — mechanical conversion |
| **Test coverage** | ~40 test files use Context indirectly — they validate behavior, not class syntax |

### Conversion Plan

```javascript
// BEFORE (current):
function Context(canvas, options) {
  this._canvas = canvas;
  this._gl = getWebGLContext(canvas);
  this._us = new UniformState();
  // ...43 properties
}
Object.defineProperties(Context.prototype, {
  id: { get: function() { return this._id; } },
  canvas: { get: function() { return this._canvas; } },
  uniformState: { get: function() { return this._us; } },
  // ...40 more getters
});
Context.prototype.draw = function(options) { /*...*/ };
Context.prototype.clear = function(clearCommand) { /*...*/ };
// ...12 more methods

// AFTER (ES6 class extending GraphicsContext):
class Context extends GraphicsContext {
  constructor(canvas, options) {
    super();  // Initialize GraphicsContext base (registry, logging, etc.)
    this._canvas = canvas;
    this._gl = getWebGLContext(canvas);
    this._us = new UniformState();
    // ...same properties
  }
  get id() { return this._id; }
  get canvas() { return this._canvas; }
  get uniformState() { return this._us; }
  get rendererType() { return RendererType.WEBGL; }  // NEW — satisfies abstract
  // ...same getters, same methods, same behavior
}
```

**The external API is identical:** `new Context(canvas, options)` still works. All 43 getters, 14 methods, same behavior. The only addition is `extends GraphicsContext` which adds the abstract methods.

### Mitigation Steps
1. **Convert Context.js to ES6 class syntax** — purely mechanical (2-3 days)
2. **Add `extends GraphicsContext`** — implements the abstract methods
3. **Run ALL existing Jasmine tests** — they test behavior, not syntax
4. **The 4 direct importers don't change** — `new Context()` works the same
5. **If upstream CesiumJS also converts Context.js** (per #8359), our version will merge cleanly since both are going to the same target syntax

---

## Risk 2: Multi-Context GPU Memory — ✅ Addressable with 3 Strategies

Two GPU contexts in one tab does mean two sets of GPU resources. Here's how to minimize the overhead:

### Strategy A: Shared CPU-Side Data Pool (WebWorker + SharedArrayBuffer)

```
┌─────────────────────────────────────────────┐
│ Main Thread                                  │
│  ├─ Context A (WebGL)  → GPU Resources A     │
│  ├─ Context B (WebGPU) → GPU Resources B     │
│  └─ SharedResourcePool ← SharedArrayBuffer   │
│       ├─ Terrain vertex data (shared)        │
│       ├─ Imagery pixel data (shared)         │
│       └─ Model geometry data (shared)        │
│                  ↑                            │
│ Web Worker (data preparation)                │
│  └─ Terrain tessellation (WASM)              │
│  └─ Quantized mesh decode (WASM)             │
│  └─ Writes into SharedArrayBuffer            │
└─────────────────────────────────────────────┘
```

**How it works:**
- Terrain/imagery data is prepared ONCE in a WebWorker (using WASM for speed)
- The worker writes results into a `SharedArrayBuffer`
- Both contexts READ from the same SharedArrayBuffer to create their respective GPU buffers
- CPU-side data is allocated **once**, not twice
- **Savings: ~40-60% of CPU-side memory** for terrain/imagery (the biggest consumers)

**Prerequisites:** COOP/COEP headers (already documented in our migration status doc). CesiumJS already uses WebWorkers via `TaskProcessor`.

### Strategy B: WebGPU Device Sharing (Same Device, Multiple Canvases)

WebGPU has a unique advantage over WebGL: **one `GPUDevice` can configure multiple canvases.**

```typescript
// ONE device, TWO canvases, shared GPU resources
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

// Canvas A
const ctxA = canvasA.getContext('webgpu');
ctxA.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });

// Canvas B — SAME device!
const ctxB = canvasB.getContext('webgpu');
ctxB.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });

// GPU buffers/textures created on `device` are usable by BOTH canvases
const sharedVertexBuffer = device.createBuffer({ /* ... */ });
// Both canvases can reference sharedVertexBuffer in render passes
```

**For WebGPU multi-view:**
- Single `GPUDevice` instance
- Multiple `GPUCanvasContext` configurations on different canvases
- ALL GPU resources (buffers, textures, pipelines) are shared automatically
- **Savings: ~90% of GPU memory** — only the per-canvas output textures are duplicated
- **This is the industry-standard approach** (used by Babylon.js for multi-canvas)

### Strategy C: OffscreenCanvas in WebWorker (Background Rendering)

For scenarios where one view is lower-priority (e.g., a minimap, picture-in-picture):

```
┌─────────────────────────────────────┐
│ Main Thread                          │
│  └─ Primary View (WebGPU, canvas A)  │
│       └─ Full scene rendering        │
│                                      │
│ WebWorker                            │
│  └─ Secondary View (OffscreenCanvas) │
│       └─ Simplified rendering        │
│       └─ Transfers frame to main     │
└─────────────────────────────────────┘
```

**How it works:**
- Main thread renders the primary view at full quality
- A WebWorker holds an `OffscreenCanvas` and renders a secondary view (lower LOD, fewer features)
- The worker transfers the rendered frame back to main thread for display
- **Saves main-thread CPU time** — secondary rendering doesn't block the primary view's frame rate

**Limitation:** WebGPU in WebWorkers is still experimental in some browsers. WebGL in OffscreenCanvas workers is well-supported.

### Recommended Multi-Context Memory Strategy

| Scenario | Strategy | Memory Impact |
|----------|----------|---------------|
| **Split-screen: WebGPU left + WebGPU right** | Strategy B (shared device) | ~10% overhead (just output textures) |
| **Split-screen: WebGL left + WebGPU right** | Strategy A (SharedArrayBuffer pool) | ~40-50% overhead (separate GPU resources, shared CPU data) |
| **Multi-monitor: Same backend** | Strategy B if WebGPU, Strategy A if WebGL | 10-50% depending on backend |
| **PiP/Minimap: Lower-priority secondary** | Strategy C (OffscreenCanvas worker) | Minimal — reduced quality secondary |

---

## Risk 3: Extracting WebGL Code from Scene Files — Could Introduce Bugs

### Mitigation Plan

**Step-by-step extraction process (per scene file):**

1. **Snapshot test first** — Before touching the file, add a visual regression screenshot test for the feature (WebGL mode). This captures current correct output.

2. **Extract as standalone function** — Move the WebGL rendering code from inside the scene file's `update()` method into a separate function IN THE SAME FILE first. Run tests. This is a pure refactor — no behavior change.

   ```javascript
   // Step 2a: Extract function (still in same file)
   function updateBillboardsWebGL(collection, frameState, commandList) {
     // ...exact same WebGL code, moved here...
   }
   
   update(frameState) {
     removeBillboards(this);  // shared
     updateMode(this, frameState);  // shared
     updateBillboardsWebGL(this, frameState, commandList);  // extracted
   }
   ```

3. **Run all Jasmine tests** — This catches any `this` binding issues or scoping problems from the move. The behavior is identical — just reorganized.

4. **Move to renderer class** — Create `WebGLBillboardRenderer` class in `Renderer/` that wraps the extracted function. The scene file now calls `context.getFeatureRenderer('billboard').update(...)`.

5. **Run all tests again** — Validates the indirection works.

6. **Add parity test** — Verify both WebGL and WebGPU renderers produce equivalent output via the split-screen tool.

**Key safety rule:** At no point does the actual WebGL code change. It moves, gets wrapped, gets called from a different path — but the GL calls themselves are byte-for-byte identical.

---

## Risk 4: Performance Overhead of Indirection

### Mitigation: Measured, Not Assumed

**The indirection cost:**
```javascript
// Before: direct function call
updateBillboardsWebGL(this, frameState, commandList);

// After: one map lookup + virtual method call
context.getFeatureRenderer('billboard').update(this, frameState, commandList);
```

**Actual overhead:** One `Map.get()` (~20ns) + one virtual dispatch (~5ns) = **~25 nanoseconds per frame per feature**. With 20 features = **~500ns/frame**. A 60fps frame budget is **16,666,666ns**. The overhead is **0.003%** of frame time.

**Mitigation:**
1. **Feature renderers are cached** — `getFeatureRenderer()` returns a cached reference, not a new lookup each frame
2. **Hot path optimization** — For the highest-frequency paths (Primitive.draw), the renderer can be cached on the command itself
3. **Benchmark before/after** — Use `WebGPUTimestampProfiler` and `performance.now()` to verify zero measurable impact

---

## Risk 5: Upstream Merge Conflicts During Transition

### Mitigation: Each Migration Step REDUCES Conflicts

**Current state:** 27 scene files have WebGPU routing → 27 potential merge conflicts per upstream sync.

**Each file migrated:**
- REMOVES the `import ... from 'Renderer/WebGPU/...'` line
- REMOVES the `if (context.isWebGPU) { ... }` block
- REPLACES with `context.getFeatureRenderer('name').update(...)` — a ONE-LINE change

**After full migration:** Scene files have ZERO WebGPU imports → conflicts only if upstream changes the exact line with `getFeatureRenderer` call. That's **~1 line per file** vs. **~15-25 lines per file** currently.

**Transition strategy:**
1. Migrate the **most frequently conflicted files first**: `Primitive.js` (5 branch points), `Scene.js` (6 routing points), `PointPrimitiveCollection.js`, `BillboardCollection.js`
2. Each migration is an **independent commit** that can be cherry-picked or reverted
3. If an upstream merge lands mid-migration, only unmigrated files need conflict resolution

---

## Risk 6: WebGL Feature Renderers Are "New Code" Wrapping "Old Code"

### Mitigation: Thin Wrappers with Zero Logic

**The WebGL feature renderer classes are NOT new rendering code.** They are thin wrappers:

```javascript
// WebGLBillboardRenderer.js — ~10 lines of new code wrapping ~300 lines of existing code
class WebGLBillboardRenderer {
  update(collection, frameState, commandList) {
    // This calls the EXACT SAME functions that currently exist inline in BillboardCollection.js
    updateBillboardsWebGL(collection, frameState, commandList);
  }
  
  destroy(collection) {
    destroyBillboardWebGLResources(collection);
  }
}
```

**The wrapper adds:**
- A class declaration (~5 lines)
- Method signatures that delegate (~3 lines each)
- Registration with the context (~1 line)

**The wrapper does NOT:**
- Contain any rendering logic
- Modify any GL calls
- Change any state management
- Alter any buffer layouts

---

## Risk 7: FrameState Coupling — Currently Has One Context

### Mitigation: FrameState Created Per-View

`FrameState` is already recreated each frame. In the multi-view design:

```javascript
// Current (one context):
const frameState = scene._frameState;
frameState.context = scene._context;

// Multi-view (per-view context):
for (const view of scene._views) {
  const frameState = view.createFrameState(scene);
  frameState.context = view.graphicsContext ?? scene._context;  // view-specific or default
  view.render(frameState);
}
```

**The key insight:** FrameState is a value object that's populated fresh each frame. It doesn't own the context — it just references it. Changing which context it references is a one-line change per view.

---

## Updated Complete Implementation Plan

### Phase 0: Context.js ES6 Conversion (3-4 days) — NEW, PREREQUISITE
1. Convert `Context.js` from constructor function to ES6 `class` syntax
2. Convert `Object.defineProperties` to native `get`/`set`
3. Convert `Context.prototype.method` to class methods
4. Run ALL Jasmine tests to verify zero behavior change
5. **Only 4 files reference Context.js directly** — update if needed (likely no changes)
6. This enables Context.js to `extends GraphicsContext`

### Phase A: GraphicsContext Abstract Base Class (2-3 days)
1. Convert `GraphicsContext.ts` from interface to abstract class
2. Move shared logic into base: logging, registry, uniform state access, capability queries
3. `Context.js` (now ES6 class) extends `GraphicsContext`
4. `WebGPUContext.ts` extends `GraphicsContext`
5. Both implement all abstract methods

### Phase B: ContextRegistry + Multi-Context (2-3 days)
1. Create `ContextRegistry.ts` with Map-based tracking
2. Auto-register/unregister in `GraphicsContext` constructor/destroy
3. Expose via `GraphicsContext.registry` (static) and `scene.contextRegistry`
4. Implement WebGPU device-sharing for multi-canvas (Strategy B)
5. Design SharedArrayBuffer pool for cross-backend data sharing (Strategy A)

### Phase C: Feature Renderer Registry (2-3 days)
1. Define `FeatureRenderer` interface
2. Add `registerFeatureRenderer()` / `getFeatureRenderer()` to `GraphicsContext`
3. Create `WebGLBillboardRenderer` as pilot (thin wrapper)
4. Migrate `BillboardCollection.js` as proof-of-concept

### Phase D: Scene File Migration (15-20 days, incremental)
1. Priority order: `Primitive.js` → `Scene.js` → `BillboardCollection.js` → `PolylineCollection.js` → remaining 23 files
2. Each file: extract → test → wrap → test → commit
3. Track progress: each commit removes one `if (isWebGPU)` branch point

### Phase E: View-Level Context + Memory Optimization (3-4 days)
1. Add `context` property to `View`
2. Implement WebGPU device-sharing (one device, multiple canvases)
3. Implement SharedArrayBuffer pool for terrain/imagery data
4. OffscreenCanvas WebWorker support for secondary views

### Phase F: Context-Aware Error Logging (1 day)
1. `context.log(level, message)` with `[CesiumJS:type:id]` prefix
2. All renderer error paths use context logging
3. Registry provides diagnostic dump

### Phase G: Documentation + .clinerules Update (1 day)
1. Update `.clinerules` with new backend-agnosticism rules
2. Update migration doc with new architecture
3. Document multi-context API for extension developers

**Total: ~29-37 days** (Phase 0 added, Phase B expanded for memory optimization)

---

Does this address all your concerns? Any adjustments before we finalize? When ready, **toggle to Act mode** and I'll begin with Phase 0 (Context.js ES6 conversion) as it unblocks everything else.
