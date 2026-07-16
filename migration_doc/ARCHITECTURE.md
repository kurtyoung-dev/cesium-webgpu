> **Canonical doc (consolidation first draft, 2026 consolidation).**
> Supersedes (folds in): `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`,
> `migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md` (architecture
> portions), and the "Architecture Patterns" / "64-Bit Precision & RTE" /
> "WGSL Shader Pipeline" / "Monorepo Architecture" / "Logging & Debug Pragmas"
> sections of `cesium-webgpu/CLAUDE.md` (CLAUDE.md remains the authoritative
> *rules* file; this doc is the explanatory *architecture* reference).
> **Review-in-progress.** Status tags re-verified against live code + git log at
> HEAD ≈ Batch 455. Where a claim could not be confirmed it is marked
> `status: verify`.
> **2026-07-02 refresh (post-campaign audit, Batches 482–506, HEAD
> `62c5bab450`):** §6.1 bit table extended to 30 bits, §6.3.1 keySalt escape
> hatch added, §11 (PP library interception) + §12 (voxel data path) added —
> all claims in those sections re-verified against live code at that HEAD.

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

Scene code interacts with `GraphicsContext` and **never** imports from
`Renderer/WebGPU/` and **never** branches on `isWebGPU`. Verified at the
2026-04-30 audit: `import "../Renderer/WebGPU/"` in `Source/Scene/*.js` had
**zero hits**; `if (context.isWebGPU)` had ~15 transitional branches (all
justifiable in-flight migrations). External/extension code *may* query
`context.rendererType` / `context.isWebGPU` for introspection but should not
branch rendering logic on it.

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

### previousViewProjection (DP-H41) — motion-vector tail

Every renderer's `CameraUniforms` struct carries
`previousViewProjection: mat4x4<f32>` at the tail (DP-H41, originally Batch 27;
rolled across classifiers + advanced renderers in **Batch 153**,
`b4a8ebaf6b "DP-H41 prevViewProjection across classifier + advanced renderers"`).
The JS pack writes `UniformState.previousViewProjection` with a column-major
identity fallback on the first frame. TAA, CSM, and motion-vector passes read it
via `camera.previousViewProjection`. Confirmed present across many renderers
(`WebGPUGlobeSurfaceCameraUB.ts`, `WebGPUCloudRenderer.ts`,
`WebGPUGaussianSplatRenderer.ts`, classifiers, etc.).

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
`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16` review. The audit + fix are
unstarted. Until they land, Mars/Moon tilesets are at risk.

---

## 6. WGSL Shader Pipeline — Defines, Preprocessor, Module Cache

Infrastructure landed Batches 22–27 and has been heavily extended since
(Batches 162–164 widened shader-module-cache adoption; DP-H46b added a content
salt). Do not bypass these when adding shader variants.

### 6.1 `ShaderDefine` bitmask registry — `WebGPUShaderDefines.ts`

Each entry is **one bit** of a Uint32. **Add-only — never reorder, renumber, or
remove an entry**, even if its last consumer disappears: reordering silently
aliases cached modules across rebuilds; removal breaks any pipeline still
referencing the bit. Deprecated entries stay with a comment marker.

> **CLAUDE.md is stale here.** CLAUDE.md lists only the first 4 bits
> (`GEODETIC_NORMAL … COMPRESSED_VERTICES`). The live registry has grown to
> **30 active bits** (`1<<0` … `1<<29`, re-verified against `: 1 <<` in
> `WebGPUShaderDefines.ts` at HEAD ≈ Batch 506, `62c5bab450`; the campaign
> Batches 482–506 appended exactly 4 tail bits, `1<<26`–`1<<29`). **Six bits
> (`1<<24` … `1<<29`) live above the module cache's 24-bit define window and
> MUST be folded via `keySalt`** — see §6.3.1. Current bits:
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
> | `1<<24` | `MODEL_HAS_WGSL_CUSTOM_VERTEX` | model user customShader native WGSL *vertex* body — **keySalt bit** (§6.3.1) |
> | `1<<25` | `VOXEL_CUSTOM_SHADER_COLOR` | voxel default-shader parity color march (Batch 476; `//>>else` = historical raw-texel accumulation) — **keySalt bit** |
> | `1<<26` | `MODEL_SPLIT_ENABLED` | model split-screen discard (B483) — **keySalt bit** |
> | `1<<27` | `MODEL_HAS_COLOR` | `model.color` tint / blend-mode path (B484) — **keySalt bit** |
> | `1<<28` | `MODEL_SILHOUETTE` | model silhouette stencil two-pass (B485; `ModelSilhouetteStage.wgsl`) — **keySalt bit** |
> | `1<<29` | `VOXEL_USER_CUSTOM_SHADER` | user native-WGSL voxel customShader in the ray-march (B503; generated codegen chunk) — **keySalt bit** |
>
> The registry is contiguous through `1<<29` at HEAD (no gaps); the add-only rule
> still mandates that if a bit's last consumer disappears the slot is *retained*
> as a gap rather than renumbered. `status: verify` the exact gate text for any
> bit before relying on it — read the JSDoc in `WebGPUShaderDefines.ts`.

