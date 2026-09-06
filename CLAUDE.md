# CLAUDE.md — CesiumJS WebGPU Project Rules

This file is the Claude Code equivalent of `.clinerules`. It is automatically loaded into every Claude Code conversation.

---

## Active Remediation Campaign — see CAMPAIGN_STATE.md

Campaign status (which campaigns are launched, their critical paths, current holds, and the
ruling that governs each) lives in the tracked
[`migration_doc/CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md), which is the **sole
campaign-status authority** (`R-2026-09-02-14`). This section is a pointer, not a mirror — do not
restate campaign facts here; edit `CAMPAIGN_STATE.md` instead, in the same commit as any
campaign-level change.

Within that authority, the individual `QUEUE_*_CAMPAIGN*.md` documents remain the **row-level**
authorities for task status, acceptance, and dependencies — `CAMPAIGN_STATE.md` does not
duplicate row detail, only the campaign-level facts (launched-or-not, critical path, holds).

Read `CAMPAIGN_STATE.md` first for orientation; it also carries the GitHub quiet-hours and
branch-transparency HARD rules restated below in this file, kept in sync with
`ORCHESTRATION_HANDBOOK.md` §3.

---

## Core Principles

### 1. Preserve Existing Functionality

- WebGL rendering must continue to work correctly — **never break existing WebGL behavior**
- Upstream WebGL files **may be modified** when it improves overall architecture (e.g., `Context.js` ES6 class conversion + `extends GraphicsContext`) — the goal is preserving _functionality_, not preserving _code as-is_
- All existing APIs must continue to work as expected
- Maintain backward compatibility with existing CesiumJS applications
- Ensure all existing tests continue to pass

### 2. Backend Agnosticism (Three.js + PlayCanvas Hybrid)

- Scene code must be **backend-agnostic** — it should NOT import from `Renderer/WebGPU/` or check `isWebGPU`
- All backend-specific code lives in **Feature Renderers** accessed through `GraphicsContext`
- `GraphicsContext` is an **abstract base class** — both `Context.js` (WebGL) and `WebGPUContext.ts` extend it
- Both renderers implement the **same abstract API** — TypeScript enforces parity at compile time
- The renderer layer is the **ONLY** system that needs to know the current backend
- External/extension code CAN query context type via getters (`context.rendererType`, `context.isWebGPU`) but should NOT branch on it
- WebGPU renderer must be optional and configurable via startup parameters
- Use feature detection to gracefully fallback to WebGL when WebGPU is not available

### 3. Multi-Context Support

- Every `GraphicsContext` instance has a **unique ID** (`context.id`) and its own `rendererType`
- `ContextRegistry` (static on `GraphicsContext`) tracks ALL active contexts
- Multiple contexts can run simultaneously — split-screen, multi-view, mixed backends
- Error logs MUST include context ID: `[CesiumJS:webgpu:ctx-a3f7] Pipeline creation failed`
- Each `View` may carry its own context — `options.graphicsContext` (`Scene/View.js:76`), resolved through `view.effectiveContext` (`:187`), which falls back to the Scene's context. `scene.createView(camera, viewport, { graphicsContext })` (`Scene.js:4725`) is the factory for additional views, and `FrameState.context` is repointed to each View's effective context before its render pass (the same way upstream repoints `frameState.camera`)
- For WebGPU multi-view prefer **device sharing** — one `GPUDevice` across canvases via `Renderer/WebGPU/WebGPUDevicePool.ts`. For cross-backend multi-view use `Renderer/SharedResourcePool.ts` for CPU-side data. `Renderer/OffscreenContextSupport.ts` enables background rendering in a WebWorker (opt-in, `useOffscreenCanvas: true`)
- `GraphicsContext.registry.getFormattedDiagnostics()` and `.dumpDiagnostics()` (`Renderer/ContextRegistry.ts:213`, `:241`) dump every active context; `context.log(level, message)` (`GraphicsContext.ts:1961`) is the context-tagged logging helper both backends inherit

### 4. WebGL2 Targeting

- Our fork targets **WebGL2 only** — we do NOT actively maintain WebGL1 fallback paths
- This reduces maintenance from 3 rendering paths to 2 (WebGL2 + WebGPU)

### 5. WebGL/WebGPU Feature Parity — CRITICAL

When implementing features for **either** backend, check whether the same improvement should also be applied to the **other** backend.

- **New renderer-agnostic features** MUST be implemented for **both** backends simultaneously
- **New shader features** need both WGSL and GLSL implementations (unless architecturally impossible in WebGL)
- **When adding a property to `DrawCommand`**, also add it to `WebGPUDrawCommand` (and vice versa) — including the options interface, `clone()`, and any sorting/dispatch logic
- **When fixing an upstream issue** for WebGPU, check if the fix can also improve WebGL
- **Scene-level wiring** (`scene.lights`, View.js sort steps, collection `renderOrder`) is backend-agnostic and benefits both paths — implement it once in shared code

Run this checklist before calling a feature or fix complete:

1. Does the feature's **JS/TS API** work for both backends?
2. Does the feature's **shader code** exist in both WGSL and GLSL? If not, record the gap.
3. Is the feature's **scene wiring** backend-agnostic?
4. Are **command properties** on both `DrawCommand` and `WebGPUDrawCommand`, with matching clone/options support?
5. Is the parity status recorded in `migration_doc/DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C?

Not required for parity: WebGPU-only capabilities with no WebGL equivalent (compute shaders, render bundles, indirect drawing, storage buffers); WebGL1-specific fallbacks (we target WebGL2 only); and performance infrastructure that is inherently GPU-API-specific.

### 6. Feature Inventory — Scope the Impact of Every Change — CRITICAL

This fork has a **large feature surface** spanning four buckets:

- **EXISTING** — 308 features inherited from upstream Cesium (globe, imagery, 3D Tiles, glTF Models, geometry primitives, collections, entities, datasources, particles, post-processing, camera, picking, time, materials, shadows, widgets — see [migration_doc/FEATURE_INVENTORY.md §A](migration_doc/FEATURE_INVENTORY.md#a-existing--upstream-cesium-features-inherited-by-the-fork) for the full list).
- **NEW** — 352 fork-added features (the entire WebGPU renderer + abstractions + tooling — see [§B](migration_doc/FEATURE_INVENTORY.md#b-new--fork-specific-additions)). Each tagged `(SHIPPED)`, `(SCAFFOLDED)`, or `(EXPERIMENTAL)`.
- **WIP** — 116 partially-shipped features with known gaps (see [§C](migration_doc/FEATURE_INVENTORY.md#c-wip--work-in-progress)).
- **FUTURE / DEFERRED** — 156 explicitly punted, gated, or research-stage items (see [§D](migration_doc/FEATURE_INVENTORY.md#d-future--deferred)).

<!-- corrected 2026-09-05 from the doc-fitness audit G-08/G-09 (D10 factual); counts re-measured at HEAD 556f06484e -->

Counts measured 2026-09-05 by counting top-level `-` bullet lines in each section's line range in `FEATURE_INVENTORY.md`. They drift as the inventory grows — re-measure rather than trust these absolutes indefinitely. The §C figure includes 15 struck-through entries already marked resolved but not yet migrated to §B, so the true open-WIP count is lower.

<!-- corrected 2026-09-05 from the doc-fitness audit G-47 (D10 factual): the list below has always had eleven entries -->

**Before scoping the impact of any change**, cross-reference the affected subsystem(s) in [migration_doc/FEATURE_INVENTORY.md](migration_doc/FEATURE_INVENTORY.md). The eleven subsystems used for impact scoping (`FORK_OVERVIEW.md:62`):

1. **Globe & Imagery** — terrain providers, imagery providers, atmosphere, water, fog
2. **3D Tiles** — B3DM/I3DM/PNTS/CMPT/glTF, voxels, Gaussian splats, classification, styling, metadata
3. **glTF Models + KHR Extensions** — model loader, PBR pipeline stages, animation, skinning, KHR_materials_*
4. **Geometry Primitives** — Box/Sphere/Polygon/Polyline/Wall/Corridor/Frustum, GroundPrimitive, ClassificationPrimitive
5. **Collections** — Billboard, Label, Point, Polyline, Cloud, BufferPrimitive, EntityCluster
6. **Entity / DataSource API** — Entity, properties, graphics, visualizers, CZML/GeoJSON/KML/GPX
7. **Picking** — pick/drillPick/pickPosition/pickFromRay, metadata pick, pick framebuffer
8. **Shadows / Lighting** — CSM, point lights, IBL, sun/moon/sky, atmosphere
9. **Post-process & Effects** — Bloom, AO, DoF, FXAA, TAA, SSR, AutoExposure, Tonemap, ColorGrading, Volumetric Fog, Procedural Clouds
10. **Performance & Compute** — pipeline cache, bind group cache, render bundles, compute shaders, WASM bridges
11. **Architecture / Build** — GraphicsContext abstraction, ContextFactory, FeatureRenderer pattern, build variants

A change touching globe terrain may also affect 3D Tile classification (shared depth target), CSM cascades (cast list), TAA (motion vectors), pick (depth blit). Use the inventory to surface those couplings _before_ writing code, not after a regression.

**When you ship a feature** that resolves a WIP entry, move it from §C to §B (and update the tag). When a future entry becomes WIP, move it from §D to §C. When a new feature lands, add it to §B. **Don't let the inventory go stale** — it's load-bearing for impact analysis.

### 7. "Dead" Code Audit — Cross-Reference Architecture Docs Before Removing — CRITICAL

This codebase ships features in **batches with deliberate scaffolding** for follow-up work. Code that looks dead at a glance is often pre-allocated infrastructure for a partially-implemented feature.

**Before deleting any code that appears unused** (uncalled methods, unread fields, allocated-but-never-written textures, no-op render passes), check ALL of the following:

1. **Read the file's own module-level docstring.** Cesium WebGPU files often list "What's shipped in this batch" + "What's currently a no-op until follow-ups land". If the code maps to a no-op-pending bullet, it's scaffolding, not dead code.
2. **Search `migration_doc/DEFERRED_WORK.md`** for the relevant subsystem (`C-R*`, `NEW-*`, `BUG-*` entries). Partial-implementation entries explicitly call out which pieces are infrastructure-only awaiting their fill-in.
3. **Search `migration_doc/WEBGPU_DEBUGGING_LOG.md` and `migration_doc/PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`** — the surviving pillar — for the symbol or feature name. These docs describe architectural intent, not just bug history. The RENDERER_DEEP pillar, home of this Principle's own C-R8 worked example below, is archived at `migration_doc/archive/principal-review-2026-04-16/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` (its id table is transcribed at `ARCHITECTURE_REVIEW_2026-09-02.md` §5.1). <!-- corrected 2026-09-05 from the doc-fitness audit G-05(c) (D10 factual): the old glob matched 1 of 4 files, and not the one holding C-R8 -->
4. **Check the originating batch comment** (`git log -S '<symbol>'`). Batch headers ("**What's shipped**: A + B + scaffolding for C") tell you whether C is still planned.

**Specific anti-patterns that are NOT proof of deadness:**

- "The texture is allocated but no render pass writes to it" — that's exactly what a destination scaffolded for an unfinished render-pass redirect looks like.
- "The shader samples uninitialized data and discards every fragment" — same shape: composite pipeline waiting for upstream rendering to be wired into the source target.
- "The method is called every frame but produces no visible output" — the producer half is missing, not the consumer half.
- "Sandcastle baseline still passes after the removal" — the baseline only covers a narrow set of demos; partial-implementation gaps often live in scenes the baseline doesn't exercise.

**When in doubt, leave the scaffolding in place.** Removing it forces re-adding it when the follow-up work lands. The cost of one orphaned texture allocation is trivial; the cost of re-architecting a removed code path is real.

**Origin context:** during the C-R8 audit (2026-04-28), I nearly removed `WebGPUTranslucentTileClassification`'s `_classificationColorTexture`, `composite()`, and `_runTranslucentTileClassificationComposite` because the texture was never written and the composite was a visual no-op. The file's own docstring at lines 11-19 explicitly listed the accumulation target + composite pipeline as Batch 47 deliverables for the unfinished multi-frustum accumulation work. The user caught the mistake before it landed. This rule was added so future sessions don't repeat it.

**The origin story above is HISTORY, not the current disposition of that code.** The
ledger (`DEFERRED_WORK.md`) later CLOSED multi-frustum classification (the
depth-sample approach needs neither accumulation nor composite) and SCHEDULED the
scaffolding's removal as its own cleanup. On 2026-08-21 two workers and the
orchestrator all reconstructed a comment from this origin story instead of the
ledger, inverting a remove-later disposition into a must-not-remove claim. The
principle (check before deleting) stands; the example's FACTS do not - always
re-derive a file's current disposition from the ledger, never from a governance
doc's illustrative anecdote.

### 8. Verify Rendering Fixes via Playwright — DO NOT ask the user to verify visual output — CRITICAL

If a fix is visually verifiable (renders a globe, sky, tiles, post-process effects, picking, etc.), the verification must be done via an automated Playwright probe BEFORE the fix is claimed to work — not by asking the user to reload and inspect.

**Required workflow for any WebGPU rendering fix:**

1. **Reproduce the symptom in a probe first.** Build a probe under `Tools/visual-regression/probe-*.mjs` that loads the exact URL/camera/mode that triggers the bug. The probe MUST match the user's reproduction (saved-view query params, terrain/imagery picker selections, scene mode) — default-camera probes miss LOD-specific and view-specific artifacts.
2. **Capture WebGL vs WebGPU + compute a pixel diff.** Use `probe-saved-view.mjs` as the template — Playwright + canvas-decode diff (no Node PNG dep needed). Record the baseline mismatch percentage.
3. **Apply the fix → rebuild → re-run the probe.** Compare the new mismatch percentage against baseline. A "fix" that doesn't move the diff is not a fix.
4. **Read the output PNGs yourself.** Don't claim a fix works just because the diff dropped — visually confirm against the WebGL screenshot that the artifact is gone and no new artifact appeared.
5. **Only then ping the user.** Surface the probe name, the mismatch delta, and the screenshots so the user can spot-check rather than diagnose.

**Anti-patterns to avoid:**

- "Try reloading and let me know if the ring is gone" — the user has already reported the bug; their job is not to re-verify what you can verify automatically.
- "The build has the fix, so it should work" — `grep`-ing the build output proves bytes are present, not that the runtime path is reached or the bug is gone.
- Default-camera probes when the user reported the bug at a specific saved view — match their reproduction exactly.

**Probe-first applies even when "I'm just going to be quick":** the cost of building a probe once is far lower than the cost of three speculative fix iterations that each need a user round-trip to disprove.

### 9. Surface Missing/Deferred Functionality as Immediate Next Work — CRITICAL

When investigating a bug, if the root cause turns out to be **unfinished, missing, or explicitly-deferred functionality** (not a regression in working code), do not paper over it — surface it as the next concrete work item.

**Required behavior:**

- If a fix is gated on functionality that doesn't exist yet (e.g., "this would work if the WGSL planar shader matched Cesium's 2D camera axis convention, but the convention isn't wired through"), name the missing piece in the response and add it to the todo list as the next immediate item.
- Cross-reference `migration_doc/DEFERRED_WORK.md` and `migration_doc/FEATURE_INVENTORY.md` §C (WIP) and §D (FUTURE) when the missing piece looks like it should already be tracked there. If it's not tracked, add it.
- Do not silently route around missing functionality with an inline hack at the call site — that creates the kind of partial-implementation debt that Principle 7 ("dead code audit") warns against.
- If the user is blocked by the missing functionality, say so plainly so they can prioritize: "this bug needs X, which is currently deferred — building X is the next concrete step, want me to do that now?"

This is the corollary of Principle 7: keep scaffolding in place AND finish the work the scaffolding implies.

---

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

`GraphicsContext` is the single source of truth for shared context capabilities. Scene code queries them through the context (`uniformState`, `cache`, `stencilBuffer`, `msaa`, `colorBufferFloat`, `defaultTexture`, `instancedArrays`, `createPickId()`) and never through backend-specific APIs. Read the current surface from the class rather than a prose list here — a transcribed capability list rots the way the counts above did.

### Enumerated Keys Over String Lookups

- **NEVER** use string literals for registry/table lookups when a finite set of keys is known
- **ALWAYS** use `FeatureRendererKey` enum constants for O(1) direct array access — enum values are integers and `GraphicsContext` indexes a pre-allocated array with them, so there is no hash computation
- This applies beyond feature renderers: prefer frozen numeric enums over string-keyed Maps or objects whenever the key set is fixed at compile time

### RenderCommand (Backend-Agnostic commandList)

`RenderCommand.js` provides a backend-agnostic command abstraction. New scene features SHOULD use `RenderCommand` instead of importing backend-specific commands directly. <!-- ruling D5, 2026-09-05: ADOPTED — the recommendation stands -->

Adoption is ruled (D5) but **not yet complete**, and completing it is a queued epic: `buildRenderCommand` must be implemented on both backends (today only the abstract base exists, and it throws — `GraphicsContext.ts:1916-1919`), `RenderCommand` must be added to `WEBGPU_COMPAT_EXEMPTIONS` (it lives under `Renderer/WebGPU/`, so the first real Scene consumer would otherwise break the webgl-only variant), and one migrated feature must ship as proof.

---

## 64-Bit Precision & RTE (Relative-To-Eye) — CRITICAL

ALL rendering paths MUST use RTE emulated 64-bit precision:

- **NEVER** use a single `position: vec3<f32>` in vertex buffers — always use `positionHigh` + `positionLow`
- **NEVER** multiply `mvp * vec4(position, 1.0)` — always use `mvpRelativeToEye * translateRelativeToEye(...)`
- **NEVER** add `posHigh + posLow` directly — always subtract camera first
- Uniform buffers must carry `encodedCameraHigh`, `encodedCameraLow`, and `mvpRelativeToEye`
- `UniformState.js` already computes every RTE value — reuse them, do not recompute
- `EncodedCartesian3.js` is renderer-agnostic — use it on both the WebGL and WebGPU paths
- Every renderer's `CameraUniforms` struct MUST carry `previousViewProjection: mat4x4<f32>` at the tail (DP-H41, Batch 27). JS pack writes `UniformState.previousViewProjection` with column-major identity fallback on the first frame. TAA / CSM / motion-vector passes read it via `camera.previousViewProjection`.

---

## WGSL Shader Pipeline — Defines, Preprocessor, Module Cache

Infrastructure landed in Batches 22-27. Do not bypass these when adding shader variants.

### `ShaderDefine` bitmask registry (`WebGPUShaderDefines.ts`)

- Each entry is one bit of a Uint32. The registry currently occupies bits 0-30; `WebGPUShaderDefines.ts` is the authoritative name/bit table.
- **Add-only. Never reorder, renumber, or remove** an entry even if its last consumer disappears. Reordering silently aliases cached modules; removal breaks any pipeline still referencing the bit. Deprecated entries stay with a comment marker.
- `ShaderSourceId` registry follows the same rules. Source ID 0 is reserved.

### `//>>ifdef` preprocessor (`WebGPUShaderPreprocessor.ts`)

- Directives: `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` on their own lines. Flag names must match the UPPERCASE_WITH_UNDERSCORES pattern and resolve to a `ShaderDefine` bit.
- Unknown flag names throw at preprocess time with the source line number — typos fail loudly, not silently.
- The preprocessor is a pure function over `(source: string, defines: number) → string`. Same input always produces same output; callers cache results in `WebGPUShaderModuleCache`.
- `defines=0` emits the `//>>else` branch of every block and is byte-identical to shaders without ifdef blocks. Safe default for migration.

### Shader module cache (`WebGPUShaderModuleCache.ts`)

- Tier 1 — per-`GPUDevice` dedupe keyed by the exact safe integer `((defines >>> 0) * 0x100) + sourceId`. This retains the complete 32-bit define mask while reserving eight low bits for the validated source ID; JavaScript represents every resulting 40-bit key exactly. One cache per device; cleared on device loss.
- `getOrCreate(sourceId, source, defines, label)` is the entry point. Call `prewarm(sourceId, source, defineSets, labelPrefix)` at renderer init for known-hot variants.
- A non-zero `keySalt` is only for generated WGSL whose source text adds an identity dimension beyond `(sourceId, defines)`; it is not required merely because a define uses bit 24 or above.
- Labels should include the define bitmask hex for devtools readability (`prewarm` does this automatically).

### Adding a new define bit

1. Add the entry to `ShaderDefine` (do not reorder existing ones).
2. Document what it gates + which shaders consume it in the JSDoc block.
3. For each consuming shader: add the `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` block; keep the `//>>else` branch as the historical code path.
4. Route the shader-module creation through `preprocess(code, defines)` (or the module cache) so the directives resolve.
5. _(Optional — defense in depth, no longer required for correctness.)_ Add a marker for the axis to the pipeline descriptor's `name`, or stamp the whole mask (`defines=0x${defines.toString(16)}`). See the next section for why this was demoted.

### Pipeline-key aliasing is handled STRUCTURALLY — per-axis markers are defense-in-depth

`WebGPURenderPipelineCache.generateCacheKey` folds **shader-module identity** into every key (`sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>`, via a `WeakMap`-backed `webgpuObjectIdentity`), alongside `pl:` layout identity, `pr:` primitive state, `dz:` depth/stencil state and `mx:` multisample extras — i.e. every field `buildPipelineDescriptor` forwards to `createRenderPipeline`. `WebGPUComputePipelineCache` folds `compute.module` the same way (`m:`).

Because `WebGPUShaderModuleCache` hands out a distinct `GPUShaderModule` per `(sourceId, defines, definesHi, keySalt)`, **a new define bit cannot alias in the pipeline cache regardless of whether anyone remembers step 5.** Module identity is strictly stronger than the mask: it also separates producers that compiled different source text under the same mask, and producers that call `device.createShaderModule` directly.

This was `NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL` (fold landed Batch 825, Edge-verified in both probe modes at Batch 828 — 3,729 pipeline calls, 0 collisions, `wrongModuleHits` 0, and the negative control fires). Before it, the key read neither the module nor the mask — and since **no caller passes a `variant`**, not `primitive.cullMode` or most of `depthStencil` either. The whole marker fleet (`, ld=1`, `, noCull`, `, imagery4`, `, enhOcean`, `defines=0x…`, `[sf=…]`) existed to stand in for those omissions, at the cost of two batches of point mitigation and five probes whose OFF legs were void for months.

- **Keep every existing marker.** A bare `sh:41.…` says two rows are distinct but not WHICH variant each one is; markers are what make `describeCacheKey()`, `listPipelineVariants()` and devtools labels readable. Remove one only with proof.
- **`stats.wrongModuleHits` must stay and must read 0.** A served hit now implies identical modules by construction, so the counter is the runtime canary that the fold is still reached — not dead code (Principle 7).
- **Producers may declare `descriptor.defines` / `definesHi`** (the globe does). Optional; omitting it leaves the key byte-identical to what it would otherwise be.
- Guard: `Tools/visual-regression/pipeline-key-aliasing.spec.mjs` — its STRUCTURAL group executes the real caches over every bit of the real `ShaderDefine` registry with markerless descriptor names; its MUTATION-FOLD group removes the fold from a copy of the engine source and requires the aliasing to come back.

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
- Root `Source/Cesium.js` is an auto-generated barrel re-export shim, and root `Source/Shaders/`, `Source/Assets/`, `Source/ThirdParty/` and `Source/Widgets/` are gitignored build output copied by `copyEngineAssets()` (`scripts/build.js:1321`)
- If a WGSL file exists in root `Source/Shaders/WebGPU/` but not in `packages/engine/Source/Shaders/WebGPU/`, it was created in the wrong place — move it to the canonical location

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
- **Co-located `.d.ts` for JS interop** (Session 29 pattern): When a TS file needs to interop with an untyped JS class, write a co-located `ClassName.d.ts` next to `ClassName.js`. TypeScript's `allowJs: true, checkJs: false` means a sibling `.d.ts` **overrides** JS inference for imports — no tsconfig changes needed. See `packages/engine/Source/Renderer/{Context,Texture,CubeMap}.d.ts` and `packages/engine/Source/Core/{Matrix4,Cartesian3,Color}.d.ts` as templates. For classes that match an existing ambient interface (e.g., `FrameState` ↔ `CesiumFrameState`), use declaration merging: `declare class X {} interface X extends AmbientShape {}`.
- **`@private` JSDoc ≠ TS `private`**: CesiumJS uses `@private` to mean "not in the published API" but TypeScript correctly interprets it as class-scoped visibility. If a JS method is called cross-module, either (a) declare it `public` in a co-located `.d.ts` (tactical), or (b) change the JSDoc tag to `@internal` (strategic — zero runtime change, preserves doc-strip intent while avoiding the TS visibility trap).
- **Never trim WIP-module interfaces during cast cleanup**: Some `CesiumGraphicsContext`-adjacent interfaces (e.g., `PerformanceManagerContext`) carry forward-looking method slots that aren't yet implemented on the real classes. The cast at the construction site bridges the gap intentionally. Don't delete interface methods just because grep shows no callers — verify the owning module is fully implemented first.
- **RxJS**: Prefer for reactive patterns and async operations over async/await, in production code and test pages alike — async/await is more error-prone in complex asynchronous flows. Compose with operators (`from()`, `switchMap()`, `mergeMap()`, `catchError()`). Reach for async/await only when performance requires it and that has been measured
- **Service Workers**: usable for asset caching / offline capability and background processing of large datasets — only where the benefit is significant and measured
- **Slang (optional)**: new WebGPU shaders may be authored in `.slang` under `packages/engine/Source/Shaders/Slang/` and compiled to WGSL into `Shaders/WebGPU/Generated/` via `node scripts/compileSlang.js`. The project builds without `slangc` installed. Prefer it for shaders that also need a GLSL twin and for prototyping; do NOT use it for performance-critical shaders needing WebGPU-specific tuning, for preprocessor chunk files, or to rewrite existing hand-written WGSL. Full documentation: `scripts/SLANG_GUIDE.md`

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

## WASM Strategy

- Every WASM function MUST have a JS fallback (bridge pattern)
- Feature detection before activation
- Async loading only — never block main thread
- Threshold-gated activation (avoid overhead for small workloads)
- All bridges must have `destroy()`, `free_buffer()`, version check, SIMD detection, and a `getDiagnostics()` reporting readiness, last-operation stats, and whether WASM or the JS fallback ran
- Never load WASM on a hot constructor path — loading is async; load opportunistically and use it when ready
- Use the arena allocator (`alloc_buffer`/`free_buffer`) for shared JS↔WASM memory; never let WASM allocate unbounded
- **Toolchain choice**: Rust (wasm-pack) for new performance-critical code we author, for memory-safety-sensitive index/SIMD work, and for modules that want generated `.d.ts`. Emscripten for wrapping existing C/C++ libraries (Draco, KTX2) or porting established C++ implementations
- **WASM or GPU compute**: WASM SIMD wins at low latency and small-to-mid batch sizes (frustum culling under ~50K, radix sort in the ~5K-50K range); GPU compute wins above that; plain JS wins below the threshold where dispatch overhead dominates. Profile before and after, and report the change with numbers
- **Threading is allowed** but needs `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Always ship a single-threaded fallback, detect `SharedArrayBuffer`/`Atomics` at runtime, use `std::sync::Mutex` (never `static mut`) for shared state, and keep the thread count configurable

---

## Comment & JSDoc Rules

- **Preserve ALL existing JSDoc comments** when modernizing files
- **Do NOT add new JSDoc** that didn't exist in the original
- **Do NOT add boilerplate** restating what code obviously does
- **DO add comments** explaining non-obvious WHY — rationale, edge cases, performance notes
- Match the surrounding file's comment density
- Converting a constructor or prototype to a class: drop `@constructor` and `@memberof Foo.prototype` (both implicit in a class body), move `@param` tags from the function-level JSDoc onto `constructor()`, and keep `@alias ClassName` on the class-level JSDoc — the documentation tooling depends on it
- Do not add `@param` annotations to a constructor unless the original function-level JSDoc had them

---

## Logging & Debug Pragmas — CRITICAL

CesiumJS has a pragma stripping system that removes debug-only code from
production builds with **zero runtime cost**. Our `stripPragmaPlugin`
(in `scripts/build.js`) now handles both `.js` and `.ts` files, so WebGPU
TypeScript diagnostics can use the same pattern as upstream JavaScript.

<!-- corrected 2026-09-05 from the doc-fitness audit G-33: the rule is engine-wide, the guard is not -->

The rule applies engine-wide, but the CI guard (`npm run lint-debug-pragmas`,
`Tools/lint-debug-pragmas.mjs`) only scans `packages/engine/Source/Renderer/WebGPU`
(277 of the engine's 1,508 `.js`/`.ts` files, measured 2026-09-05) — a violation
elsewhere in the engine is not caught mechanically.

<!-- ruling D11, 2026-09-05: carried from .clinerules §2d as a preference, not a MUST -->

Where a context is in hand, **prefer `context.log(level, message)`
(`GraphicsContext.ts:1961`) over a bare `console.*`** for renderer diagnostics, so the
context id reaches the message (Principle 3). This is a preference, not a MUST: the
pragma rules below still govern what gets wrapped, and `console.error` for a real error
stays exactly as this section describes it.

### When to wrap a log in pragmas

**ALWAYS wrap with pragma tags** when the log is any of:

- Per-frame or per-tile diagnostic (center3D, UV uniforms, pass counts)
- Init-time informational messages (feature detection, resource creation success)
- Informational `console.log` or `console.warn` that helps debugging but isn't a real error
- Any log with string interpolation, `.toFixed()`, object stringification, or other
  work that has runtime cost even if the user doesn't look at the console

```javascript
//>>includeStart('debug', pragmas.debug);
console.log(`[WebGPU:GlobeTile] center3D: (${center.x.toFixed(1)}, ...)`);
//>>includeEnd('debug');
```

### When to keep a log permanent (no pragma)

**NEVER wrap** a log that is any of:

- `console.error` that indicates a real bug producing broken output (null blit
  target, index buffer overflow, command buffer invalidation, device lost)
- Shader compile errors or pipeline creation failures
- Recovery attempt failures / retry exhaustion
- Clear loop detectors and other infinite-loop sentinels
- Any message the user NEEDS to see to diagnose a production problem

Real errors must always reach the console — that's how bugs get reported.

### Helper functions (pragma-aware predicates)

When a diagnostic is called from many sites, put the throttle logic in a
predicate method whose body is pragma-stripped. The method returns `false`
in production and the call sites become dead code that esbuild removes:

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

### Permanent sentinels to add for new subsystems

Every new renderer / pipeline subsystem SHOULD add these permanent checks:

1. **Re-entry / infinite loop guard** — counter in the per-frame entry point,
   `console.error` with throttle if it exceeds a sane limit
2. **Null target guard** — check source/destination texture views at render
   pass boundaries, `console.error` if null
3. **Size validation** — check buffer sizes vs index/vertex counts before
   submitting draw commands, `console.error` if overflow, clamp to safe value

These catch the failure modes of BUG-12 (clear loop), BUG-13 (null PP views),
and BUG-15 (index overflow) without needing deep debugging.

---

## Build & Test Commands

```bash
npx gulp build              # Full build (includes WGSL compilation)
npx gulp buildRelease        # Production build (minified + unminified)
npx tsc --noEmit             # TypeScript type checking
npm run build-wasm           # WASM release build
npm run build-wasm-debug     # WASM debug build
npm run restart              # Rebuild + restart dev server (user-preferred over raw gulp)
npm test                     # Run Jasmine test suite
```

### Build Variants (Tree-Shaking)

Three bundle variants are available to reduce download size when only one backend is needed:

```bash
npx gulp buildCesiumDual          # Both backends, WebGPU-first default (historical Build/Cesium)
npx gulp buildCesiumWebGPUOnly    # WebGPU only — GLSL shaders aliased to empty stubs
npx gulp buildCesiumWebGLOnly     # WebGL only — WebGPU renderer aliased to empty stubs
npx gulp buildAllVariants         # All three side-by-side (engine+widgets built once)
```

**Output directories:**

- `Build/Cesium{Unminified}` — dual (default, backwards-compatible)
- `Build/CesiumWebGPU{Unminified}` — WebGPU-only (GLSL shaders → empty stubs)
- `Build/CesiumWebGL{Unminified}` — WebGL-only (WebGPU renderer + WGSL → empty stubs)

<!-- corrected 2026-09-05 from the doc-fitness audit G-07 (D10 factual, card M5): absolute figures go stale — point at the dated measurement instead -->

**Measured sizes:** see [`BUILD_AND_VARIANTS.md`](migration_doc/BUILD_AND_VARIANTS.md) §2
("Build Variants" → "Measured sizes") for the variant-size table. That section is itself
pinned to Batch 506 and flagged `status: verify — STALE` there, with a
`npx gulp buildAllVariants` re-measure recipe. Do not restate absolute MB figures here;
they go stale exactly as the table that used to sit in this spot did.

The webgl-only drop is larger because it strips the entire `Source/Renderer/WebGPU/` directory plus every WGSL shader string module. The webgpu-only drop is smaller because it only strips the GLSL shader-string leaves — the WebGL backend classes (`Context`, `ShaderProgram`, `Texture`, etc., all under `Source/Renderer/`) still get pulled in by Scene files' static imports. See [`BUILD_AND_VARIANTS.md`](migration_doc/BUILD_AND_VARIANTS.md) §2 for current file/LOC/shader counts and the re-measure recipe; do not restate absolute counts here. <!-- corrected 2026-09-05 from the doc-fitness audit G-07 (D10 factual): this paragraph said "103 files, ~45K LOC" / "67 WGSL modules" / "191 GLSL leaves" against 271 top-level (277 recursive) renderer files, 324 .wgsl and 330 .glsl measured at HEAD 2026-09-05 — stale by 1.7-4.8x -->

**How the variant wiring works:**

- The variant alias plugin (`scripts/bundleVariantPlugin.js`) intercepts import resolution via esbuild's `onResolve` hook. In `webgpu-only` builds, every `Source/Shaders/*.js` path (except `Source/Shaders/WebGPU/`) is redirected to `scripts/stubs/emptyShader.js` (a `export default ""`). In `webgl-only` builds, files under `Source/Renderer/WebGPU/**` and `Source/Shaders/WebGPU/**` are redirected to `scripts/stubs/emptyModule.js` (a Proxy that throws on any non-introspection access).
- Scene files do NOT need modification — their static `import GlobeFS from '../Shaders/GlobeFS.js'` imports resolve to the stub, and the WebGPU feature renderer pattern ensures the WebGL code path that would consume `GlobeFS` is never reached when the WebGPU backend is active.
- The dual build enables ESM code splitting so `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` stays dynamic — WebGPU code lands in a separate `chunks/WebGPUContext-*.js` chunk and only downloads when `renderer: 'webgpu'` (or `AUTO` resolving to WebGPU) is picked.
- The IIFE (`Cesium.js`) and CJS (`index.cjs`) formats don't support code splitting, so their WebGPU code is inlined regardless of variant — the alias plugin is what actually shrinks them.

**Compat-surface exemption list (CRITICAL for future renderer work):**

Some files under `Source/Renderer/WebGPU/` are **backend-neutral** — they're consumable from webgl-only builds even though they live in the WebGPU directory. These are listed in `WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js` and are NOT redirected to empty stubs. Read the list at the source — `scripts/bundleVariantPlugin.js:276-286` (5 entries as of 2026-09-05; applied by `isWebGPUFile` at `:296` via the loop at `:310`) — rather than trusting a prose copy. <!-- corrected 2026-09-05 from the doc-fitness audit (D10 factual): this sentence carried a stale four-entry copy that omitted WebGPUModelMetadata, added at :281-285 -->

**When adding a new file under `Source/Renderer/WebGPU/`** that exports a backend-neutral API (e.g., an extended shader translator, a new pluggable registry), add its path to `WEBGPU_COMPAT_EXEMPTIONS`. The file's runtime code paths must be safe to execute in a webgl-only bundle (lazy-load any WebGPU deps, don't throw at module load).

**Runtime default renderer:** controlled by `setGlobalDefaultRenderer()` in `RendererType.ts`. Each variant's entry barrel (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`, `Source/CesiumWebGPUOnly.js` — generated by `createCesiumJs(variant)`) calls this at module init so the `AUTO` renderer selection picks the right backend by default. Users can still override per-`Viewer` via `contextOptions.renderer`.

**Side-effects declaration (CRITICAL):** The root `package.json` declares `"./Source/Cesium*.js"` as side-effectful so bundlers don't tree-shake the `setGlobalDefaultRenderer()` call out of the variant entry barrels. Never remove that line without replacing it with a different mechanism for the default-renderer hint.

**Smoke test:** `node Tools/variant-smoke-test.mjs` loads each variant's `index.html`/`Cesium.js` in Playwright, asserts no console errors, and verifies a frame renders. Run it after any change that touches the variant plugin, the exemption list, or the entry-barrel generation.

### Visual Regression Testing

```bash
node Tools/visual-regression/capture-and-diff.mjs              # Run all scenes
node Tools/visual-regression/capture-and-diff.mjs --update      # Save new baselines
node Tools/visual-regression/capture-and-diff.mjs --scene globe-default --headed
```

Captures WebGL vs WebGPU canvases from the split-screen page, pixel-diffs them, outputs PNG diffs + JSON report. Uses Edge by default. Zero external deps. See `Tools/visual-regression/README.md`.

### Playwright / Browser Testing

- **Use Edge (Chromium), NOT Firefox** — Playwright's Firefox (Nightly) does NOT have WebGPU enabled; release Firefox does but Playwright bundles Nightly
- WebGPU viewer URL: `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`
- Split-screen URL: `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html`
- `window.viewer` is exposed on the CesiumViewer page for console debugging
- `window.webglViewer` / `window.webgpuViewer` are exposed on the split-screen page
- Use `viewer.scene.getDebugSnapshot()` and `viewer.scene.logDebugSnapshot()` for diagnostics
- The WebGPU renderer REQUIRES the post-process pipeline to blit the scene framebuffer to the canvas — `usePostProcess` must always be true for WebGPU (unlike WebGL which can render directly to the canvas)

---

## GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no
`git push`, no visible GitHub activity of any kind.** Commits carry visible
timestamps even if pushed later, so do not commit during the window either —
hold work as uncommitted worktree state / exported patches and land in
batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check
`date` before every commit/push; the machine clock is authoritative.
Local-only work (builds, probes, workers, edits) is unaffected.

### 10. Brief From Verified Premises — CRITICAL

An unverified premise does not stay contained. It propagates into the fix **and** into the test that
was supposed to catch it.

On 2026-08-20 three of four worker briefs asserted a symptom the code did not exhibit. The briefs
were written from audit findings without re-reading the cited code. Each worker implemented its
brief faithfully, then wrote a spec that certified **the brief** rather than the behaviour — so the
spec went green over a false premise. One fix addressed a defect that was not there and introduced a
WebGL performance regression on a backend that had no bug.

**Before you brief work — for a subagent, or for yourself:**

- **If you cite `file:line`, read those lines now.** An audit finding, a queue row, or a prior
  session's note is a LEAD, not a premise. Findings age; code moves.
- **State the observable behaviour to assert, never the implementation shape.** "Assert a second
  query re-queries after a completed readback" is checkable against reality. "Assert the cache no
  longer stores `undefined`" only checks that the instruction was followed.
- **A spec written from the same brief as the fix is not an independent check.** It inherits the
  brief's errors. Independence requires a different source — the behaviour itself, or a different
  reviewer.
- **Mutate for inertness, not just absence.** Deleting code is the easy mutation and most specs
  survive it. Make the fix _unreachable_ — `if (false && …)` — and see whether the spec still passes.
  A spec that greps source asserts text shape, not that the branch is live.

Verification has three tiers and each catches a class the others cannot: mechanical checks (does it
run, is it in scope), substantive review (is the code correct), and **independent re-derivation of
the premises**. Only the third catches a false diagnosis. A green mechanical check means "ready for
review", never "correct".

Subagent dispatch mechanics, the worker rules and the full evidence live in
[migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)
§8a–§8c. This principle is the part that applies whether or not a subagent is involved.

---

**Proof bar by change class (maintainer ruling R-2026-08-29-1):** engine, parity and shader changes keep
the full bar (behaviour spec + inertness mutant + separate review + the named Edge leg). Tools changes
carry a spec only where there is logic worth pinning AND an npm runner home. Docs, comments and demo
text carry review plus one capture where visual - no spec. A spec with no runner home is a review
blocker. Where a probe can measure the feature directly, the probe is the acceptance.

**Wave-end gate (R-2026-08-29-2):** every multi-batch wave closes with the variant smoke test, the
Sandcastle2 sweep on both renderers and the visual-regression capture-and-diff (baselines refreshed
deliberately, each refresh its own reviewed commit), run by an Edge executor and banked under
`Tools/visual-regression/output/wave-end/<wave>/`. Not per batch; the wave does not close without it.

## Branch Transparency — CRITICAL

**Worker branches, clones and the handoff procedure:** see
[migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).
Workers get **clones, not worktrees** (a worktree's `.git` is a file pointing into the
orchestrator's `.git`, so a sandboxed worker cannot be given commit rights safely), landings are
**squash-only** (merge commits skip landing rules), and every dispatch begins with a capacity
preflight. The obligations below still apply in full.

**Worker naming (maintainer directive 2026-08-29):** every dispatched worker, reviewer, executor
and scoping agent is named after a Tolkien character, uniquely, and that name is the lane's
identity in the Agent description, the clone directory, the packet, the ledger and every status
line. The Fable seat is Gandalf. Registry + role pools: the seat's memory
`feedback_tolkien_worker_names.md`; convention: [WORKER_ISOLATION_AND_BRANCH_HANDOFF.md 8e](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).

The user's working model is "trunk-only — no long-lived branches." Surface branch state proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety branches, worktree branches, or agent branches accumulate silently.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main` ("Heads-up: `pre-upstream-merge`, `feature/foo` are still around from prior work — want me to audit and clean before starting?"). Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion plan ("I'll create `safety-pre-batch-69-2026-04-26` as a rollback ref; I'll delete it after the batch lands on main and verifies green").
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main` (and its remote tracker), open with a one-liner inventory.

Use the `C:\Users\Kurt\.claude\projects\f--Dev-GH-cesium-webgpu\memory\feedback_git_stash.md` git-stash conventions when labeling refs (timestamped, descriptive).

---

## Evidence Repatriation - CRITICAL (maintainer rule, 2026-08-21)

When finishing out a local branch, worker clone, or worktree, copy any
high-quality visual evidence it produced (probe PNGs, pixel-diff images,
capture reports) back into the main repo's gitignored
`Tools/visual-regression/output/` folder, preserving the probe's own
subdirectory layout, BEFORE resetting or deleting the clone.
Certification-grade artifacts additionally bank in
`f:/Dev/GH/cesium-webgpu-visual-evidence` (immutable) as before. Evidence
that dies with a clone reset is a handoff defect.

---

## Upstream Sync Procedure

This fork tracks `https://github.com/CesiumGS/cesium` as `upstream`.

1. Create safety branch: `git branch pre-upstream-merge main`
2. Fetch upstream: `git fetch upstream main`
3. Check divergence: `git rev-list --count main..upstream/main`
4. Merge: `git merge upstream/main --no-edit`
5. Resolve conflicts — for ES6-class fork files (e.g. `ClippingPolygon.js`, `Scene.js`, `ShaderBuilder.js`, `CreditDisplay.js`), never `git checkout --theirs`: it reverts the fork's ES6 class conversion, and "re-add WebGPU code" does not repair that damage. Start from the fork's `ours` (ES6 class) and port upstream's semantic changes into it; verify with `npm run verify-es6-shape` (`Tools/upstream-shape-guard.mjs`). See `UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md` §3 for the measured conflict census (36 of the sync's 79 conflict hunks, 46%, are this exact mechanism). <!-- corrected 2026-09-05 from the doc-fitness audit G-25 (D10 factual): --theirs was retracted by the measured 1.145 sync -->
6. Verify two-parent merge commit: `git cat-file -p HEAD` must show TWO parents. If `MERGE_HEAD` was lost during conflict resolution, rebuild it — `git commit-tree $(git rev-parse "HEAD^{tree}") -p <our-commit> -p <upstream-commit> -m "<message>"`, then `git reset --hard` onto the result
7. Push: `git push origin main --force-with-lease`

Prerequisites: `upstream` points at `https://github.com/CesiumGS/cesium.git` and `origin` at this fork.

After the merge: review `CHANGES.md` for upstream features needing WebGPU equivalents; diff `packages/engine/Source/Scene/` and the GLSL shaders against the merge base for new rendering features that need a WGSL twin; run `npm install` for new dependencies; and record the new features and their WebGPU status in `migration_doc/WEBGPU_MIGRATION_STATUS.md`.

Conflicts concentrate in the upstream files the fork modifies — Scene files carrying WebGPU routing (`Scene.js`, `Primitive.js`, `PointPrimitiveCollection.js`, `SkyBox.js`, `View.js`), the build system (`scripts/build.js`, `gulpfile.js`), `package.json`, and the widget entry points. Files that exist only in this fork (`Renderer/WebGPU/`, `Shaders/WebGPU/`, `Apps/WebGPUTest/`) never conflict.

---

## Debugging Documentation

When fixing bugs, document in `migration_doc/WEBGPU_DEBUGGING_LOG.md`:

- Bug number (Session.Bug format)
- File(s) affected
- Root cause description
- Fix applied
- Files modified

---

## Key Reference Files

- `.clinerules` — the fork's original Cline rules file. **It is no longer a rules authority**: as of this batch its body is a pointer to this file, which is the tracked rules authority. Precedence between the tracked governance documents is set by `EXECUTOR_LANE_CHARTER_2026-08-14.md` §0.4, not here. <!-- D3, 2026-09-05: demoted from "source of truth"; rules carried over in the same batch -->
- `migration_doc/WEBGPU_MIGRATION_STATUS.md` — Overall migration progress (historical for the coverage gap 2026-05-30 → 2026-08-06 per `README.md:214`; batch numbers are non-monotonic — trust dates/hashes)
- `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — Historical (body stops ~Batch 64 per `README.md:217`); the execution frontier is the live campaign queues, not this file <!-- corrected 2026-09-05 from the doc-fitness audit G-05(d) (D10 factual): both rows were presented as current -->
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Chronological bug log (search before debugging a new artifact)
- `migration_doc/DEBUGGING_GUIDE.md` — **Single entry point for debugging tools + procedures.** Decision tree, CesiumDebug command catalog, probe inventory, WGSL pragma patterns. **MUST be kept in sync whenever you add a new CesiumDebug command, probe, or globe-fragment debug mode.** A guide that drifts becomes worse than no guide.
- `migration_doc/README.md` — **Index of all migration docs (LIVE vs ARCHIVED).** Start here; trust it over any single doc's self-description.
- `migration_doc/ARCHITECTURE_REVIEW_2026-09-02.md` — Current feature-renderer / wiring / architecture / maintainability review (the 2026-04-30 audit trio it supersedes moved to `migration_doc/archive/audits-2026-04-30/` on 2026-09-03, Batch 1403; findings migrated into its §3 and §3.11) <!-- corrected 2026-09-05 from the doc-fitness audit G-05(a) (D10 factual): the old glob resolved to zero files -->
- `migration_doc/IMAGERY_PROJECTION.md` — Single source of truth for imagery-layer projection across WebGL + WebGPU. **MUST be kept in sync whenever you touch any file in the projection chain** (`*ImageryReprojection*`, `GlobeFS.glsl`, `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `WebGPUGlobeSurfaceCameraUB.ts`, `ImageryLayer.js`, `ImageryLayerHelpers.js`). A drift between this doc and code is a worse bug than the projection bug itself.
- `packages/engine/Source/Renderer/WebGPU/` — All WebGPU renderer code (for a file count see [`BUILD_AND_VARIANTS.md`](migration_doc/BUILD_AND_VARIANTS.md) §2 for a dated measurement and re-measure recipe; do not quote an absolute here — "83+" was stale by 3.3x against the 271/277 measured 2026-09-05)
- `packages/engine/Source/Shaders/WebGPU/` — All WGSL shaders (for a shader-module count see [`BUILD_AND_VARIANTS.md`](migration_doc/BUILD_AND_VARIANTS.md) §2; "67+" was stale by 4.8x against the 324 measured 2026-09-05) <!-- corrected 2026-09-05 from the doc-fitness audit G-07 (D10 factual) -->

## Debug Console Commands

Quick reference. **Full procedures + probe inventory: [migration_doc/DEBUGGING_GUIDE.md](migration_doc/DEBUGGING_GUIDE.md).**

- CesiumDebug.help() — list all commands
- CesiumDebug.snapshot() — full debug snapshot
- CesiumDebug.showDepth() — depth buffer as grayscale
- CesiumDebug.showWireframe() — globe wireframe overlay
- CesiumDebug.showFrustums() — colorize frustum splits
- CesiumDebug.showCommands() — command count overlay
- CesiumDebug.toggleFPS() — FPS counter
- CesiumDebug.pipelineStatus() — shader/pipeline/device health check
- CesiumDebug.postProcess() — post-process pipeline state table
- CesiumDebug.cpuPassCost(t/f) — per-pass CPU profile (R-7a)
- CesiumDebug.gpuPassCost(t/f) — enable/reset, dump, or disable per-pass GPU timing
- CesiumDebug.highDensityCull() — gpuCuller / HiZ / sort-keys stats
- CesiumDebug.globeBindGroups() — globe bind-group cache stats (Batch 241)
- CesiumDebug.cacheStats() — pipeline + bind-group cache counters (Batch 741)
- CesiumDebug.webgpuOIT(on?) — read/toggle the FAR-003 WebGPU MRT OIT containment flag (requested-vs-active)
- CesiumDebug.canvasPixels() — sample canvas pixel data
- CesiumDebug.logImageryProbe() — dump next 4 tile updates
- CesiumDebug.tileDebugOverlay() — overlay rich per-tile labels (L/X/Y, rectangle, projection, Mercator-limit edge)
- CesiumDebug.globeFragmentDebug(name) — visualize one stage of the globe FS (mode table in the guide)
- CesiumDebug.scene / .context / .device — direct accessors
