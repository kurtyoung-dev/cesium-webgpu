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
callers duck-type-dispatch by checking existence.

### Scene Logic Extractor rule — CRITICAL for Collections

Shared *scene-level* logic (entity dirty-tracking, visibility/show checks, scene-
mode updates, bounding-volume work) MUST run **before** the
`getFeatureRenderer` / `if (context.isWebGPU)` branch point. Feature renderers
handle only GPU resource creation, draw-command emission, and backend
optimizations — they do **not** re-implement shared scene logic. Putting shared
logic behind the branch silently desyncs the two backends.

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
specific command class. (Note: the file lives under `Renderer/WebGPU/` but is a
backend-neutral abstraction — `status: verify` whether it is on the
`WEBGPU_COMPAT_EXEMPTIONS` list if it must be consumable from a webgl-only
build.)

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
> **17 active bits** (re-verified). Current bits:
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
> | `1<<9` | `MODEL_HAS_KHR_TEXTURES` | model KHR texture path |
> | `1<<10` | `STOCHASTIC_DITHER_ALPHA` | stochastic alpha dither |
> | `1<<11` | `STENCIL_PICK_WINNER` | stencil pick winner |
> | `1<<14` | `MATERIAL_APPLY` | material apply path |
> | `1<<15` | `LOG_DEPTH` | logarithmic depth |
> | `1<<16` | `GLOBE_IMAGERY_REDUCED` | reduced globe imagery |
> | `1<<17` | `CAPTURE_MODE` | scene-capture mode |
> | `1<<18` | `MODEL_HAS_METADATA` | per-model structural-metadata path (DP-H46) |
>
> Bits `1<<12` / `1<<13` are not currently defined (gaps are expected under the
> add-only rule and must be left as gaps). `status: verify` the exact gate text
> for any bit before relying on it — read the JSDoc in `WebGPUShaderDefines.ts`.

`ShaderSourceId` (same file, same add-only rules) gives each source file a stable
8-bit numeric identity. **Source ID 0 is reserved.**

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
  device loss. Key is a Uint32 `(sourceId & 0xff) | ((defines & 0xffffff) << 8)`
  — fastest possible `Map` lookup, no string hashing on the hot path.
- **Tier 2 — per-renderer pipeline cache** (`_pipelineCache` /
  `_wireframePipelineCache` / `_debugFragmentPipelineCache` on each renderer),
  keyed with the defines bitmask as a `|0xNN` suffix.

Entry point: `getOrCreate(sourceId, source, defines, label, keySalt = 0)`. On a
miss it `preprocess`es the source against the defines and compiles the module.

**DP-H46b `keySalt` (Batch 455).** When a caller passes a non-zero `keySalt` (a
per-source *content* fingerprint, e.g. the hash of a generated `struct Metadata`
chunk), the cache key becomes the **string** `"<numericKey>#<salt>"` so two
callers that share `(sourceId, defines)` but supply **different source content**
don't alias one compiled module. `keySalt === 0` (the default) keeps the key
byte-identical to the pre-DP-H46b numeric path → exact parity for every
non-metadata caller. The map type is `Map<number | string, GPUShaderModule>`.
(Shipped `3b146e42a8 "Batch 455: DP-H46b — per-model WGSL metadata codegen"`;
consumed by `WebGPUModelPipelineCache.js`.)

**Prewarm.** Renderers call
`prewarm(sourceId, source, defineSets, labelPrefix)` at the end of their
device-init to compile the variants their first ~30 frames are known to touch,
moving 10–20 ms of shader compile off the render path. The list is each
renderer's own responsibility — no central heuristic. `prewarm` auto-includes
the defines bitmask hex in the devtools label.

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
> unified `LogThrottle` helper is a recommended (not yet shipped) consolidation —
> `status: verify` whether one has landed since the audit.

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
