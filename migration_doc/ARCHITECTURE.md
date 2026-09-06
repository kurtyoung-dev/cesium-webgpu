> **Canonical doc (consolidation first draft, 2026 consolidation).**
> Supersedes (folds in): `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`,
> `migration_doc/archive/audits-2026-04-30/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md` (archived
> 2026-09-03; survivability content migrated to `ARCHITECTURE_REVIEW_2026-09-02.md` §3.11) (architecture
> portions), and the "Architecture Patterns" / "64-Bit Precision & RTE" /
> "WGSL Shader Pipeline" / "Monorepo Architecture" / "Logging & Debug Pragmas"
> sections of `cesium-webgpu/CLAUDE.md` (CLAUDE.md remains the authoritative
> *rules* file; this doc is the explanatory *architecture* reference).
> **Review-in-progress.** Status tags re-verified against live code + git log at
> HEAD ≈ Batch 455. Where a claim could not be confirmed it is marked
> `status: verify`.
> **2026-07-02 refresh (post-campaign audit, Batches 482–506, HEAD
> `62c5bab450`):** §11 (PP library interception) + §12 (voxel data path) added.
> **2026-09-05 refresh (documentation wave D1, HEAD `dc58236ebd`, Batch 1424):**
> §1's Scene-boundary residue, §4a (the frame), §5's `previousViewProjection`
> block, §5.5 (uniform buffers), §6.1–6.3 (the two-word define model), §6.5 (the
> cache map) and §11.1 (post-process ordering) re-derived from engine source at
> that HEAD. That pass **superseded** two claims the 2026-07-02 refresh had
> certified — the "30 active bits" reading of §6.1 and the §6.3.1 framing of
> `keySalt` as an escape hatch for high define bits — and reversed §11.1, which
> had declared an ordering divergence that HEAD does not have. Treat any older
> certification of those sections as void.

# ARCHITECTURE — CesiumJS WebGPU Fork

The architectural foundations of the fork: the dual-backend abstraction and the
patterns that govern *all* WebGPU code. `FORK_OVERVIEW` is the catalog of *what*
is shipped; this doc is the *how* and *why* of the layering. Read this before
adding a renderer, a shader variant, or a Scene-level branch.

**Verification note.** The two primary source docs predate HEAD by ~270–340
batches (decomposition plan last refreshed Batch 185; maintainability audit
Batch 116). All line counts and status tags below were re-measured against the
live tree. Where the source docs and live code disagree, the live measurement
wins and the drift is called out.

---

## 1. Dual-Backend Model

The cornerstone is a single **abstract base class**, `GraphicsContext`, that
defines the unified rendering API. Both backends extend it:

```
GraphicsContext (abstract)        packages/engine/Source/Renderer/GraphicsContext.ts  (2001 LOC)
 ├── Context        (WebGL2)      packages/engine/Source/Renderer/Context.js
 └── WebGPUContext  (WebGPU)      packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts (5512 LOC)
```

Design philosophy is an explicit **Three.js + PlayCanvas hybrid** (stated in
the `GraphicsContext.ts` module docstring):

- **From Three.js:** both `Context.js` and `WebGPUContext.ts` implement the same
  abstract API, and TypeScript enforces parity at compile time — adding a method
  to `GraphicsContext` forces both backends to implement it.
- **From PlayCanvas:** `GraphicsContext` is a *concrete* base class (not a bare
  interface). It provides shared default implementations for logging, registry
  management, feature-renderer lookup, and capability queries. Only
  backend-specific logic lives in overridden abstract methods.

### Backend-agnostic Scene code (the central rule)

Scene code reaches the backend through `GraphicsContext`. The rule is that it
neither imports from `Renderer/WebGPU/` nor branches on `isWebGPU` — with a small,
**enumerated and sanctioned** residue, not with none. Stating it as an absolute
is what lets a reader treat any single counter-example as proof the rule is
dead; here is the exact residue, re-measured at HEAD:

- **Imports.** Non-recursive `Source/Scene/*.js` has **zero** imports from
  `Renderer/WebGPU/`. (Four files mention the path in prose only —
  `ClippingPolygonSdfPack.js:18`, `Moon.js:1005`, `SolarDiscModel.js:22`,
  `StarField.js:30` — so a bare substring grep over that glob reports four
  hits, none of them an import.) Recursively, `Source/Scene/**` has **exactly
  one** import, and it is sanctioned:
  `Scene/Model/MetadataWGSLPipelineStage.js:60` importing
  `WebGPUModelMetadata.js`, recorded at
  `ARCHITECTURE_REVIEW_2026-09-02.md:503`. It is the only one; a second is a
  new violation, not a precedent.
- **Branches.** `context.isWebGPU` is read in **four** control-flow branches
  under `Source/Scene/**`: `GlobeSurfaceShaderSet.js:1138`,
  `OceanSurfacePrimitive.js:384` and `:502`, and `ViewportQuad.js:144`. The
  public getter (`Scene.js:2797`), the `SceneDebug.js:191` renderer label and
  the `CesiumDebug.js` WebGPU-only guards are **not** branches. Older
  "~15 transitional branches" counts swept `isWebGPUDrawCommand`, comments and
  those non-branches into one substring total.

External/extension code *may* query `context.rendererType` /
`context.isWebGPU` for introspection but should not branch rendering logic on
it. Inside the engine the convention since Batch 303 is to branch on a
`context.supportsX` capability getter instead
(`ARCHITECTURE_REVIEW_2026-09-02.md:504`).

### ContextFactory — entry point + auto-selection

`ContextFactory.createContext(canvas, options)`
(`packages/engine/Source/Renderer/ContextFactory.ts`) is the single creation
entry point. It:

- resolves `RendererType.AUTO` against `isWebGPUSupported()` (presence check:
  `typeof navigator !== "undefined" && "gpu" in navigator`),
- gracefully falls back to WebGL with a `console.warn` when WebGPU is
  unavailable,
- and (in the dual build) keeps `await import("./WebGPU/WebGPUContext.js")`
  dynamic so the WebGPU chunk only downloads when actually selected.

**Known fallback gap** (from the audit, re-confirm if relevant): the factory
detection only checks `navigator.gpu` *presence*. Apps that pass
`renderer: 'webgpu'` explicitly do **not** auto-fall-back if `requestAdapter()`
returns null at runtime — `WebGPUContext.create()` throws and the caller must
catch. `renderer: 'auto'` apps get correct behavior.

The runtime default backend is a process-wide singleton, `_globalDefaultRenderer`
in `RendererType.ts`, set by each build-variant entry barrel via
`setGlobalDefaultRenderer()`. This is the only default-renderer hint; per-Viewer
`contextOptions.renderer` always overrides it.

---

## 2. Multi-Context Support

Every `GraphicsContext` instance carries a unique `id` (a `createGuid()` string)
and its own `rendererType`. A static `ContextRegistry`
(`packages/engine/Source/Renderer/ContextRegistry.ts`) tracks all live contexts,
accessed via `GraphicsContext.registry` or `scene.contextRegistry`.

```ts
GraphicsContext.registry.all                    // every active context
GraphicsContext.registry.getByType(RendererType.WEBGPU)
GraphicsContext.registry.hasType(RendererType.WEBGPU)
GraphicsContext.registry.count
```

The registry is a `Map<string, RegistrableContext>` keyed by id, where
`RegistrableContext` is a minimal `{ id, rendererType, canvas }` interface kept
deliberately small to avoid a circular dependency with `GraphicsContext`. This
enables:

- **Split-screen** — WebGL left + WebGPU right over the same scene graph (the
  `Apps/WebGPUTest/split-screen-comparison.html` harness).
- **Multi-monitor / multi-view** — different canvases, same or different backends.
- **Mixed** — WebGL for rendering plus WebGPU compute for processing.

Multi-instance device sharing is handled by `WebGPUDevicePool`
(`acquireDevice()` ref-counts a single `GPUDevice` across canvases;
`releaseDevice()` destroys at refcount 0). Error logs must include the context
id for disambiguation: `[CesiumJS:webgpu:ctx-a3f7] …`.

---

## 3. Feature Renderer Pattern

This is the **dominant integration point** between backend-agnostic Scene code
and the WebGPU backend (38+ Scene files use it per the audit).