`ShaderSourceId` (same file, same add-only rules) gives each source file a stable
8-bit numeric identity. **Source ID 0 is reserved.** Live count at HEAD ≈
Batch 506: **39 registrations** (contiguous `1…39`, highest
`POINT_CLOUD_EDL_BLEND: 39`; the 482–506 campaign added zero new source IDs).

**Adding a new define bit:** (1) append the entry (never reorder); (2) document
what it gates + which shaders consume it in the JSDoc; (3) add the
`//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` block to each consuming shader,
keeping `//>>else` as the historical path; (4) route module creation through
`preprocess(code, defines)` / the module cache so directives resolve.

### 6.2 `//>>ifdef` preprocessor — `WebGPUShaderPreprocessor.ts`

A pure function `(source: string, defines: number) → string`. Directives
`//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` sit on their own lines; flag
names must be `UPPERCASE_WITH_UNDERSCORES` and resolve to a `ShaderDefine` bit.
Unknown flag names **throw at preprocess time with the source line number** —
typos fail loudly. `defines=0` emits every block's `//>>else` branch and is
byte-identical to a shader with no ifdef blocks (the safe migration default).

### 6.3 Shader module cache — `WebGPUShaderModuleCache.ts`

Two-tier model:

- **Tier 1 — module dedupe (this class).** One cache per `GPUDevice`, cleared on
  device loss. The common-path key is the exact safe integer
  `((defines >>> 0) * 0x100) + sourceId`: eight low bits identify the validated
  source ID and all 32 high bits retain the complete define mask. The maximum
  key is `2^40 - 1`, inside JavaScript's exact 53-bit integer range, so ordinary
  lookups remain allocation-free numeric `Map` operations without high-define
  aliasing.
- **Tier 2 — per-renderer pipeline cache** (`_pipelineCache` /
  `_wireframePipelineCache` / `_debugFragmentPipelineCache` on each renderer),
  keyed with the defines bitmask as a `|0xNN` suffix.

Entry point: `getOrCreate(sourceId, source, defines, label, keySalt = 0)`. On a
miss it `preprocess`es the source against the defines and compiles the module.

**DP-H46b `keySalt` (Batch 455).** When a caller passes a non-zero `keySalt` (a
per-source *content* fingerprint, e.g. the hash of a generated `struct Metadata`
chunk), the cache key becomes the **string** `"<numericKey>#<salt>"` so two
callers that share `(sourceId, defines)` but supply **different source content**
don't alias one compiled module. `keySalt === 0` (the default) keeps the
allocation-free numeric path. The map type is
`Map<number | string, GPUShaderModule>`.
(Shipped `3b146e42a8 "Batch 455: DP-H46b — per-model WGSL metadata codegen"`;
consumed by `WebGPUModelPipelineCache.js`.)

#### 6.3.1 `keySalt` is generated-source identity, not define overflow

All 32 define bits participate directly in the numeric key, including bits
24–31. Pass non-zero `keySalt` only when WGSL source text can change while
`(sourceId, defines)` stays the same—for example model metadata or user
custom-shader code generation. The salt is a stable content fingerprint; it
must not substitute for declaring a real static variant bit.

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

### 11.1 OPEN — pre-tonemap ordering divergence vs WebGL

**Known caveat (confirmed OPEN at the 2026-07-02 campaign audit; not yet
fixed).** WebGPU executes the intercepted library stages *and* user WGSL
stages **before** tonemapping (`WebGPUPostProcessPipeline.ts` execute order:
user stages ~1406 → library stages ~1425 → TAA → tonemap ~1503 → color
grading → FXAA), whereas WebGL's `PostProcessStageCollection` runs added
stages **after** the tonemapping stage (`PostProcessStageCollection.js`
~745–758 sets the tonemapped SDR output as the added stages' input). Impact
today is **HDR-only** — the SDR cross-backend probe passed at 9.85% — but
under an HDR canvas the builtins receive unbounded linear input with no
`hdrMode` compensation (ColorGrading and FXAA got exactly that compensation in
B479; the library/user stages have not). The in-code comments at ~1403/1421
claiming a "WebGL-matching insertion point", and the header docstring's stage
order (~lines 39–42), are **inaccurate** and slated for correction with the
fix. Note the contrast with TAA, whose pre-tonemap placement is *correct by
design* (Batch 290 reconciliation — TAA does its own reversible
tonemap-weighting); the library/user-stage placement has no such justification
yet. Follow-up: hdrMode compensation or post-tonemap placement for
library/user stages.

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
  `migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`.
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
