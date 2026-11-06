---
name: engine-code-standards
description: Engine code rules — architecture, multi-context, parity checklist, dead-code audit, feature inventory, RTE, placement, size, comments, imagery sync. Read before any change under packages/.
---

# Engine Code Standards

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

## Architecture Patterns

### Feature Renderer Pattern (Phase D)

Scene files access WebGPU renderers via `context.getFeatureRenderer('name')` instead of importing from `Renderer/WebGPU/`:

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.FOO);
if (fr) {
  fr.update(this, frameState);
  return;
}
// WebGL code follows as the default fallback
```

All registrations are centralized in `Renderer/WebGPU/WebGPUFeatureRenderers.ts`, called during `WebGPUContext._initialize()`. Adding a feature renderer takes three steps: add the key to `Renderer/FeatureRendererKey.js`, increment its `COUNT` (54 at HEAD), and register the renderer in `WebGPUFeatureRenderers.ts`.

### Scene Logic Extractor Pattern — CRITICAL for Collections

Shared scene-level logic MUST run BEFORE the `if (context.isWebGPU)` branch point.

What belongs **before** the branch (shared): entity cleanup, the `show` early-out, 2D/Columbus-View mode handling, load-error handling, texture-atlas scheduling via `frameState.afterRender`, and ready-state tracking. What belongs **after** it (backend-specific): GPU buffer creation and update, pipeline/shader-program creation, draw-command emission, and backend capability checks.

### Query Capabilities Through the Context

`GraphicsContext` is the single source of truth for shared context capabilities. Scene code queries them through the context (`uniformState`, `cache`, `stencilBuffer`, `msaa`, `colorBufferFloat`, `defaultTexture`, `instancedArrays`, `createPickId()`) and never through backend-specific APIs. Read the current surface from the class, not from a transcribed list.

### Enumerated Keys Over String Lookups

- **NEVER** use string literals for registry/table lookups when a finite set of keys is known
- **ALWAYS** use `FeatureRendererKey` enum constants for O(1) direct array access — enum values are integers and `GraphicsContext` indexes a pre-allocated array with them, so there is no hash computation
- This applies beyond feature renderers: prefer frozen numeric enums over string-keyed Maps or objects whenever the key set is fixed at compile time

### RenderCommand (Backend-Agnostic commandList)

`RenderCommand.js` provides a backend-agnostic command abstraction. New scene features SHOULD use `RenderCommand` instead of importing backend-specific commands directly (ruling D5). Adoption is **not yet complete** and is a queued epic: `buildRenderCommand` must be implemented on both backends (today the abstract base throws), `RenderCommand` must be added to `WEBGPU_COMPAT_EXEMPTIONS` (it lives under `Renderer/WebGPU/`, so the first real Scene consumer would otherwise break the webgl-only variant), and one migrated feature must ship as proof.

---

## 64-Bit Precision & RTE (Relative-To-Eye) — CRITICAL

ALL rendering paths MUST use RTE emulated 64-bit precision:

- **NEVER** use a single `position: vec3<f32>` in vertex buffers — always use `positionHigh` + `positionLow`
- **NEVER** multiply `mvp * vec4(position, 1.0)` — always use `mvpRelativeToEye * translateRelativeToEye(...)`
- **NEVER** add `posHigh + posLow` directly — always subtract camera first
- Uniform buffers must carry `encodedCameraHigh`, `encodedCameraLow`, and `mvpRelativeToEye`
- `UniformState.js` already computes every RTE value — reuse them, do not recompute
- `EncodedCartesian3.js` is renderer-agnostic — use it on both the WebGL and WebGPU paths
- Every renderer's `CameraUniforms` struct MUST carry `previousViewProjection: mat4x4<f32>` at the tail (DP-H41, Batch 27). JS pack writes `UniformState.previousViewProjection` with column-major identity fallback on the first frame. TAA / CSM / motion-vector passes read it via `camera.previousViewProjection`. Shaders that still declare it mid-struct are brought to the rule by the AR-D12 enforcement lane (ruling D4).

---

## Monorepo Architecture — File Placement Rules

CesiumJS uses npm workspaces monorepo. Root `Source/` is a **build output**, NOT the source of truth.

| Content Type | Canonical Location (edit HERE)           | Build Output (DO NOT edit) |
| ------------ | ---------------------------------------- | -------------------------- |
| Engine code  | `packages/engine/Source/`                | `Source/`                  |
| WGSL shaders | `packages/engine/Source/Shaders/WebGPU/` | `Source/Shaders/WebGPU/`   |
| GLSL shaders | `packages/engine/Source/Shaders/`        | `Source/Shaders/`          |
| Widget code  | `packages/widgets/Source/`               | `Source/Widgets/`          |
| Assets       | `packages/engine/Source/Assets/`         | `Source/Assets/`           |
| ThirdParty   | `packages/engine/Source/ThirdParty/`     | `Source/ThirdParty/`       |

- **ALWAYS** create new files in `packages/engine/Source/`
- **NEVER** create or edit files directly in root `Source/` — they are overwritten or orphaned
- Root `Source/Cesium.js` is a generated barrel shim; the other root `Source/` folders are gitignored build output (`copyEngineAssets()` in `scripts/build.js`)
- A WGSL file in root `Source/Shaders/WebGPU/` but not in `packages/engine/Source/Shaders/WebGPU/` was created in the wrong place — move it to the canonical location

---

## File Size & Code Organization

- **Files over ~1000 lines SHOULD be decomposed** into smaller focused modules
- Extract helper functions into `*Helpers.js` or domain-specific companion files
- Each decomposed file should be **under 1000 lines** with a **clear single responsibility**
- The **main class stays in the original file under its original name** — companion files are imported by it
- **Do NOT decompose** performance-critical math classes or pure data/enum definitions
- When touching a file over 1000 lines for functional changes, decompose it too — leave it better than you found it
- Record decompositions in `migration_doc/ES6_MODERNIZATION_STATUS.md` (the live tracker; `ES6_MODERNIZATION_BACKLOG.md` is archived at `migration_doc/archive/ES6_MODERNIZATION_BACKLOG.md`)

---

## Preferred Tech Stack

- **WebGPU**: Prefer WebGPU over WebGL for new rendering features
- **WebAssembly**: Use for performance-critical code paths (terrain, matrix ops, culling)
- **TypeScript**: Prefer TS over JS for new code
- **TypeScript `any` ban**: NEVER use `any` as a variable, parameter, or return type. Use `unknown`, specific interfaces, union types, or generics instead. This applies to `.ts` files AND `.d.ts` ambient declarations. The only exception is third-party library interop where the upstream type is genuinely `any`.
- **Co-located `.d.ts` for JS interop**: for an untyped JS class, write `ClassName.d.ts` next to `ClassName.js`; with `allowJs: true, checkJs: false` a sibling `.d.ts` **overrides** JS inference for imports (templates: `Renderer/{Context,Texture,CubeMap}.d.ts`). For a class matching an ambient interface, use declaration merging: `declare class X {} interface X extends AmbientShape {}`.
- **`@private` JSDoc ≠ TS `private`**: if a JS method is called cross-module, declare it `public` in a co-located `.d.ts` or change the JSDoc tag to `@internal`.
- **Never trim WIP-module interfaces during cast cleanup**: Some `CesiumGraphicsContext`-adjacent interfaces (e.g., `PerformanceManagerContext`) carry forward-looking method slots that aren't yet implemented on the real classes; the construction-site cast bridges the gap intentionally. Don't delete interface methods just because grep shows no callers — verify the owning module is fully implemented first.
- **RxJS**: Prefer for reactive patterns and async operations over async/await, in production code and test pages alike. Reach for async/await only when performance requires it and that has been measured
- **Service Workers**: usable for asset caching / offline capability and background processing of large datasets — only where the benefit is significant and measured
- **Slang (optional)**: new WebGPU shaders may be authored in `.slang` and compiled to WGSL (`scripts/SLANG_GUIDE.md`). Prefer it for shaders that also need a GLSL twin and for prototyping; do NOT use it for performance-critical shaders needing WebGPU-specific tuning, for preprocessor chunk files, or to rewrite existing hand-written WGSL.

---

## ES6+ Modernization — Incremental Upgrade Rule

When making >10 lines of changes to a file, modernize pre-ES6 patterns:

- `var` → `const`/`let`
- Prototype-based inheritance → ES6 `class`
- `Object.defineProperties()` → ES6 `get`/`set`
- String concatenation → template literals
- `require()` / `module.exports` → ES module `import`/`export`
- `arguments` → rest parameters; `apply`/`call` spreading → spread syntax
- `typeof x !== "undefined"` → optional chaining or nullish coalescing
- `.indexOf(x) !== -1` → `.includes(x)`; `obj.hasOwnProperty(k)` → `Object.hasOwn(obj, k)`
- **NEVER** modernize a file you're not otherwise touching
- Prototype-to-class conversions follow upstream [#8359](https://github.com/CesiumGS/cesium/issues/8359) patterns and must preserve every existing test
- Be cautious converting performance-critical math classes (`Cartesian3`, `Matrix4`, `Quaternion`) — they use result parameters and scratch variables where ES6 patterns can add overhead; benchmark before and after
- `.ts` files are already ES2022+; this rule is aimed at `.js`

---

## Comment & JSDoc Rules

- **Preserve ALL existing JSDoc comments** when modernizing files
- **Do NOT add new JSDoc** that didn't exist in the original
- **Do NOT add boilerplate** restating what code obviously does
- **DO add comments** explaining non-obvious WHY — rationale, edge cases, performance notes
- Match the surrounding file's comment density
- Converting a constructor or prototype to a class: drop `@constructor` and `@memberof Foo.prototype` (both implicit in a class body), move `@param` tags from the function-level JSDoc onto `constructor()`, and keep `@alias ClassName` on the class-level JSDoc — the documentation tooling depends on it
- Do not add `@param` annotations to a constructor unless the original function-level JSDoc had them
- **Fork comment standard (seamless with upstream).** Comments under `packages/engine/Source` and `packages/widgets/Source` — code, WGSL, GLSL and shipped assets — describe what the code does and the constraints it obeys, never the work that produced it: no batch numbers, campaign or tracker IDs, row IDs or dates (that history belongs in commit messages and `migration_doc/**`). The test is that someone diffing a fork file against upstream cannot tell which comments are ours by their voice. Comments stay JSDoc-clean for `npm run build-docs`, and derived code is attributed. Full rules, and how `Tools/c16/comment-marker-guard.mjs` and its clean list enforce them: [`Documentation/Contributors/CodingGuide/ForkCommentStandard.md`](../../../Documentation/Contributors/CodingGuide/ForkCommentStandard.md).

---

## Backend Agnosticism (Principle 2)

Principle 2's other rules (scene code is backend-agnostic; backend code lives in Feature Renderers) stay in `CLAUDE.md`; these bullets complete it and bind the same way.

- `GraphicsContext` is an **abstract base class** — both `Context.js` (WebGL) and `WebGPUContext.ts` extend it
- Both renderers implement the **same abstract API** — TypeScript enforces parity at compile time
- The renderer layer is the **ONLY** system that needs to know the current backend
- WebGPU renderer must be optional and configurable via startup parameters
- Use feature detection to gracefully fallback to WebGL when WebGPU is not available

---

## Multi-Context Architecture (Principle 3)

Principle 3's other rules (a unique `context.id` per context, the context id in every error log) stay in `CLAUDE.md`; these bullets complete it and bind the same way.

- `ContextRegistry` (static on `GraphicsContext`) tracks ALL active contexts
- Multiple contexts can run simultaneously — split-screen, multi-view, mixed backends
- Each `View` may carry its own context (`options.graphicsContext`, resolved through `view.effectiveContext`, falling back to the Scene's); `scene.createView(camera, viewport, { graphicsContext })` makes additional views, and `FrameState.context` is repointed to each View's effective context before its render pass
- For WebGPU multi-view prefer **device sharing** (one `GPUDevice` across canvases, `WebGPUDevicePool.ts`); cross-backend multi-view shares CPU-side data through `SharedResourcePool.ts`; `OffscreenContextSupport.ts` is opt-in WebWorker rendering
- `GraphicsContext.registry.getFormattedDiagnostics()` / `.dumpDiagnostics()` dump every active context; `context.log(level, message)` is the context-tagged logging helper both backends inherit

---

## Parity Checklist (Principle 5)

Principle 5's other rules stay in `CLAUDE.md`; these are its remaining bullets and the checklist it requires, and they bind the same way.

- **When fixing an upstream issue** for WebGPU, check if the fix can also improve WebGL
- **Scene-level wiring** (`scene.lights`, View.js sort steps, collection `renderOrder`) is backend-agnostic and benefits both paths — implement it once in shared code

Run this checklist before calling a feature or fix complete:

1. Does the feature's **JS/TS API** work for both backends?
2. Does the feature's **shader code** exist in both WGSL and GLSL? If not, record the gap.
3. Is the feature's **scene wiring** backend-agnostic?
4. Are **command properties** on both `DrawCommand` and `WebGPUDrawCommand`, with matching clone/options support?
5. Is the parity status recorded in `migration_doc/DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C?

Not required for parity: WebGPU-only capabilities with no WebGL equivalent (compute shaders, render bundles, indirect drawing, storage buffers); WebGL1-specific fallbacks (we target WebGL2 only); and performance infrastructure that is inherently GPU-API-specific.

---

## Feature Inventory (Principle 6)

This fork has a **large feature surface**, inventoried in [`migration_doc/FEATURE_INVENTORY.md`](../../../migration_doc/FEATURE_INVENTORY.md) in four buckets: §A EXISTING (inherited from upstream), §B NEW (fork-added, each tagged `(SHIPPED)`, `(SCAFFOLDED)` or `(EXPERIMENTAL)`), §C WIP (partially shipped, known gaps) and §D FUTURE / DEFERRED. Counts drift as the inventory grows; re-measure them there rather than trusting a transcribed figure.

**Before scoping the impact of any change**, cross-reference the affected subsystem(s) in `FEATURE_INVENTORY.md`; the eleven subsystems used for impact scoping (Globe & Imagery, 3D Tiles, glTF Models + KHR, Geometry Primitives, Collections, Entity / DataSource, Picking, Shadows / Lighting, Post-process & Effects, Performance & Compute, Architecture / Build) are detailed at `FORK_OVERVIEW.md:62`. A change touching globe terrain may also affect 3D Tile classification (shared depth target), CSM cascades (cast list), TAA (motion vectors), pick (depth blit). Use the inventory to surface those couplings _before_ writing code, not after a regression.

**When you ship a feature** that resolves a WIP entry, move it from §C to §B (and update the tag). When a future entry becomes WIP, move it from §D to §C. When a new feature lands, add it to §B.

---

## Dead-Code Audit (Principle 7)

This codebase ships features in **batches with deliberate scaffolding** for follow-up work. Code that looks dead at a glance is often pre-allocated infrastructure for a partially-implemented feature.

**Before deleting any code that appears unused** (uncalled methods, unread fields, allocated-but-never-written textures, no-op render passes), check ALL of the following:

1. **Read the file's own module-level docstring.** Cesium WebGPU files often list "What's shipped in this batch" + "What's currently a no-op until follow-ups land". If the code maps to a no-op-pending bullet, it's scaffolding, not dead code.
2. **Search `migration_doc/DEFERRED_WORK.md`** for the relevant subsystem (`C-R*`, `NEW-*`, `BUG-*` entries). Partial-implementation entries explicitly call out which pieces are infrastructure-only awaiting their fill-in.
3. **Search `migration_doc/WEBGPU_DEBUGGING_LOG.md` and `migration_doc/PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`** for the symbol or feature name. These docs describe architectural intent, not just bug history (the archived RENDERER_DEEP pillar's id table is transcribed at `ARCHITECTURE_REVIEW_2026-09-02.md` §5.1).
4. **Check the originating batch comment** (`git log -S '<symbol>'`). Batch headers ("**What's shipped**: A + B + scaffolding for C") tell you whether C is still planned.

**NOT proof of deadness:** a texture allocated but never written, a shader that samples uninitialized data and discards every fragment, a method called every frame with no visible output (the producer half is missing, not the consumer half), or a Sandcastle baseline that still passes after the removal (it covers a narrow set of demos).

When in doubt, leave the scaffolding in place. Removing it forces re-adding it when the follow-up work lands. The cost of one orphaned texture allocation is trivial; the cost of re-architecting a removed code path is real.

This principle's origin story (the C-R8 near-removal) and its later inversion are history, kept in [`RULES_FILE_NOTES.md`](../../../migration_doc/RULES_FILE_NOTES.md) §1. The
principle (check before deleting) stands; the example's FACTS do not - always
re-derive a file's current disposition from the ledger, never from a governance
doc's illustrative anecdote.

---

## Imagery Projection Sync Duty

- [`IMAGERY_PROJECTION.md`](../../../migration_doc/IMAGERY_PROJECTION.md), the single source of truth for imagery-layer projection: it **MUST be kept in sync whenever you touch any file in the projection chain** (`*ImageryReprojection*`, `GlobeFS.glsl`, `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `WebGPUGlobeSurfaceCameraUB.ts`, `ImageryLayer.js`, `ImageryLayerHelpers.js`).