### The lookup

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
if (fr) { fr.update(this, frameState, commandList); return; }
// WebGL code follows as the default fallback
```

`getFeatureRenderer(key)` returns the backend's registered implementation for
that key, or `undefined` if not yet loaded. WebGL has no registered renderers,
so the call returns `undefined` and execution falls through to the inline WebGL
path — the *same source file* serves both backends.

### Enumerated keys over string lookups

`FeatureRendererKey.js` (259 LOC) assigns a **numeric** id to every feature
renderer (`BILLBOARD_COLLECTION: 0 … CLIPPING_PLANES: 24 …`). Numeric keys give
O(1) array-index dispatch instead of string-hashed Map lookups. **Never** use a
string literal for a registry lookup when a finite key set exists — add a
`FeatureRendererKey` constant.

### Lazy / async loading lifecycle

The registry supports lazy construction with a discriminated load status
(`FeatureRendererLoadStatus`): `registered → loading → loaded` (or `failed`).
Three accessors:

- `getFeatureRenderer(key)` — sync; `undefined` until loaded.
- `getFeatureRendererAsync(key)` — awaits the in-flight loader promise.
- `getFeatureRendererStatus(key)` — introspection for debug snapshots and the
  registry-audit gulp task.

Most renderers (21 of 28 per the `CollectionRenderer` docstring) implement a
per-frame `update()`; others expose `execute()` / `render()` / `composite()` and
callers duck-type-dispatch by checking existence (see §3.1 for the full
vocabulary).

### Scene Logic Extractor rule — CRITICAL for Collections

Shared *scene-level* logic (entity dirty-tracking, visibility/show checks, scene-
mode updates, bounding-volume work) MUST run **before** the
`getFeatureRenderer` / `if (context.isWebGPU)` branch point. Feature renderers
handle only GPU resource creation, draw-command emission, and backend
optimizations — they do **not** re-implement shared scene logic. Putting shared
logic behind the branch silently desyncs the two backends.

### 3.1 Lifecycle method vocabulary (duck-typed)

The FR registry is **duck-typed**: callers check for a method's existence before
calling it, so an FR only implements the subset it needs — **there is no required
method.** The base `FeatureRenderer` interface plus three sub-type interfaces in
`GraphicsContext.ts` define the vocabulary:

- **`update(collection, frameState, ...args)`** — `CollectionRenderer`. The
  per-frame entry point and by far the most common (collections, environment,
  model, clipping, post-process). Builds resources and pushes draw commands.
- **`createCommands(...)` / `updateCommandUniforms(...)` / `createMaterial…` /
  `updatePickCommandUniforms(...)`** — `PrimitiveCommandRenderer` (the `PRIMITIVE`
  command factory and the ground / vector-tile classifiers).
- **`execute(...)`** — full-screen / post-process effects (SSR, NPR outlines,
  contact shadows, procedural clouds).
- **`composite(...)`** — a second pass run later in the frame (volumetric fog
  populates with `update`, then `composite`s into scene color).
- **`init(...)` / `dispatch(...)` / `readback(...)` / `getStatistics(...)`** —
  compute / system renderers (Hi-Z occlusion, GPU sort keys, shadow map, imagery
  reprojection).
- **`RendererClass` + `_instance`** — Shape B constructor pattern (§3.2).
- **`destroy(collection?)`** — tear down GPU resources. During *context*
  destruction, device teardown frees GPU resources automatically and
  `_destroyFeatureRenderers()` just nulls the slots; per-object cleanup (e.g.
  destroying a collection) is what calls `destroy` with the scene object.
- **`name`** — optional debug label; also used by **marker FRs** (§3.3).

### 3.2 Two implementation shapes

- **Shape A — free functions (most common).** Export `update` / `destroy` (and
  optionally `execute`, `composite`, `createCommands`, `init`, `getStatistics`,
  …) and register them as a plain object. Example:
  `WebGPUEllipsoidPrimitiveRenderer.ts`.
- **Shape B — `RendererClass` constructor.** For stateful system renderers
  (globe, scene orchestration), register a `RendererClass` constructor that the
  context instantiates on first touch and caches on `_instance` (e.g.
  `GLOBE_SURFACE` → `WebGPUGlobeSurfaceRenderer`, `SCENE_RENDERER` →
  `WebGPUSceneRenderer`).

### 3.3 Registration: eager vs lazy + marker FRs

All registration runs in `registerWebGPUFeatureRenderers(context)`
(`WebGPUFeatureRenderers.ts`), which `WebGPUContext` calls once during init:

- **`registerFeatureRenderer(key, renderer)` — EAGER.** For small / core-path
  renderers (collections, primitive, globe, model, clipping, IBL, environment).
  The module is statically imported, so it lands in the main bundle. Calling this
  also clears any pending loader and flips status to `"loaded"`.
- **`registerFeatureRendererLoader(key, loader)` — LAZY.** For heavy code (large
  WGSL, compute pipelines) that should download on first use. The loader
  dynamic-imports the module and then calls `registerFeatureRenderer` itself;
  until it resolves, `getFeatureRenderer(key)` returns `undefined` and the scene
  falls back to WebGL for a frame or two. The loader fires once (in-flight calls
  coalesced); a failed load is retried on the next access. Current lazy entries:
  Gaussian splat, point cloud, point-cloud EDL, voxel, SSR, NPR outlines, contact
  shadows, weather particles, procedural clouds. **Rule of thumb:** opt-in /
  rarely-used / heavy-WGSL → lazy; always-on / core / tiny → eager.
- **Marker FRs.** Some keys register a **marker** carrying only `name` (optionally
  a `createCommands` alias). The renderer runs elsewhere or doesn't exist yet, but
  the marker lets the scene file use the FR-key check instead of an `isWebGPU`
  branch (e.g. `DEPTH_PLANE`, handled inside `WebGPUSceneRenderer`, not the
  FR-dispatch loop; `CLASSIFICATION_PRIMITIVE`). Use this **only** to retire a
  Principle-2 violation when a full renderer isn't ready — and track the real
  renderer in `DEFERRED_WORK.md` per CLAUDE.md Principle 9.

### 3.4 Registry data model + onboarding checklist

`GraphicsContext` stores three parallel arrays indexed by the numeric key (O(1),
no hashing): `_featureRenderers[key]` (the FR object or `undefined`),
`_featureRendererLoaders[key]` (a lazy `() => Promise<void>`), and
`_featureRendererStatus[key]` (`registered | loading | loaded | failed`). The
enum's `COUNT` pre-sizes these arrays and MUST equal `highest key + 1`.

Adding a new feature renderer (canonical 8-step checklist, from
`FEATURE_RENDERER_ONBOARDING.md`):

1. **Append** a `FeatureRendererKey` enum entry and **bump `COUNT`**
   (append-only — never reorder/renumber; mirrors the `ShaderDefine` rule).
2. Write the renderer module under `packages/engine/Source/Renderer/WebGPU/`
   (RTE precision; TS preferred).
3. Implement only the lifecycle methods you need (§3.1).
4. Register in `registerWebGPUFeatureRenderers` — eager for core/small, lazy for
   heavy/opt-in (§3.3).
5. Consume from Scene via `getFeatureRenderer(key)`; run shared logic **before**
   the branch; WebGL is the fallback. No WebGPU imports, no `isWebGPU` checks.
6. Add a `WEBGPU_COMPAT_EXEMPTIONS` entry **only** if the file is backend-neutral
   (a translator / pluggable registry — not an actual GPU renderer; see §4 and
   `Build`/variant docs). Ordinary feature renderers stay stubbed.
7. Add specs under `packages/engine/Specs/Renderer/WebGPU/`.
8. Update `FEATURE_INVENTORY.md` and (for visible output) verify via a Playwright
   WebGL-vs-WebGPU pixel-diff probe (Principle 8).

See `FEATURE_RENDERER_ONBOARDING.md` for worked examples of each step.

---

## 4. RenderCommand — Backend-Agnostic commandList

`RenderCommand` (`packages/engine/Source/Renderer/WebGPU/RenderCommand.js`)
is a thin command abstraction both backends can interpret, so new Scene features
do **not** have to import either `DrawCommand` (WebGL) or `WebGPUDrawCommand`
(WebGPU) directly. Two execution modes:

1. **Deferred (recommended for new features):** push the `RenderCommand` onto
   the `commandList`. `Scene.executeCommand()` detects `isRenderCommand` and
   delegates to the context's command builder; the built native command is
   cached on `_cachedWebGLCommand` / `_cachedWebGPUCommand` for reuse.
2. **Immediate (for migrating existing code):** call `command.execute(context)`;
   the context builds and executes the native command in one step.

New Scene features SHOULD prefer `RenderCommand` over importing a backend-
specific command class. The file lives under `Renderer/WebGPU/` but is a
backend-neutral abstraction. **Verified at HEAD:** `RenderCommand` is **not** on
the `WEBGPU_COMPAT_EXEMPTIONS` list in `scripts/bundleVariantPlugin.js` — that
list holds only `WebGLCompatibilityStub`, `WebGPUShaderTranslator`,
`WebGLStubPipelineExtractor`, and `WebGPUNagaTranspiler`. In the **webgl-only**
build variant, every file under `Source/Renderer/WebGPU/**` (including
`RenderCommand.js`) is redirected to an empty stub, so a webgl-only bundle does
not import it. This is by design: WebGL Scene paths construct `DrawCommand`
directly and never touch `RenderCommand`; only the dual and webgpu-only builds
exercise the `RenderCommand` deferred/immediate code paths. If a future
backend-neutral consumer needs `RenderCommand` in a webgl-only bundle, add its
path to `WEBGPU_COMPAT_EXEMPTIONS` then (and ensure its runtime paths are safe
without a `GPUDevice`).

---

## 4a. The Frame — WebGPU pass order and dispatch sites

Where a feature renderer runs is decided by the `Pass` slot its commands carry
and by whether the WebGPU frustum loop has a leg for that slot. **A command
binned in a slot with no leg is silently never drawn** — that is the failure
mode `DEBUGGING_GUIDE.md`'s glTF-edge section records, and it is the
completeness criterion a reviewer should apply to any new renderer.

Every line below is anchored to the dispatch site it describes. The obvious
source, `WebGPUSceneRenderer.ts:2-34`, is **stale on ordering and placement**;
prefer these anchors or the code.

### 4a.1 Top-level chain — `WebGPUSceneRenderer.executeCommands`

`WebGPUSceneRenderer.ts:1817-1847`, in order:

1. `opaqueFrustumNearOffset` resolved from the scene (`:1818-1819`, default
   `0.9999`) — biases each non-nearest frustum's opaque near plane.
2. `setupSceneFramebufferRenderPass(this, context, config)` (`:1822`) —
   redirects rendering from the canvas swap chain to the scene framebuffer.
3. `resetPerFrameState(this, context)` (`:1825`).
4. `this._beginDepthPlanePass(config, numFrustums)` (`:1829`). Despite the
   name this opens **no render pass**: it reserves exactly `numFrustums`
   per-frustum uniform slices in the depth plane's allocator before any draw is
   encoded (`:2612-2638`), and returns immediately when `useDepthPlane` is off.
5. `executeFrustumLoop(this, config, opaqueFrustumNearOffset)` (`:1830`) —
   §4a.2.
6. `executePostFrustumChain(this, context, config, frustumCommandsList)`
   (`:1843`), **skipped entirely when `config.deferComposite` is set**
   (`:1840`). That is the first half of the Scene-2D infinite-scroll wrap: the
   half only accumulates draws into the scene framebuffer, the pass it leaves
   open is closed and reopened with `loadOp="load"` by the second half's
   `setupSceneFramebufferRenderPass`, and the second half runs the chain once
   over the fully accumulated framebuffer (`:1835-1839`).

Two things a reader expects here and will not find:

- **Clustered-lighting compute** is dispatched once per frame *before* the
  chain above (`_dispatchClusteredLighting`, `:1796`).
- **Shadow casting is not dispatched from the renderer at all** (`:1798-1815`).
  `SceneRenderer.executeShadowMapCastCommands` is the canonical, backend-neutral
  site and delegates to `context.executeShadowMapCastCommands` before
  `executeCommands` is ever reached; re-dispatching here would collect no
  casters and wipe the depth the canonical dispatch wrote.

### 4a.2 The per-frustum leg — `WebGPUSceneRendererFrustumLoop.ts`

The loop walks the frustum list **far to near** (`i === 0` is the farthest).
Per iteration, in source order:

| Step | Site | Notes |
|---|---|---|
| Per-frustum near/far + `_capturedFrustumRanges` | `:186-216` | SCENE2D uses the camera's full visible range; other modes apply the opaque near offset except on the nearest frustum |
| Depth/stencil clear | `:226-229` | Skipped on all but the first iteration when `debugShowDepthAsColor` is on, so the overlay sees the whole far-to-near range |
| **`Pass.ENVIRONMENT`** | `:232-245` | **Farthest frustum only** (`i === 0`) |
| **`Pass.GLOBE`** | `:249` → `_executeGlobePass` (`WebGPUSceneRenderer.ts:2256-2324`) | |
| Globe-depth copy | `:258-284` | Only when `useGlobeDepthFramebuffer`; ends the scene pass, copies depth, resumes the **scene** pass (not the canvas pass), and publishes `context._globeDepthTexture` / `_globeDepthView` |
| **`Pass.TERRAIN_CLASSIFICATION`** | `:286-292` | |
| Depth-plane render **inside the loop** | `:298-303` | Only under `clearGlobeDepth && !debugShowDepthAsColor`: clear depth/stencil, then `_renderDepthPlane(config, "scene")` when `useDepthPlane`. When `clearGlobeDepth` is false the depth plane instead runs once after the loop (§4a.4) |
| **3D-tile chain** | `:317` → `execute3DTilePasses` | §4a.3. The callback passed at `:317-346` is the depth-update hook that fires between the main tile pass and classification, so classifiers sample tile-augmented depth; under invert classification it publishes the invert framebuffer's depth instead of scene depth |
| **`Pass.VOXELS`** | `:355-376` | Sorted back-to-front, then dispatched. Deliberately **before `Pass.OPAQUE`** so volumetric media are ordered against opaque depth (stated reason at `:351-354`), mirroring WebGL's `performVoxelsPass` (`SceneRenderer.js:797`) ahead of `performPass(Pass.OPAQUE)` (`:799`) |
| Point-cloud EDL preflight | `:388-402` | Bucket-local and fail-open: a pending or failed EDL resource leaves the original command enabled |
| **`Pass.OPAQUE`** | `:405` → `_executeOpaquePass` | |
| Per-frustum EDL composite | `:413-431` | |
| Scene-depth repack | `:442-461` | After OPAQUE, so `pickPosition` / `pickFromRay` read the model rather than the globe behind it. Non-picking frames only |
| **`Pass.CESIUM_3D_TILE_EDGES_DIRECT`** | `:469-475` | After OPAQUE, before GAUSSIAN_SPLATS, matching `performCesium3DTileEdgesDirectPass` (`SceneRenderer.js:802`). Single-target pipeline on the live scene pass — unlike the optionally MRT-redirected `CESIUM_3D_TILE_EDGES` |
| **`Pass.GAUSSIAN_SPLATS`** | `:487-522` | Either staged onto `_deferredOITSplats` for the translucent pass (when the OIT deferral flag, OIT support, `useOIT`, non-picking and a first command with an `_oitPipeline` all hold) or sorted back-to-front and drawn inline |
| Second frustum-uniform refresh | `:526-545` | Uses the exact near for translucent commands, avoiding blend artifacts |
| Refraction-scene capture | `:554` | `KHR_materials_transmission` backdrop; a no-op unless `context._sceneHasTransmission` |
| **`Pass.TRANSLUCENT`** | `:559` → `_executeTranslucentPass` | **The OIT composite lives here**, not in the post-frustum chain — see §4a.5 |
| Translucent-tile-classification depth publication | `:572-636` | Packs post-translucent scene depth for classifiers; non-picking frames with 3D-tile classification commands only |
| Per-frustum pick-depth copy | `:639-653` | `pickDepth.update(context, packedDepthTexture)` |

After the loop, `finalizeWebGPUPointCloudEDLFrame` releases full-resolution EDL
targets when EDL was toggled off or every candidate was culled (`:659-664`).

### 4a.3 The 3D-tile sub-chain — `WebGPUSceneRenderer3DTilePasses.ts`

`execute3DTilePasses` (`:196`) runs, in order:

1. **`Pass.CESIUM_3D_TILE_EDGES`** (`:371` under the edge-MRT redirect, `:399`
   as a plain pass on the scene framebuffer). Edges run **first**, because
   later passes sample the edge textures. When the edge FBO is not allocated or
   there are no edge commands, all three `context._edge*View` slots are nulled
   so a previous frame's views cannot leak into the composite (`:405-412`).
2. **`Pass.CESIUM_3D_TILE`** — `runSceneTileMain` (`:296-335`, dispatch at
   `:313`), or redirected into `InvertClassification.classifiedTexture` when
   the invert redirect is live (`:260-263`).
3. The **`onAfterTileMainPass` hook**, fired only when the main tile bucket was
   non-empty (`:620-622`, `:631-633`).
4. **`Pass.CESIUM_3D_TILE_CLASSIFICATION`** and
   **`Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW`** (`:233-236`, dispatched
   at `:623-625` / `:634-636`). Under the invert redirect the order inverts:
   IGNORE_SHOW runs inside the invert FBO with stencil writes (`:576`), then the
   scene pass is resumed and CLASSIFICATION runs on scene color (`:606-607`).

`Pass.CESIUM_3D_TILE_EDGES_DIRECT` is deliberately **not** run here; its site is
the frustum loop, after OPAQUE (`:414-427`). That comment block is the authority
for the *decision* but not for the *number*: five of its lines still call the
pass "slot 12" (`:415`, `:417`, `:423`, `:425`, `:426`), a name it lost when
`CESIUM_3D_TILE_PLANAR_FILL_ID` took slot 5. It is **slot 13** — see
`Renderer/Pass.js:30` and §4a.5. The stale comments are tracked as an owed engine
fix; read the block for its reasoning, not its slot number.

### 4a.4 The post-frustum chain — `WebGPUSceneRendererPostFrustumChain.ts`

`executePostFrustumChain` (`:73-218`), in order:

1. `_executeOverlayPass` (`:80`) — **`Pass.OVERLAY`, once per frame, nearest
   frustum only** (`WebGPUSceneRenderer.ts:2590-2606`).
2. Depth plane, **only when `!config.clearGlobeDepth`** (`:83-85`) — the
   complement of the in-loop site at `FrustumLoop:301`.
3. MSAA depth resolve into the single-sample `r16float` target read by AO, DoF
   and environmental effects (`:100-105`); inert for single-sample depth.
4. `_executeGBufferProducer` (`:111`) — screen-space normal reconstruction;
   returns immediately unless `frameState.useDeferredLighting`.
5. `_runInvertClassificationComposite` (`:125`).
6. `_runVelocityPass` (`:131`) — collects `cmd.velocityCommand` into the
   `rg16float` motion target TAA reads; queues no work with no velocity commands.
7. `_executeBoundingVolumeDebugPass` (`:136`) — opens no pass unless a command
   carries `debugShowBoundingVolume`.
8. `_ensureSceneColorResolved` (`:143`).
9. `_runPostProcessing` (`:157`).
10. Canvas snapshot copy (`:168-201`), only when
    `hasEnvironmentalEffectDemand` reports a consumer.
11. `_executeEnvironmentalEffects` (`:211`) — after post-processing, so its
    canvas writes composite over the scene blit rather than being overwritten.
12. `context._sceneHasTransmission = false` (`:217`).

### 4a.5 The `Pass` table, re-derived from `Renderer/Pass.js:9-32`

Fifteen slots, `0..14`, plus `NUMBER_OF_PASSES: 15`. Slot numbers below are the
enum's, read at HEAD — do not trust any transcription of them elsewhere.

| Slot | `Pass` constant | WebGPU frustum-loop leg |
|---|---|---|
| 0 | `ENVIRONMENT` | `FrustumLoop:232-245` — farthest frustum only |
| 1 | `COMPUTE` | **None in the frustum loop.** `WebGPUComputeCommand.ts:142` stamps the slot; compute is dispatched outside `executeCommands` (WebGL's counterpart is `SceneRenderer.js:870-881`) |
| 2 | `GLOBE` | `FrustumLoop:249` → `_executeGlobePass` |
| 3 | `TERRAIN_CLASSIFICATION` | `FrustumLoop:286-292` |
| 4 | `CESIUM_3D_TILE_EDGES` | `3DTilePasses:371` (edge MRT) / `:399` (scene FB) |
| 5 | `CESIUM_3D_TILE_PLANAR_FILL_ID` | **None on WebGPU.** The only dispatcher is WebGL's `performPlanarFillIdPass` (`SceneRenderer.js:351-366`, called at `:718`). A command binned here does not draw on WebGPU |
| 6 | `CESIUM_3D_TILE` | `3DTilePasses:313`, or the invert-FBO redirect |
| 7 | `CESIUM_3D_TILE_CLASSIFICATION` | `3DTilePasses:607` / `:623-625` / `:634-636` |
| 8 | `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` | `3DTilePasses:576` (invert FBO) / `:623-625` / `:634-636` |
| 9 | `OPAQUE` | `FrustumLoop:405` |
| 10 | `TRANSLUCENT` | `FrustumLoop:559` — OIT accumulate + composite, or sorted alpha |
| 11 | `VOXELS` | `FrustumLoop:355-376` — **before** `OPAQUE` |
| 12 | `GAUSSIAN_SPLATS` | `FrustumLoop:487-522` |
| 13 | `CESIUM_3D_TILE_EDGES_DIRECT` | `FrustumLoop:469-475` — after `OPAQUE` |
| 14 | `OVERLAY` | **No per-frustum leg by design** — once after the loop, nearest frustum only (`PostFrustumChain:80`) |

**Relative to the OIT composite.** OIT accumulation and
`_oit.executeComposite` both run inside the `Pass.TRANSLUCENT` leg
(`WebGPUSceneRendererTranslucentPass.ts:280-296`): the accumulation pass ends,
scene color is resolved, and the composite writes over it. So every slot below
10 has already drawn when the composite runs; `CESIUM_3D_TILE_EDGES_DIRECT`
(13) and `GAUSSIAN_SPLATS` (12) also precede it in the loop body despite their
higher slot numbers, and only the post-frustum chain (§4a.4) runs after it.

### 4a.6 The WebGL counterpart

`Scene/SceneRenderer.js` `executeCommands` (`:410`) is the same spine with a
different shape: a local `performPass(frustumCommands, passId)` (`:594`) plus
named helpers. Call order inside its frustum loop:
`performCesium3DTileEdgesPass` (`:679`, defined `:301`) → `performPlanarFillIdPass`
(`:718`, defined `:351`) → `Pass.CESIUM_3D_TILE` and the classification passes
(`:734-793`) → `performVoxelsPass` (`:797`, defined `:194`) →
`performPass(Pass.OPAQUE)` (`:799`) → `performCesium3DTileEdgesDirectPass`
(`:802`, defined `:393`) → `performGaussianSplatPass` (`:804`, defined `:208`) →
`performTranslucentPass` (`:811`, defined `:241`) →
`performTranslucent3DTilesClassification` (`:813`, defined `:270`) →
per-frustum pick depth (`:815-823`). `executeComputeCommands` (`:870`) and
`executeOverlayCommands` (`:883`) sit outside the loop, as on WebGPU. Some
in-code comments in the WebGPU files cite older WebGL line numbers; the symbol
names above are stable, the numbers are not.

### 4a.7 `usePostProcess`

`_runPostProcessing` (`PostFrustumChain:157`) is the only path by which WebGPU
reaches the canvas, so `usePostProcess` must stay true on WebGPU. That rule and
its consequences are already documented in `CLAUDE.md` (Playwright/browser
testing) and `FEATURE_GUIDE_AND_DEMOS.md`; they are not restated here.

---

## 5. RTE 64-Bit Precision — CRITICAL

Every rendering path uses **RTE (Relative-To-Eye) emulated 64-bit precision** to
avoid f32 jitter at planetary scale. The rules (from CLAUDE.md, enforced across
all WGSL):

- **Never** put a single `position: vec3<f32>` in a vertex buffer — always
  `positionHigh` + `positionLow`.
- **Never** compute `mvp * vec4(position, 1.0)` — always
  `mvpRelativeToEye * translateRelativeToEye(...)`.
- **Never** add `posHigh + posLow` directly — subtract the camera first.
- Uniform buffers carry `encodedCameraHigh`, `encodedCameraLow`, and
  `mvpRelativeToEye`.

Helper chunks live at
`packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_translateRelativeToEye.wgsl`
and the camera UBO struct at `chunks/structs/CameraUniforms.wgsl`. The RTE
helpers are present across the basic shaders (`BasicColor.wgsl`,
`BasicTextured.wgsl`) and CSM builtins (verified).

### previousViewProjection (DP-H41) — motion-vector field

`previousViewProjection: mat4x4<f32>` is DP-H41 (originally Batch 27; rolled
across classifiers + advanced renderers in **Batch 153**,
`b4a8ebaf6b "DP-H41 prevViewProjection across classifier + advanced renderers"`).
The JS pack writes `UniformState.previousViewProjection` with a column-major
identity fallback on the first frame. TAA, CSM, and motion-vector passes read it
by name via `camera.previousViewProjection`.

**The "at the tail of every `CameraUniforms`" rule is not what HEAD does, and its
disposition is an open maintainer decision — do not follow it as an absolute.**
Measured over `packages/engine/Source/Shaders/WebGPU/**` at HEAD (324 `.wgsl`
files):

- **85** files declare a `struct CameraUniforms`.
- **72** of those declare `previousViewProjection`; **13** do not — including the
  shared `chunks/structs/CameraUniforms.wgsl`, plus `BasicColor.wgsl`,
  `BasicTextured.wgsl`, `FlexibleGeometry.wgsl`, `PBRMetallicRoughness.wgsl`,
  `PhongLighting.wgsl` and the seven `Primitive/Polyline*` shaders.
- Of the 72 that do declare it, **only 15 place it as the struct's final field**.
  **57 carry it mid-struct** — so mid-struct is the majority practice, not an
  exception. `Globe/GlobeTerrain.wgsl:105` is the flagship case: the field sits at
  body line 57 of 242, with the whole atmosphere / cloud-shadow / celestial-water
  tail declared after it.

The rule as written is therefore load-bearing only in the sense that appending a
field would force a mid-struct edit in the 15 files that do honour it. That cost
is exactly what **`AR-D12` (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:496`)**
holds open, three ways: *stand*, *scope to velocity-emitting renderers*, or
*change to "at a fixed offset"*. `AR-067`, `AR-092` and `AR-194` are waiting on
it. `GlobeTerrain.wgsl:105` is recorded in that row as the existing precedent
bearing on the third arm; the 57-of-72 measurement above is the wider version of
the same evidence.

`CLAUDE.md`'s WGSL/RTE section still states the tail rule as an absolute MUST.
Until `AR-D12` is ruled, treat **this** section as the description of HEAD and
`AR-D12` as the authority on where the rule is going. What is *not* in doubt is
the discipline that actually prevents silent corruption — see §5.5.

### 5.1 CSM cascade VPs must be RTE-aware (cast AND receive)

Cascaded Shadow Maps are a direct corollary of the RTE rule above: a cascade
view-projection is just another MVP, so it is subject to the same f32-at-Earth-
radius failure. The CSM renderer applies RTE encoding to cascade VPs on **both**
the cast and receive sides. At Earth radius (FP32 ULP ≈ 0.76 m), reconstructing
`worldPos = positionHigh + positionLow` and multiplying by a world-space cascade
VP quantizes to sub-meter acne on cascade 0 (10 m extent); the cast side had a
matching bug (`ShadowMap.wgsl` multiplies its `lightViewProjection` field by an
RTE-*relative* vector, but a world-space VP was being written into that slot,
producing empty cascade textures).

The fix (Slice 1, Session 33, **shipped**) is the
`applyCameraTranslationToVP(vpWorld, cameraWC) → VP_RTE` helper in
`WebGPUCSMRenderer.ts`, which composes `VP_RTE = VP_world * T(+cameraWC)` in FP64
*before any FP32 storage* (the camera translation cancels cleanly into VP's
translation column). Every cascade carries both `viewProjection` (world-space,
for diagnostics) and `viewProjectionRTE` (the value uploaded to **both** cast +
receive UBOs). Receive shaders feed the RTE-precise camera-relative position
directly (`GlobeTerrain.wgsl` `v_positionRTE`; `PrimitivePhongTexturedColor.wgsl`
reuses the `eyePosition` varying). Result: ~1 m FP32 reconstruction error drops
to sub-micrometer. **All CSM consumers must respect this** — never feed a
world-space cascade VP into a cast or receive UBO.

### 5.2 CSM per-cascade slope-scaled depth bias

A hardcoded depth bias (the original `0.005` placeholder) only works at one
cascade scale — it acnes at near range and peter-pans at far range because the
cascades span tens of meters (cascade 0) to kilometers (cascade 3). CSM ships
(Slice 1, Session 33) a per-cascade slope-scaled bias instead:

```wgsl
let nDotL = clamp(dot(normalize(N), normalize(L)), 0.0, 1.0);
let bias  = max(cascadeMinBias[i], cascadeMaxSlopeBias[i] * (1.0 - nDotL));
let biasedDepth = ndc.z - bias;
```

`CSMParams` carries `cascadeMinBias: vec4<f32>` + `cascadeMaxSlopeBias: vec4<f32>`
(packed per the layout at `WebGPUCSMRenderer.ts:300-305`). Per-cascade constants
scale **linearly with `sphereRadius[i] / sphereRadius[0]`** so the NDC bias
tracks each cascade's orthographic depth range. Base values: `minBias = 5e-5`,
`maxSlopeBias = 5e-4`; cascade 3 (km-scale) scales up proportionally. This is not
optional tuning — it is the principled formulation that makes a single bias work
across all four cascades.

### 5.3 CSM texel-snap stabilization

To kill shadow-texel shimmer under camera motion, the cascade sphere center is
snapped to the shadow-texel grid in **world-grid-locked light space** (Slice 2b,
**shipped**). The `snapToTexelGrid(center, radius, lightDir, resolution, result)`
helper in `WebGPUCSMRenderer.ts` builds a light-space basis that depends **only**
on `lightDir` + a world-up fallback (not on the camera — this is what makes the
grid stable across camera motion), projects the center onto the (side, up) axes,
rounds each coordinate to the nearest multiple of `texelWorld = 2 * radius /
resolution`, then re-expresses the result in world space. The cascade sphere then
drifts only in integer-texel increments regardless of camera position.
Integrated in `computeCascadeVPs` between `_fitBoundingSphere` and
`_computeCascadeVPMatrix`, with a per-call scratch `Float64Array(3)` (no
per-frame allocation). `WebGPUCSMRendererSpec.js` verifies idempotence and that
bounding coverage is preserved; an Earth-scale sanity run confirms two raw
centers offset by 0.1 and 0.2 texel both snap to the *same* world position at
planetary radius.

### 5.4 Ellipsoid-aware RTE — a known correctness gap (deferred)

The RTE producers (`encodedCameraHigh` / `encodedCameraLow` + `mvpRelativeToEye`)
currently assume **WGS84**. For non-Earth bodies (Mars, Moon) and multi-ellipsoid
scenes the camera-encoding and tile-height math use hardcoded Earth radius
constants, so **non-WGS84 tilesets render with position jitter / are positionally
wrong** (verified: no ellipsoid parameter threads through the `encodedCamera*`
path at HEAD). The fix is an **ellipsoid-aware RTE audit** — route the tileset's
ellipsoid (not a hardcoded WGS84) through every `encodedCamera*` /
`mvpRelativeToEye` producer.

This is **deferred, not a regression in working code** (CLAUDE.md Principle 9).
It is the Phase 8a Foundation-layer item that unblocks planet-scale GPU tiling
for other bodies (`PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` §3 "Foundation layer",
item 4; §5 roadmap "Ellipsoid-aware RTE audit + fix"). It is tracked as
**`FEAT-3DT2-03`** in `FEATURE_INVENTORY.md` / `FORK_OVERVIEW` / the parity report
(`partial` — "WGS84 radius constants hardcoded; non-WGS84 tilesets positionally
wrong"); a related shader-side gap is logged as `H-P7` in the
`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16` review (corrected count — six
elevation shaders, not five — at `ARCHITECTURE_REVIEW_2026-09-02.md` §3.12). The
audit + fix are unstarted. Until they land, Mars/Moon tilesets are at risk.

---

## 5.5 Uniform buffers — the WGSL struct and its hand-written packer

This is where a new renderer most often produces garbage instead of an error.
There is **no schema generator**: a `CameraUniforms` struct is declared in WGSL,
in one file, in one language, and a *separate* hand-written JS/TS packer walks a
cursor through a `Float32Array` and has to land on exactly the same offsets. Get
the two out of step and the shader reads a live-looking value from the wrong
lane. Nothing throws.

### The correspondence

Take the globe as the worked example, because it is the one with the discipline
written down:

- **The struct** — `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`, `struct CameraUniforms`
  (242 body lines at HEAD).
- **The declared size** — `WebGPUGlobeSurfaceTypes.ts:183`,
  `export const CAMERA_UNIFORM_FLOATS = 244` (with `CAMERA_UNIFORM_BYTES` derived
  on `:184`). The comment block immediately above it is a running offset ledger:
  it names each tail block and its float offsets — `cloudShadowVP2` 212-227 and
  `cloudShadowCascadeParams` 228-231 (`:170-175`), then `celestialControl`
  232-235, `celestialMoonDirectionAndPhase` 236-239 and `celestialMoonControl`
  240-243 (`:177-182`).
- **The packer** — `WebGPUGlobeSurfaceCameraUB.ts`,
  `createCameraUniformBuffer(...)`, which advances one `offset` cursor field by
  field and finally hands the array to `writeUniformSlice` against the per-frame
  ring allocator (module docstring, `:1-25`).

Note that `CAMERA_UNIFORM_FLOATS` is **per renderer**, not global — three
renderers declare their own, all `44`: `WebGPUComputeInstanceRenderer.ts:204`,
`WebGPUFlowFieldRenderer.ts:64` and `WebGPUOceanRenderer.ts:76`. The name is
shared; the value is not, and nothing links them.

### The rule: append at the tail, bump the count

**Add a new field at the end of the struct and at the end of the packer, then
raise the float count by the new field's float width.** Every offset above is
then unmoved, so every existing consumer is byte-identical. That is stated
in-code at `WebGPUGlobeSurfaceTypes.ts:179-180` for the celestial-water block
("Appended at the tail, so every offset above is unmoved"). The one sanctioned
alternative is **reusing an existing pad word** in place — also offset-preserving,
and taken deliberately at `WebGPUGlobeSurfaceCameraUB.ts:397-401` ("Reusing the
pad rather than appending keeps `CAMERA_UNIFORM_FLOATS` and every tail offset
unchanged"). What is never safe is inserting between two live fields.

**Why a mid-struct insert fails silently:** the packer is a cursor, not a map. It
does not address fields by name — it writes N floats, advances N, writes the
next. Insert a field in the middle of the WGSL struct without inserting the
matching write at the same point in the packer, and every field below the
insertion point is read by the shader from the offset of its predecessor. There
is no name-matching layer to notice, no size change to trip a bounds check
(the buffer is still `CAMERA_UNIFORM_BYTES` long), and the values are plausible
floats rather than zeros or NaNs. You get a wrong render, not a failure. The
same happens in the other direction — a lane added to WGSL with no matching
write leaves the tail reading whatever the previous frame's ring-allocator page
left behind, which the packer's own comment (`WebGPUGlobeSurfaceCameraUB.ts:1126-1130`)
calls out as "a live-looking value rather than a zero".

### The one guard, and why you should copy it

`WebGPUGlobeSurfaceCameraUB.ts:1131-1137` asserts the cursor landed exactly on
the declared size:

```ts
//>>includeStart('debug', pragmas.debug);
if (offset !== CAMERA_UNIFORM_FLOATS) {
  console.error(
    `[CesiumJS:webgpu] Terrain camera UB wrote ${offset} floats, but CameraUniforms declares ${CAMERA_UNIFORM_FLOATS}`,
  );
}
//>>includeEnd('debug');
```

It is debug-only (pragma-stripped in production, per §9) and **globe-only** — it
is the sole such assertion in the tree, against 85 files declaring a
`CameraUniforms` struct. It is pinned by
`Tools/visual-regression/celestial-water-globe-port.spec.mjs:481-498`, which
reads the declared constant out of `WebGPUGlobeSurfaceTypes.ts` and requires the
assertion's shape to still be present, with a 244→232 source mutant at `:2015`;
`globe-contour-pixel-ratio-parity.spec.mjs` and
`eclipse-globe-umbra-rte.spec.mjs` re-read the same constant.

**Generalise it.** Any renderer that hand-packs a `CameraUniforms` (or any other
struct) should declare its own float-count constant beside the struct and end its
packer with the same debug-pragma cursor assertion. It costs nothing in
production and it is the only thing between a mismatched write and a silent
misrender. This is the single most transferable habit in the uniform path, and it
is currently practised in one file out of 85.

### Alignment, matrices, and the allocator — read these, do not re-derive them

Do not reconstruct WGSL layout rules from memory; three LIVE documents already
hold them and are the authorities:

- **Scalar/vector alignment and write widths** (and the silent-miscompare symptom
  this section describes) — the B205-N1 table at
  [`DEV_NOTES_postprocess.md:553-563`](DEV_NOTES_postprocess.md). The trap worth
  memorising from it: `vec3` is 16-byte aligned, so the shader reads it from a
  16-byte slot even though it occupies 12 bytes in the pack.
- **Matrix layout** — [`ARCHITECTURE_REVIEW_2026-09-02.md:203`](ARCHITECTURE_REVIEW_2026-09-02.md)
  (finding `H18`). A `mat2x2<f32>` requires align 8 but is over-aligned to 16 by
  the generic element-count classifier; a `mat3x3<f32>` is three 16-byte-strided
  columns (48 bytes), not 36 contiguous. `Scene/MaterialUniformBuffer.js:60-119`
  gets both wrong today.
- **The per-frame ring allocator** the slices are written into —
  [`RENDERER_LANDSCAPE_AUDIT_2026-09-02.md:908`](RENDERER_LANDSCAPE_AUDIT_2026-09-02.md)
  (census `PC-20`): an N-page ring, 256-byte aligned, per-frame page advance,
  overflow pages and a circuit breaker, flushed with one `queue.writeBuffer` per
  dirty page before submit.

**Forward note.** The reason all of the above is discipline rather than
mechanism is that the schema generator is unbuilt: **`FAR-302` — "One uniform
schema and host-shareable layout generator"**
(`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:624-630`) would define one
typed schema and emit the WGSL declaration, the CPU offsets/strides and the pack
function from a single source, with mat2 alignment and mat3 column stride exact.
It is size L, depends on `FAR-101`, covers audit finding `H18`, and — per
`ARCHITECTURE_REVIEW_2026-09-02.md:203` — has **no row in any queue**. Until it
lands, the cursor assertion above is the whole safety net.

For where `previousViewProjection` sits in all this, and why "at the tail" is an
open question rather than a rule, see §5's `previousViewProjection (DP-H41)`
block and `AR-D12`.

---

## 6. WGSL Shader Pipeline — Defines, Preprocessor, Module Cache

Infrastructure landed Batches 22–27 and has been heavily extended since
(Batches 162–164 widened shader-module-cache adoption; DP-H46b added a content
salt). Do not bypass these when adding shader variants.

### 6.1 The two-word define registry — `WebGPUShaderDefines.ts`

Specialization axes are bits in **two** Uint32 words, `defines` (lo) and
`definesHi` (hi), threaded together through the preprocessor and the module
cache. Both registries are **add-only — never reorder, renumber, or remove an
entry**, even if its last consumer disappears: reordering silently aliases
cached modules across rebuilds; removal breaks any pipeline still referencing
the bit. Deprecated entries stay with a comment marker.

> **Start here if you are adding an axis: the lo word is FULL.** Bits 0-30 are
> all claimed (31 entries, re-measured at HEAD against `: 1 <<` in
> `WebGPUShaderDefines.ts`; the highest is `MODEL_METADATA_MAT_TRANSPORT: 1 << 30`
> at `:863`), and **bit 31 is permanently reserved** — the collections'
> `noDepthTest` pipeline-key fold (`pipelineKeyWithDepthFlag` in
> `WebGPUCollectionRendererBase`) folds a flag into that position, and leaving
> the bit unclaimed is what guarantees a folded key can never alias a real
> define (`WebGPUShaderDefines.ts:22-30`, `:56-60`). **A new axis claims a bit in
> `ShaderDefineHi` instead** — see §6.1.1.
>
> Two earlier statements in this section were wrong and have been removed. There
> are not "30 active bits (`1<<0` … `1<<29`)" — there are 31, through `1<<30`.
> And it was **never** true that "six bits (`1<<24` … `1<<29`) live above the
> module cache's 24-bit define window and MUST be folded via `keySalt`": the
> cache key retains the **complete** 32-bit lo mask (§6.3), so no define bit has
> ever needed a salt. That false MUST contradicted both this document's own
> §6.3.1 and the module docstring at `WebGPUShaderDefines.ts:16-18`, which says
> `keySalt` "remains available only for sources whose WGSL text is generated
> dynamically". Ignore any surviving copy of it.
>
> Lo-word bits at HEAD:
>
> | Bit | Name | Gates |
> |---|---|---|
> | `1<<0` | `GEODETIC_NORMAL` | terrain geodetic normal vs ellipsocentric fallback (DP-H25) |
> | `1<<1` | `DISABLE_DEPTH_DISTANCE` | per-primitive depth-test override (DP-H42) |
> | `1<<2` | `SPLIT_ENABLED` | split-screen discard (DP-H40) |
> | `1<<3` | `COMPRESSED_VERTICES` | GPU oct/bit-pack decode (DP-H19-SHADER-DECODE) |
> | `1<<4` | `DISTANCE_DISPLAY_CONDITION` | distance-gated visibility |
> | `1<<5` | `EYE_DISTANCE_TRANSLUCENCY` | eye-distance translucency ramp |
> | `1<<6` | `EYE_DISTANCE_PIXEL_OFFSET` | eye-distance pixel offset |
> | `1<<7` | `EYE_DISTANCE_SCALING` | eye-distance scaling |
> | `1<<8` | `VS_THREE_POINT_DEPTH_CHECK` | 3-point VS depth check |
> | `1<<9` | `MODEL_HAS_KHR_TEXTURES` | model basic/full KHR texture path (the coarse pipeline-family gate — see §6.4) |
> | `1<<10` | `STOCHASTIC_DITHER_ALPHA` | stochastic alpha dither |
> | `1<<11` | `STENCIL_PICK_WINNER` | stencil pick winner |
> | `1<<12` | `MODEL_HAS_TEXCOORD_1` | model second UV set |
> | `1<<13` | `MODEL_HAS_FEATURE_ID_0` | model feature-ID-0 path |
> | `1<<14` | `MATERIAL_APPLY` | material apply path |
> | `1<<15` | `LOG_DEPTH` | logarithmic depth |
> | `1<<16` | `GLOBE_IMAGERY_REDUCED` | reduced globe imagery |
> | `1<<17` | `CAPTURE_MODE` | scene-capture mode |
> | `1<<18` | `MODEL_HAS_METADATA` | per-model structural-metadata path (DP-H46) |
> | `1<<19` | `MODEL_HAS_PROPERTY_TEXTURES` | model property-texture sampling |
> | `1<<20` | `MODEL_HAS_PROPERTY_TABLES` | model property-table sampling |
> | `1<<21` | `METADATA_PICKING_ENABLED` | metadata pick path |
> | `1<<22` | `POINT_CLOUD_EDL_DEPTH` | point-cloud EDL off-screen depth pipeline (only `WebGPUPointCloudEyeDomeLighting` ORs it in) |
> | `1<<23` | `MODEL_HAS_WGSL_CUSTOM_SHADER` | model user customShader with native `wgslFragmentShaderText` (GLSL-only customShaders keep the warn + no-op path) |
> | `1<<24` | `MODEL_HAS_WGSL_CUSTOM_VERTEX` | model user customShader native WGSL *vertex* body |
> | `1<<25` | `VOXEL_CUSTOM_SHADER_COLOR` | voxel default-shader parity color march (Batch 476; `//>>else` = historical raw-texel accumulation) |
> | `1<<26` | `MODEL_SPLIT_ENABLED` | model split-screen discard (B483) |
> | `1<<27` | `MODEL_HAS_COLOR` | `model.color` tint / blend-mode path (B484) |
> | `1<<28` | `MODEL_SILHOUETTE` | model silhouette stencil two-pass (B485; `ModelSilhouetteStage.wgsl`) |
> | `1<<29` | `VOXEL_USER_CUSTOM_SHADER` | user native-WGSL voxel customShader in the ray-march (B503; generated codegen chunk) |
> | `1<<30` | `MODEL_METADATA_MAT_TRANSPORT` | matrix transport in the generated metadata chunk; consumed by `ModelPBRComplete.wgsl` (`:863`) |
> | `1<<31` | — | **reserved, never claimable** (`pipelineKeyWithDepthFlag` fold) |
>
> The lo registry is contiguous 0-30 with no gaps at HEAD. The add-only rule
> still mandates that if a bit's last consumer disappears the slot is *retained*
> as a gap rather than renumbered. Read the JSDoc in `WebGPUShaderDefines.ts`
> for the exact gate text of any bit before relying on it.

#### 6.1.1 `ShaderDefineHi` — where a new axis goes

Because the lo word is exhausted, **every new specialization axis claims a bit in
the hi-word registry**, `ShaderDefineHi` (`WebGPUShaderDefines.ts:931`). Six
entries at HEAD:

| Hi bit | Name | Gates |
|---|---|---|
| 0 | `HI_WORD_PROBE` | permanently-reserved validation probe; consumed only by `WebGPUShaderDefinesSpec` / `WebGPUShaderPreprocessorHiSpec` / `WebGPUShaderModuleCacheSpec` to exercise the hi-word path end-to-end. No production renderer sets it |
| 1 | `ENHANCED_OCEAN` | globe enhanced-ocean styling in `GlobeTerrain.wgsl`'s `computeEnhancedOcean`; clear (the default) matches WebGL |
| 2 | `SPLAT_PACKED_WASM` | Gaussian-splat attribute-record layout — which record the vertex stage decodes from the `array<u32>` storage binding |
| 3 | `SPLAT_SPHERICAL_HARMONICS` | Gaussian-splat view-dependent colour; the WGSL twin of GLSL's `HAS_SPHERICAL_HARMONICS` |
| 4 | `CLOUD_MARCH_EMIT_RECONSTRUCTION` | cloud march becomes the producer of the reconstruction depth attachment |
| 5 | `CLOUD_RECONSTRUCTION_CONSUME` | `CloudTemporalResolve.wgsl` consumes it — kept a separate axis on purpose so the producer can be A/B'd alone |

Three properties of the hi word that will otherwise surprise you:

- **Bits are claimed through `hiDefineBit(bitIndex)`, not a literal `1 << n`.**
  It rejects anything outside `0..30` with a `RangeError` naming the reserved bit
  (`:910-916`). Hi bit 31 is reserved for the same normalization reason as lo bit
  31: keeping the sign bit of *both* words unclaimed means `mask | 0` /
  `mask >>> 0` can never change which defines a mask names.
- **The two masks are branded and not interchangeable.** `hiDefineBit` returns a
  `ShaderDefineHiMask` (`:882-884`), and lo-word APIs take `ShaderDefineLoMask`,
  so passing a hi bit where a lo mask is expected is a **compile error** rather
  than a silent `defines & BIT === 0` that would quietly emit the `//>>else`
  branch. That silent-wrong-shader failure is the exact mode the brands exist to
  prevent — do not cast around them. **The protection runs one way only.** The
  reverse mistake — a *lo*-word bit passed in a `definesHi` argument — cannot be
  compile-checked, because lo bits are plain numbers and `ShaderDefineLoMask` is
  a flavor every number satisfies. The source says so at
  `WebGPUShaderDefines.ts:893-897`; the only mitigation is that hi-word
  parameters are named `definesHi` everywhere, so the mistake is greppable in
  review rather than caught by the compiler.
- **Flag names must be unique across both tables.** A module-load assertion
  (`:1123-1131`) throws if a name appears in both, because `//>>ifdef NAME`
  would otherwise be ambiguous between a lo test and a hi test.

`ShaderSourceId` (same file, same add-only rules) gives each source file a stable
8-bit numeric identity. **Source ID 0 is reserved.** Re-measured at HEAD:
**42 registrations**, contiguous `1…42`, highest `EDGE_EMITTER: 42`. (An older
reading of "39 registrations, highest `POINT_CLOUD_EDL_BLEND: 39`" is stale.)

**Adding a new specialization axis — the recipe at HEAD:**

1. Append an entry to **`ShaderDefineHi`** via `hiDefineBit(n)` — the next free
   index, never a reorder. (Only touch `ShaderDefine` if you are documenting an
   existing lo bit; there is no free one.)
2. Document in the JSDoc what it gates and which shaders consume it, including
   what the `//>>else` branch does.
3. Add the `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` block to each
   consuming shader, keeping `//>>else` as the historical path.
4. Thread the mask through **both** call sites: `preprocess(source, defines,
   definesHi)` and `getOrCreate(sourceId, source, defines, label, keySalt,
   definesHi)`. Passing the hi mask in the `defines` position is a compile error,
   and omitting it entirely resolves your `//>>ifdef` to the `//>>else` branch
   with no diagnostic — that is the failure to watch for.
5. *(Optional, defense in depth.)* Add a marker for the axis to the pipeline
   descriptor's `name`. Not required for correctness — see §6.3.

### 6.2 `//>>ifdef` preprocessor — `WebGPUShaderPreprocessor.ts`

A pure function of **three** arguments —
`preprocess(source: string, defines: ShaderDefineLoMask, definesHi = 0): string`
(`WebGPUShaderPreprocessor.ts:94-98`). Directives
`//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` sit on their own lines; flag
names must be `UPPERCASE_WITH_UNDERSCORES` and resolve to a bit in **either**
registry — a lo-word name tests `defines`, a hi-word name tests `definesHi`,
and the module-load uniqueness assertion (§6.1.1) is what keeps that
unambiguous. A flag registered in **neither** word **throws at preprocess time
with the source line number**, as do unbalanced directives and a duplicate
`//>>else` in one block — typos fail loudly. `defines=0, definesHi=0` emits
every block's `//>>else` branch and is byte-identical to a shader with no ifdef
blocks (the safe migration default).

### 6.3 Shader module cache — `WebGPUShaderModuleCache.ts`

Two-tier model:

- **Tier 1 — module dedupe (this class).** One cache per `GPUDevice`, cleared on
  device loss. The common-path key is the exact safe integer
  `((defines >>> 0) * 0x100) + sourceId`: eight low bits identify the validated
  source ID and all 32 high bits retain the complete lo-word define mask. The
  maximum key is `2^40 - 1`, inside JavaScript's exact 53-bit integer range, so
  ordinary lookups remain allocation-free numeric `Map` operations **without
  high-define aliasing** — every lo bit, 0 through 31, participates in the key
  directly.
- **The hi word is a second map level, not part of that integer.** `_modules` is
  the `definesHi === 0` level; a lazily-created `_modulesByHi` keyed on the hi
  word holds everything else (`WebGPUShaderModuleCache.ts:180-190`). Keeping
  hi=0 as its own field is what keeps the hot path at one integer compare plus a
  single `Map.get`; hi-word variants cost two.
- **Tier 2 — per-renderer pipeline cache** (`_pipelineCache` /
  `_wireframePipelineCache` / `_debugFragmentPipelineCache` on each renderer),
  keyed with the defines bitmask as a `|0xNN` suffix.

Entry point (`WebGPUShaderModuleCache.ts:232-239`):

```ts
getOrCreate(
  sourceId: number,
  source: string,
  defines: ShaderDefineLoMask,
  label: string,
  keySalt = 0,
  definesHi: number = 0,
): GPUShaderModule
```

On a miss it `preprocess`es the source against **both** masks and compiles the
module. `defines` is typed `ShaderDefineLoMask`, so passing a branded
`ShaderDefineHiMask` in that position is a compile error (§6.1.1). `sourceId`
must be an integer in `0..255`; `definesHi` accepts only `0..0x7fffffff`,
because hi bit 31 is reserved.

**DP-H46b `keySalt` (Batch 455).** When a caller passes a non-zero `keySalt` (a
per-source *content* fingerprint, e.g. the hash of a generated `struct Metadata`
chunk), the cache key becomes the **string** `"<numericKey>#<salt>"` so two
callers that share `(sourceId, defines)` but supply **different source content**
don't alias one compiled module. `keySalt === 0` (the default) keeps the
allocation-free numeric path. The map type is
`Map<number | string, GPUShaderModule>`.
(Shipped `3b146e42a8 "Batch 455: DP-H46b — per-model WGSL metadata codegen"`;
consumed by `WebGPUModelPipelineCache.ts`.)

#### 6.3.1 `keySalt` is generated-source identity, never define overflow

All 32 lo-word define bits participate directly in the numeric key, including
bits 24-31, and the hi word is a separate map level. **No define bit has ever
needed a `keySalt`.** Pass a non-zero salt only when the WGSL source *text* can
change while `(sourceId, defines, definesHi)` stays the same — model metadata or
user custom-shader code generation are the shipped cases — in which case the key
becomes the string `"<numericKey>#<salt>"`. The salt is a stable content
fingerprint; it must not substitute for declaring a real variant bit. This is
what `WebGPUShaderDefines.ts:16-18` states, and it is the paragraph that any
surviving "bits above 23 MUST be salted" claim contradicts.

`getOrCreate` rejects source IDs outside `0..255` and define values outside the
signed-or-unsigned Uint32 domain. Signed and unsigned representations of the
same mask normalize to one key. These guards turn registry overflow and invalid
call-site identity into deterministic failures instead of wrong-but-valid
shader reuse.

**Prewarm.** Renderers call
`prewarm(sourceId, source, defineSets, labelPrefix)` at the end of their
device-init to compile the variants their first ~30 frames are known to touch,
moving 10–20 ms of shader compile off the render path. The list is each
renderer's own responsibility — no central heuristic. `prewarm` auto-includes
the defines bitmask hex in the devtools label.

### 6.4 glTF model shader-variant strategy — planned ~20-family table vs shipped binary split

The Phase 8 shader strategy (decided Batch 80, `PHASE_8_SHADER_STRATEGY.md`)
proposed a **~20 material-family pipeline table** keyed on
`{material family} × alphaMode × doubleSided`, with one pipeline per BRDF
(MR / SG / clearcoat / sheen / anisotropy / transmission) plus a tileset-manifest
pre-warm. **Implementation diverged.** What actually shipped (Batches 162/174+)
is a **binary basic/full split** keyed on a single `ShaderDefine` bit —
`MODEL_HAS_KHR_TEXTURES (1<<9)`, selected per-primitive by
`computeMaterialDefines()` in `WebGPUModelRenderer.js` — *not* a per-family table:

- **full** (`MODEL_HAS_KHR_TEXTURES` set) declares all 14 KHR texture/sampler
  slots and pairs with the 37-binding `materialBGL`; **basic** is the lean path.
- The KHR BRDFs (`clearcoat`, `sheen`, `anisotropy`, `iridescence`,
  `transmission`, `volume`, `KHR_materials_specular`, plus `KHR_texture_transform`)
  are **wired inside the full variant**, each gated by a `FLAG_HAS_*` material
  flag in `ModelPBRComplete.wgsl` — no longer "silently dropped" on the WebGPU
  path (the pre-Batch-174 state). `alphaMode`/`doubleSided` stay in the
  GPU-state cache key (`WebGPUModelPipelineCache.computeKey`,
  `alphaMode | (doubleSided ? 4 : 0) | (materialDefines << 3)`).

The per-family table + per-extension `ShaderDefine` bits remain a **documented
future refinement** (`computeMaterialDefines` JSDoc notes the architecture
supports a granular per-KHR-extension split without further refactoring; the
tileset pre-warm hook is not yet wired). Treat the historical "3-bit key / at
most 6 variants" framing as superseded. See `PHASE_8_SHADER_STRATEGY.md`
"What actually shipped" for the full reconciliation with code line refs.

### 6.5 The cache map — eleven caches, what each keys on, and how to read it

A new renderer that allocates GPU objects per frame is the most common
performance defect in this codebase — it is the shape Batch 717 root-caused, and
the shape `DEBUGGING_GUIDE.md`'s bind-group-churn entry diagnoses *after* it
ships. The prevention is knowing which cache already exists. Eleven do
(`packages/engine/Source/Renderer/WebGPU/*Cache*.{ts,js}`); **never call
`device.createRenderPipeline`, `createComputePipeline`, `createShaderModule` or
`createBindGroup` directly on a hot path.**

| Cache | Keyed on | Reach for it when | Read it with |
|---|---|---|---|
| `WebGPURenderPipelineCache` | `generateCacheKey`: shader-module identity (`sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>` via a `WeakMap`) + `pl:` layout + `pr:` primitive + `dz:` depth/stencil + `mx:` multisample — every field forwarded to `createRenderPipeline` | any render pipeline, always | `CesiumDebug.cacheStats()` → the `renderPipeline` row (`hits`, `misses`, `hitRate`, `size`, `evicted`, and **`wrongModuleHits`, which must read 0** — a nonzero value is a key collision and `cacheStats()` logs a `console.error`) |
| `WebGPUComputePipelineCache` | `(descriptor.name, layout signature, compute.entryPoint)` plus `compute.module` identity (`m:`) — a much narrower surface than render pipelines (no fragment targets, vertex layout, multisample or depth-stencil) | any compute dispatch | no CesiumDebug command; `getStats()` on `context._webgpuComputePipelineCache` |
| `WebGPUShaderModuleCache` | `(sourceId, defines, definesHi, keySalt)` over a two-level map — see §6.3 | every `createShaderModule`; `prewarm()` at renderer init for hot variants | `CesiumDebug.context.getRendererStatistics().shaderModuleCache` (a per-device compile census; no command prints it) |
| **`WebGPUBindGroupCache`** | composite identity of `layout` + each `entry.resource`, via a per-cache WeakMap identity map; bounded LRU with optional age eviction so identity churn cannot grow it unboundedly (Batch 293) | **any `createBindGroup` on a per-frame path** — this is the answer to "how do I avoid allocating a bind group every frame" | `CesiumDebug.cacheStats()` → the `bindGroups:<name>` rows. At HEAD the context publishes three: `bloom`, `ambientOcclusion`, `autoExposure` (`WebGPUContext.ts:7041-7047`). A near-zero hit rate means a key input is changing between lookups — usually a per-frame wrapper object used where a stable underlying resource was needed |
| `WebGPUGlobeBindGroupCache` | per-group resource-identity tuples: group 0 = ring-page identity, group 1 = 16 imagery view ids, group 2 = waterMask/ocean/material ids; `EVICT_AFTER_FRAMES = 600` (`:107`) | globe tile commands — already wired; took steady-state tile bind-group creation from 68/frame to 0 (Batch 241) | `CesiumDebug.globeBindGroups()` (reads `globalThis.__webgpuGlobeBindGroupCache`), including a per-group `byGroup` breakdown |
| `WebGPUModelPipelineCache` | glTF model pipeline variants: alpha mode (OPAQUE/MASK/BLEND) × cull mode × presentation format, over four consolidated bind-group layouts | glTF model rendering — already wired | no cache counters; the module's debug surface is model **pick** emission, at `getRendererStatistics().modelPick` |
| `WebGPUResourceCacheRegistry` | not a lookup cache — a registry of `() => void` clear callbacks, each run in its own try/catch | **register your new cache's `clear()` here at context init** so device-loss recovery drops its stale GPU handles | none (dispatcher only; `clearAll()` on the recovery path) |
| `WebGPUEffectsStateCache` | `(groupKey, uniformBits)` — slot reuse for bindings whose GPU resource tuple is stable while uniform bytes change with the camera; bounded at `maxGroups: 256`, old slots rewritten rather than minting camera-position keys | an effects binding whose resources are fixed but whose uniform payload moves every frame | **no `CesiumDebug` command, but the cache self-reports.** In a debug build `createEffectsBindGroup` calls `getDiagnostics(bytesPerSlot)` (`:172-188`) on a ~3 s throttle and logs `N groups / N slots, N hits / N misses (X% hit), N writes / N skipped` (`WebGPUEffectsBindGroup.js:1850-1872`, inside `//>>includeStart('debug')`, so it costs nothing in release). Watch that hit rate first. A per-device aggregator summing every context's cache also exists — `getEffectsCacheDiagnostics()` (`:2061-2095`, exported both ways) — but nothing calls it at HEAD, so the specs (`WebGPUEffectsStateCacheSpec.js`, `WebGPUEffectsDeviceCacheSpec.js`) are its only readers |
| `WebGPUModelMetadataCache` | `WeakMap` by model → primitive → runtime node, plus a metadata revision; memoizes structural metadata packing **and** the generated WGSL together | model metadata codegen — source-generation work that must not run per frame | **no live surface** — `getWebGPUModelMetadataCacheDiagnostics()` (`:895`) is read only by `WebGPUModelMetadataCacheSpec.js` |
| `WebGPUCloudShadowBindGroupCache` | four fixed cascade slots, each holding one exact resource tuple (layout, cloud UB, weather/shape/detail views, samplers, shadow UB + offset + size) | procedural-cloud shadow cascades (`WebGPUProceduralCloudRenderer.ts:765`) | none — a plain 4-slot array, no counters |
| `WebGPUShadowCastBindGroupCache` | nested `WeakMap` layers — stable host → device → layout → each bound GPU resource — so a stable model primitive cannot retain obsolete tuples across device recovery; binding numbers use ordinary `Map`s because they are primitives | shadow-map and CSM cast bind groups (`WebGPUShadowMapRenderer.js:20`, `WebGPUCSMCastPass.ts:39`) | none |

**Not in this map: `WebGPUShaderCache`.** The file exists, but the context's field
is `private _webgpuShaderCache: WebGPUShaderCache | null = null`
(`WebGPUContext.ts:673`) and is **never assigned** — the only other reference is
the device-loss clear callback at `:7646`, which optional-chains through the
permanent `null`. It is declared, never instantiated. Listing it would import a
new staleness; its disposition is already recorded in `DEFERRED_WORK.md`. Use
`WebGPUShaderModuleCache` instead.

**Two habits worth taking from the table.** First, four of the eleven caches keep
counters that nothing reads at runtime — if you add a cache, publish its stats
through `getRendererStatistics()` so `CesiumDebug` can reach them, or the cache
is unfalsifiable in the field. Second, every cache that holds GPU handles must
register a clear callback with `WebGPUResourceCacheRegistry`, or device-loss
recovery will hand it back stale handles.

---

## 7. Monorepo File-Placement Rules

CesiumJS uses an npm-workspaces monorepo. **Root `Source/` is a build output,
not the source of truth.**

| Content Type | Canonical (edit HERE) | Build output (DO NOT edit) |
|---|---|---|
| Engine code | `packages/engine/Source/` | `Source/` |
| WGSL shaders | `packages/engine/Source/Shaders/WebGPU/` | `Source/Shaders/WebGPU/` |
| GLSL shaders | `packages/engine/Source/Shaders/` | `Source/Shaders/` |
| Widget code | `packages/widgets/Source/` | `Source/Widgets/` |

- **Always** create new files under `packages/engine/Source/`.
- **Never** create or edit files directly in root `Source/`.

All WebGPU renderer code lives in `packages/engine/Source/Renderer/WebGPU/`
(100+ files); all WGSL shaders in `packages/engine/Source/Shaders/WebGPU/`.

---

## 8. Decomposition State

CLAUDE.md sets a **<1000-LOC per file** decomposition goal (math/enum/pure-data
files exempt). The picture at HEAD (re-measured — **the source decomposition plan
is stale and undercounts**):

> **Strategy framing (decomposition plan, Batch 127).** The <1000-LOC threshold
> is a standing **design target**, deliberately positioned *upstream of*
> greenfield-feature work: a file that has re-grown past the line is a signal to
> extract before piling on, not a hard blocker. Extractions are **staged
> mechanical-candidates-first** — the self-contained helpers (limits init,
> device-loss bus, frame statistics, post-process pipeline, pick pass) come out
> before the harder residual orchestration, because each mechanical move is a
> clean one-batch change that bisects trivially. Both `WebGPUContext` and
> `WebGPUSceneRenderer` re-grew despite their extractions (§8.1) — feature growth
> outruns decomposition — so the residual orchestration extraction is the
> genuinely-unfinished work, not the mechanical candidates.

### 8.1 The core files have continued to GROW

| File | Plan (Batch 185) | **HEAD (re-measured)** | Trend |
|---|---|---|---|
| `WebGPUContext.ts` | 5178 | **5512** | still growing |
| `WebGPUSceneRenderer.ts` | 4016 | **4063** | ~flat |
| `WebGPUGlobeSurfaceRenderer.ts` | 3933 (audit) | **2212** | **shrank** (further split, see §8.3) |
| `GraphicsContext.ts` | 1783 (audit) | **2001** | grew |

Feature growth is still outrunning decomposition on the two biggest files. As
the decomposition plan put it: the mechanical "extract a self-contained helper"
candidates are all DONE, but the residual `WebGPUSceneRenderer` *pass family*
(model / primitive / classification / edge orchestration) resists that pattern
because each pass reaches back into renderer state (encoder, frustum index,
clear/load policy). That is the genuinely-unfinished residual.

### 8.2 Extracted helper modules (all verified on disk)

**`WebGPUContext` helpers (decomposition candidates #1–#6 — all DONE):**
`WebGPUContextLimitsInit.ts`, `WebGPUContextWebGLStubInit.ts`,
`WebGPUDeviceInvalidationBus.ts`, `WebGPUResourceCacheRegistry.ts`,
`WebGPUFeatureFlags.ts`, `WebGPUFrameStatistics.ts`, plus
`WebGPUContextDeviceLoss.ts` and the 331-LOC `WebGPUDeviceLossRecovery.ts`
(exemplary single-responsibility module; 3-state machine
`HEALTHY/RECOVERING/FATAL` with exponential backoff).

**`WebGPUSceneRenderer` slices (11 companion files):**
`WebGPUSceneRenderer3DTilePasses`, `…ClusteredLighting`, `…EnsureResources`,
`…EnvironmentalEffects`, `…FrameReset`, `…FrustumLoop`, `…GlobePass`,
`…PassRedirect`, `…PickPass`, `…PostFrustumChain`, `…TranslucentPass`, plus
`WebGPUPostProcessPipeline.ts` (1780 LOC). Despite all of these, the core is
still 4063 LOC — the pass-orchestration residual is the reason.

### 8.3 GlobeSurface decomposition (newer than the plan)

`WebGPUGlobeSurfaceRenderer.ts` dropped from 3933 → **2212** by splitting into
nine companion files: `WebGPUGlobeSurfaceCameraUB`, `…Layouts`, `…Pipelines`,
`…Shaders`, `…Textures`, `…TileBuffers`, `…TileUB`, `…Types`, `…Wireframe`.
This split is **not** captured in the source decomposition plan — re-verified
from the live tree.

### 8.4 Current files over 1000 lines (re-measured at HEAD)

The audit reported 18 such files; the count and the offenders have shifted.
Largest WebGPU-directory files now (LOC):

`WebGPUContext.ts` 5512 · `WebGPUPrimitiveCommands.js` 4820 ·
`WebGPUModelRenderer.js` 4461 · `WebGPUSceneRenderer.ts` 4063 ·
`WebGPUGroundPolylineRenderer.js` 3208 · `WebGPUGroundPrimitiveRenderer.js` 2860 ·
`WebGPUModelPipelineCache.js` 2763 · `WebGPUPointCloudRenderer.ts` 2265 ·
`WebGPUProceduralCloudRenderer.ts` 2229 · `WebGPUGlobeSurfaceRenderer.ts` 2212 ·
`WebGPUPolylineRenderer.js` 1979 · … (~25+ files >1000 total).

**Takeaway:** the <1000-LOC goal is aspirational for the renderer leaves; the
*structural* health (abstraction layering, FR registry, device pool, format-
generation invalidation) is sound. Scale-of-file is the residual maintainability
risk, not architecture. Extraction strategy (from the plan): one self-contained
move per batch → one-line delegation at the original site → `tsc --noEmit` +
`gulp build` + a visual-regression smoke test → commit as its own batch so any
regression bisects cleanly. **Never** do a mega-PR decomposition.

> **Note for §8.x consumers:** treat all line counts as `status: as-of-HEAD`
> — they drift every batch. Re-run `wc -l` before citing a specific number.

---

## 9. Logging & Debug Pragmas + Permanent Sentinels

CesiumJS strips debug-only code from production builds at **zero runtime cost**.
The fork's `stripPragmaPlugin` (in `scripts/build.js`) handles both `.js` and
`.ts`, so WebGPU TypeScript diagnostics use the same pattern as upstream JS.

### Wrap with pragmas (debug-stripped) when the log is:

- per-frame / per-tile diagnostic (UV uniforms, pass counts, center3D),
- init-time informational (feature detection, resource-creation success),
- any informational `console.log` / `console.warn` that aids debugging but is
  not a real error,
- **any** log doing runtime work (`.toFixed()`, string interpolation, object
  stringification) even if the user never opens the console.

```javascript
//>>includeStart('debug', pragmas.debug);
console.log(`[WebGPU:GlobeTile] center3D: (${center.x.toFixed(1)}, ...)`);
//>>includeEnd('debug');
```

### Keep PERMANENT (no pragma) when the log is:

- a `console.error` for a real bug producing broken output (null blit target,
  index/vertex overflow, command-buffer invalidation, device lost),
- a shader-compile or pipeline-creation failure,
- a recovery/retry-exhaustion failure,
- an infinite-loop sentinel (clear-loop detector, re-entry guard).

Real errors must always reach the console — that is how production bugs get
reported. Audit confirms compliance is genuine: ~67 pragma-wrapped sites across
58 files; real-error `console.error` sites are intentionally permanent.

### Pragma-aware predicate helpers

When a diagnostic fires from many call sites, put the throttle in a predicate
whose body is pragma-stripped — it returns `false` in production and the call
sites become dead code esbuild removes:

```typescript
private _diagShouldLog(): boolean {
  //>>includeStart('debug', pragmas.debug);
  if (this._diagTileCount !== 0) return false;
  const now = performance.now();
  if (now - this._diagLastLogTime < 3000) return false;
  this._diagLastLogTime = now;
  return true;
  //>>includeEnd('debug');
  return false;
}
```

### Permanent sentinels every new subsystem SHOULD add

1. **Re-entry / infinite-loop guard** — a counter in the per-frame entry point;
   throttled `console.error` past a sane limit.
2. **Null-target guard** — check source/destination texture views at render-pass
   boundaries; `console.error` if null.
3. **Size validation** — check buffer sizes vs index/vertex counts before
   submitting draws; `console.error` on overflow and clamp to a safe value.

These catch the BUG-12 (clear loop) / BUG-13 (null PP views) / BUG-15 (index
overflow) failure classes without deep debugging.

> **Known per-instance-latch caveat** (audit §1): diagnostic latches
> (`_execDebugLogged`, `_globePassRPLogged`, `_diagTileCount`,
> `_postInitDebugLogged`, …) are correct individually and pragma-stripped from
> prod, but collectively add un-reset state that raises code-reading cost. A
> unified `LogThrottle` helper was a recommended consolidation. **Verified at
> HEAD: NOT SHIPPED** — no `LogThrottle` exists in the codebase; the individual
> latches remain scattered across `Renderer/WebGPU/`. This is **low-priority
> cleanup, not a bug**: the ~67 pragma-wrapped sites work correctly and are
> already stripped from production builds, so the consolidation would be a
> readability convenience. Defer until a maintainer judges the cognitive load
> high enough to warrant it.

---

## 10. Toward GPU-Resident Tiling (Phase 8b Design)

This is **forward-looking architecture**, not yet built — but it is the frame the
3D Tiles renderer is heading toward, so it belongs in the architecture reference.
Full design + dependency DAG: `migration_doc/PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`
(supersedes the Phase 7 backlog prioritization).

### 10.1 The central insight

> **The destination is a GPU-resident octree of tiles where the per-frame CPU
> cost is O(camera-delta), not O(visible-tiles).**

3D Tiles' primary data property is that **tile content is mostly static across
frames; the camera moves.** The right abstraction is therefore a persistent
GPU-side tile cache (**`TileStoreGPU`**) where the CPU's only per-frame job is
deciding "which tiles, which LOD" — culling, styling, draw-command building,
per-feature coloring, and occlusion all run on the GPU against durable buffers.
This is Unreal Nanite / Unity GPU-Resident-Drawer paradigm adapted for planetary
scale; 3D Tiles is *structurally* favorable to it (stable octree keys, rare
mutation, fixed per-tile schema, hot/cold property split, explicit streaming
lifecycle — games get none of these reliably).

### 10.2 Three independent audits, one conclusion

Three parallel investigations converged on the same architecture from different
angles:

1. **Agent 1** (feature survey) flagged the **normal G-buffer + depth prepass**
   as the single highest-leverage infra gap (unblocks GTAO, SSR quality, contact
   shadows, planar reflections, motion blur, SSGI).
2. **Agent 2** (3D Tiles implementation audit) flagged the **MegaBuffer +
   Resident Drawer + sharedSourceBuffer** stack as the top bottleneck — today's
   path allocates per-tile and emits 1k–10k draw calls/frame with no cross-frame
   persistence.
3. **Agent 3** (3D Tiles 2.0 spec research) flagged the **WGSL styling-expression
   compiler + property-texture sampling + ellipsoid-aware RTE** (§5.4) as the
   spec-level gaps — tile metadata is evaluated CPU-side every frame and
   re-uploaded on every style change.

All three are facets of the **same** persistent-GPU-tile-cache architecture.

### 10.3 Phase 8b is ONE storage layer, not six features

The six Phase-8b items are **not** independent — assembled, they form a single
data-oriented `TileStoreGPU` storage layer (SoA per-tile arrays + content-
addressable mega-buffers + a feature-style buffer) with Cesium API facades on
top. Treating them as six isolated features under-counts the compounding benefit
and over-counts the per-item effort (most plumbing is shared):

| Phase 8b item | Role in `TileStoreGPU` |
|---|---|
| MegaBuffer mesh atlas (`firstIndex`/`baseVertex`) | `vertexMegaBuffer` + `indexMegaBuffer` + `tileMeshRefs` (one VB/IB for many meshes; one indirect draw) |
| Resident Drawer / persistent instance table | the per-tile SoA arrays themselves (`tileTransforms`, `tileBoundingSpheres`, …) living across frames |
| sharedSourceBuffer compute-cull fanout | one visibility stream fanned out to color / CSM-cascade / TAA-history / depth-prepass / shadow-caster passes |
| dynamic-offset UBO + indirect dispatch | the orchestration pattern binding per-material-family UBOs by offset |
| WGSL styling-expression compiler | compute pass writing `featureStyleOutput` from a compiled style expression against `featureProperties` (the biggest 3D-Tiles perf lever) |
| property-texture + feature-ID WGSL audit | the draw-path side — sample per-feature properties, not just feature IDs |

### 10.4 The per-frame CPU collapse

For ~10,000 tiles in a planetary view, the per-frame CPU work goes from O(visible-
tiles) to O(camera-delta):

- **Today:** walk the tile tree; per tile compute SSE + frustum + fog; per
  primitive allocate a `DrawCommand`; per command write a UBO slot; `sort` the
  command list by eye distance; issue 1k–10k draws; on style change walk every
  feature on CPU and re-upload the batch texture.
- **After Phase 8b:** (1) one small camera-UBO write; (2) traversal emits one
  `Uint32Array visibleTileIDs`; (3) one compute dispatch culls + builds indirect
  draws; (4) submit indirect draws. **No per-tile `DrawCommand` objects, no
  per-tile per-frame uniform writes, no CPU command-sort, no CPU style
  re-evaluation.**

**Status:** the Phase 8a foundation is largely shipped (the glTF shader-variant
strategy landed — see §6.4); the Phase 8b GPU-resident stack (`TileStoreGPU`,
MegaBuffer, Resident Drawer, sharedSourceBuffer fanout, WGSL styling compiler) is
**genuinely unbuilt**. §3.5 of the design doc remains the live blueprint.

---

## 11. PostProcessStageLibrary Named-Stage Interception (B486)

`PostProcessStageLibrary` builds its stages from **GLSL** fragment shaders, so
on the WebGPU backend a
`scene.postProcessStages.add(PostProcessStageLibrary.createBlackAndWhiteStage())`
used to hit the GLSL-drop warning and silently no-op. Rather than transpiling
GLSL at runtime, the fork ships an **interception registry**
(`packages/engine/Source/Renderer/WebGPU/WebGPULibraryPostProcessStage.ts`,
Batch 486): when the post-process configure pass scans the user-stage list, a
stage whose well-known `czm_*` name matches the registry is substituted with
its pre-translated **WGSL twin** from `Shaders/WebGPU/PostProcess/`. The
stage's WebGL uniforms are mapped 1:1 onto the twin's UBO each frame, and its
`enabled` flag is honored live.

The pattern's pieces:

- **Name → key mapping.** `getLibraryStageKey(name)` maps `czm_black_and_white
  → blackAndWhite`, `czm_brightness`, `czm_night_vision`, `czm_depth_view`,
  `czm_lens_flare`, `czm_edge_detection_<guid>` (prefix match — the library
  appends a GUID so multiple can be added), and `czm_silhouette` (a two-pass
  EdgeDetection + Silhouette composite). Unmatched names return `null` and
  keep the existing GLSL-drop behavior.
- **Default OFF.** Nothing constructs these stages unless the user adds a
  matching library stage — untouched scenes are byte-identical (the B486
  off-gate; re-verified byte-identical in the 2026-07 campaign audit).
- **Documented per-stage parity gaps** (in the module docstring, not silent):
  LensFlare lacks the `dirtTexture`/`starTexture` overlays + sun gating;
  EdgeDetection/Silhouette lack the `selected` feature mask; DepthView shows
  conventional device depth rather than reversed log-depth gray levels.

This is the template for future library built-ins: pre-translated WGSL twin +
registry row + per-frame uniform sync, never runtime GLSL translation.

### 11.1 The shipped stage ordering (matches WebGL) — with one HDR caveat

`WebGPUPostProcessPipeline.execute()` runs, in source order:

1. `_tonemapStage` (`:1746`)
2. `_userStages` — `addUserStage(...)` WGSL stages (`:1764`)
3. `_libraryStages` — the intercepted `PostProcessStageLibrary` twins (`:1782`)
4. ColorGrading → custom stages → FXAA, as one single-pass chain
   (`:1802-1830`), then the final identity blit to the canvas

**This matches WebGL.** `Scene/PostProcessStageCollection.js:745-753` executes
the tonemapping stage first and then seeds the added-stage chain from
`getOutputTextureFromStage(tonemapping)` — so stages added through
`scene.postProcessStages.add(...)` see tonemapped SDR output on both backends,
ahead of FXAA.

**Historical note — this section previously said the opposite.** It declared an
OPEN "pre-tonemap ordering divergence", cited execute-order line numbers that no
longer exist, and branded the in-code comments **inaccurate**. Re-verified at
HEAD: the ordering above is what ships, and the impugned comments are **correct**
— `WebGPUPostProcessPipeline.ts:1758-1763` (the 4.1 user-stage block) and
`:1775-1781` (the 4.2 library block) each state the post-tonemap, pre-FXAA slot
and name the WebGL insertion point they match, as does the module docstring at
`:29-38`. Those docstrings are the most reliable layer in this corpus; treat a
document that contradicts one as the stale party until proven otherwise.

**The one caveat that survives, and it is not a divergence.** Under an **HDR
canvas** the tonemap stage is bypassed, so the user and library stages receive
linear HDR rather than SDR. That mode has **no WebGL counterpart** — WebGL never
presents an HDR canvas — so it cannot diverge from WebGL; it is simply a WebGPU
path in which an SDR-calibrated stage may misbehave on unbounded input.
ColorGrading and FXAA handle this through the `hdrMode` uniform that
`setHDROutputMode()` flips (`:1795-1801`); the user and library stages have no
equivalent. The caveat is stated in the code itself at `:33-35`.

TAA's pre-tonemap placement is separate and *correct by design* (Batch 290
reconciliation — TAA does its own reversible tonemap-weighting), for the reason
given in the docstring at `:18-28`: the inverse tonemap weight `c/(1-luma)` is
well defined only for linear input, and resolving after the tonemap would also
double-apply a tone curve and clamp highlights in the history buffer.

---

## 12. Voxel Data-Path Architecture (as shipped, Batches 476–503)

The WebGPU voxel renderer (`WebGPUVoxelRenderer.ts`) ray-marches a 3D texture
through a proxy bounding box (RTE-positioned, §5). The data path from provider
to picked cell is now a five-stage chain:

1. **Upload state machine** (`WebGPUVoxelDataUpload.ts`,
   PARITY-VOXEL-MEGATEXTURE-UPLOAD). A per-primitive lifecycle
   `idle → requesting → processing → done | failed` drives the async
   request-tile → glTF-loader-advance → texture-upload sequence for the root
   tile (`tryUploadRootVoxelTile`), replacing the placeholder gradient once
   real provider data lands. `tryUploadChildVoxelTiles` runs the same machine
   per level-1 child *after* the root reaches `done`, filling the atlas slots.
2. **`shapeUv` convention** (B497, VOXEL-SHAPEUV-CONVENTION). The march
   converts proxy-space points to sample coordinates via the same
   world→shapeUv chain as WebGL's `convertLocalToBoxUv.glsl`: a
   **CPU-composed proxy→shapeUv affine** (built with
   `VoxelBoxShape.convertLocalToShapeUvSpace` semantics rather than a naive
   `p + 0.5`), then `inputCoordinate = shapeUv · u_dimensions +
   u_paddingBefore`. Getting this convention right was the documented B477
   blocker that gated the cell-pick reland (B498).
3. **Depth-1 octree traversal + atlas** (B501, PARITY-VOXEL-OCTREE-LOD). Tile
   slabs are stacked along Z in one 3D texture; `atlasInfo.x` carries the slot
   count and `atlasInfo.y` the frame's target LOD level (0 = root, 1 =
   refine). When refining, the color march picks the child octant
   (`childCoord = floor(shapeUv * 2)`), maps it to its atlas slot, and
   rescales `tileUv = shapeUv * 2 − childCoord` — WebGL's `getTileUv`
   convention specialized to depth 1 (root + 8 level-1 children). Deeper
   octree levels are a known follow-up, not shipped.
4. **Cell-pick derived command** (B498 reland). A pick variant of the color
   command (`attachPickVoxelToColorCommand`, `WebGPUPickCommandHelpers.ts`)
   runs `fragmentPickVoxelMain`, which re-walks the same
   world→shapeUv→inputCoordinate chain and encodes the winning sample's cell
   index for the pick readback.
5. **User-customShader codegen** (B503, VOXEL-USER-CUSTOMSHADER,
   `WebGPUVoxelCustomShaderCodegen.ts`). A user-supplied **native-WGSL**
   voxel `CustomShader` is compiled into a generated chunk
   (`czm_voxelCustomFragmentMain` + bridge structs) prepended to the inline
   `VOXEL_WGSL`, gated by `VOXEL_USER_CUSTOM_SHADER (1<<29)` and cached under
   the chunk's FNV-1a hash as `keySalt` (§6.3.1). GLSL-only voxel
   customShaders keep the warn + default-gray behavior (WGSL transpile
   deferred by design). Mid-session shader swap/clear re-patches the module
   idempotently via a name compare.

### 12.1 OPEN — pick march does not compose with octree LOD or user shaders

**Confirmed OPEN at the 2026-07-02 campaign audit (in-code-acknowledged; the
top voxel follow-up):**

- **Pick ↔ octree (HIGH).** `fragmentPickVoxelMain`
  (`WebGPUVoxelRenderer.ts` ~664–716) never performs the level-1 child-octant
  traversal the color march does (~416–433) — it samples the **root slab**
  (z normalized into slot 0) and hardcodes `megatextureId =
  packVoxelIntToVec2(0.0)` (~line 708). Whenever the frame refines to level
  1, pick returns a root-cell index for a leaf the user actually sees. Fix =
  add the child traversal + child-tile megatextureId to the pick march.
- **Pick ↔ user customShader (MEDIUM).** The pick march selects its winning
  sample with the *default-shader* gate `s.a > densityThreshold` (~697),
  while the user-shader color march accumulates `voxelMaterial.alpha`
  ungated for every sample (~473–478) — a user shader that remaps opacity
  makes the WebGPU pick disagree with both the displayed surface and WebGL.
  The natural fix rides with the octree-pick work: the pick march needs a
  `VOXEL_USER_CUSTOM_SHADER` branch.

---

## Appendix — Cross-references

- **Rules of record:** `cesium-webgpu/CLAUDE.md` (authoritative; this doc
  explains, it does not override).
- **Decomposition rationale:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
  (line counts stale — see §8).
- **Survivability / embeddability / portability detail (device-loss, OOM,
  multi-instance, Electron, Firefox/Safari coverage):**
  `migration_doc/ARCHITECTURE_REVIEW_2026-09-02.md` §3.11 (current — corrected
  re-derivation, re-verified 2026-09-03). Original source, archived 2026-09-03:
  `migration_doc/archive/audits-2026-04-30/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`.
- **Feature catalog & status tags:** `migration_doc/FEATURE_INVENTORY.md` and
  `FORK_OVERVIEW`.
- **Deferred / WIP scaffolding:** `migration_doc/DEFERRED_WORK.md`.
- **Debugging entry point:** `migration_doc/DEBUGGING_GUIDE.md`.
- **Feature Renderer onboarding (worked checklist + lifecycle vocabulary):**
  `migration_doc/FEATURE_RENDERER_ONBOARDING.md` (source for §3.1–§3.4).
- **CSM precision/stabilization detail (slices, specs, math):**
  `migration_doc/CSM_DESIGN.md` (source for §5.1–§5.3).
- **GPU-resident tiling design + dependency DAG:**
  `migration_doc/PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` (source for §5.4 + §10).
- **glTF shader-variant strategy reconciliation:**
  `migration_doc/PHASE_8_SHADER_STRATEGY.md` (source for §6.4).
