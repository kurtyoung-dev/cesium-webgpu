# Next Session Handoff — 2026-04-14

**Purpose:** Self-contained context for the next session after a context compaction. Read this file first; it has every code pointer, design reference, and concrete next step needed to continue without re-discovering anything.

**Current branch:** `main`
**Last commit:** `82bc2c915c` — Session 29: typing follow-up + migration doc sweep
**`tsc --project packages/engine/tsconfig.json --noEmit`:** clean (0 errors).
**`npx gulp build`:** clean (38s).
**Pre-commit hook:** now running cleanly (lint-staged + eslint + prettier completed on the full commit).

**Also in Session 29:** external engine feature survey (NullGraph, ChartGPU, Hypercube-Compute, Taichi.js, Vello, Zephyr3D, RedGPU, Unity WebGPU, Orillusion). Results landed in `WEBGPU_MIGRATION_BACKLOG.md` as **Phase 7 — External Engine Feature Survey**, with 48 items (FEAT-SURVEY-01 through FEAT-SURVEY-48) tiered by effort × ROI.

**Architectural synthesis — most important Session 29 deliverable:** [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) unifies Phase 7 + a 3D Tiles implementation audit + 3D Tiles 2.0 spec research into a coherent architectural frame. Identifies the central insight (**"GPU-resident octree tile cache"**), the gating shader-variant architectural decision that blocks ~30% of Phase 7 items, the full dependency DAG across ~80 items, tech debt + perf + WASM + compute opportunities specific to 3D Tiles, a recommended 5-phase roadmap (8a Foundation → 8b GPU-resident stack → 8c Visual quality → 8d Advanced → 8e Differentiators), and (§3.5) the **DOD Storage Layer** clarification — Phase 8b's six items aren't independent features but one coherent data-oriented storage architecture with Cesium API facades, equivalent in pattern to Unity's Resident Drawer. **Read this before starting any rendering or 3D Tiles work.**

---

## What landed in Session 29 — Typing Push (2026-04-14)

Complete elimination of the lazy `as unknown as` escape hatches at the JS↔TS boundary by adding co-located `.d.ts` declaration files for CesiumJS JS classes that cross into WebGPU TypeScript code.

### Headline numbers

| Metric | Start | End | Delta |
| --- | --- | --- | --- |
| `as unknown as` in `Renderer/` | 57 | 19 | **-67%** |
| `Record<string, unknown>` casts | 12 | 11 | -8% |
| Stale `@ts-expect-error` directives | 8 | 0 | -100% |
| Co-located `.d.ts` files | 0 | 13 | +13 |
| TS build errors | 0 | 0 | clean |
| Gulp build time | 44s | 38s | -14% |

### New `.d.ts` files (13)

All co-located with their JS source so TypeScript picks them up without any tsconfig changes. Each overrides the JS inference with properly-typed public API declarations.

**Core:**

- [Matrix4.d.ts](packages/engine/Source/Core/Matrix4.d.ts) — plain ES6 class (NOT a Float64Array subclass), 16 numeric-indexed slots, ~60 static methods
- [Cartesian3.d.ts](packages/engine/Source/Core/Cartesian3.d.ts) — instance + ~40 statics, frozen constants
- [Color.d.ts](packages/engine/Source/Core/Color.d.ts) — instance, ~25 statics, 140+ CSS named color constants
- [EncodedCartesian3.d.ts](packages/engine/Source/Core/EncodedCartesian3.d.ts) — smallest file, validated the pattern first
- [BoundingRectangle.d.ts](packages/engine/Source/Core/BoundingRectangle.d.ts) — exports `BoundingRectangleLike` shape for loose assignability

**Renderer:**

- [UniformState.d.ts](packages/engine/Source/Renderer/UniformState.d.ts) — matches ambient `CesiumUniformState` shape; ~40 readonly fields
- [PassState.d.ts](packages/engine/Source/Renderer/PassState.d.ts)
- [ShaderCache.d.ts](packages/engine/Source/Renderer/ShaderCache.d.ts)
- [PickId.d.ts](packages/engine/Source/Renderer/PickId.d.ts)
- [Context.d.ts](packages/engine/Source/Renderer/Context.d.ts) — ~40 capability getters, clear/draw/readPixels, viewport quad helpers. Declares `readPixels`/`readPixelsToPBO` as **public** to override `@private` JSDoc (those methods are called cross-module from Scene layer)
- [Texture.d.ts](packages/engine/Source/Renderer/Texture.d.ts)
- [CubeMap.d.ts](packages/engine/Source/Renderer/CubeMap.d.ts) — six face accessors, FaceName enum, static helpers

**Scene:**

- [FrameState.d.ts](packages/engine/Source/Scene/FrameState.d.ts) — uses **interface merging** with the ambient `CesiumFrameState` to reuse all field declarations without duplication:
  ```ts
  declare class FrameState { constructor(...); }
  interface FrameState extends CesiumFrameState {}
  ```

### Accompanying refactors

- **`isDestroyed` getter → method** in `GraphicsContext.ts` + `WebGPUContext.ts` + 1 call site in `WebGPUBuffer.ts`. Upstream `destroyObject.js` overwrites `.isDestroyed` with a `returnTrue` function — a getter can't be overwritten that way. Method form matches upstream convention and fixes all 40+ call sites. WebGPU-side classes that use getter-form `isDestroyed` elsewhere (WebGPUBuffer, WebGPUTexture, etc.) were left alone since they don't flow through `destroyObject.js`.
- **`CesiumMatrix4` type fixed** — was `Float64Array & { 0..15; clone; ... }` (intersection), changed to plain structural interface. `Matrix4` is a plain ES6 class, NOT a `Float64Array` subclass; the old intersection was a lie that required casts at every boundary. Matrix4 now flows through WebGPU code without any cast.
- **`GraphicsContextOptions.getWebGLStub`** narrowed from the banned `Function` type to `(canvas, webglOptions) => WebGLRenderingContext | WebGL2RenderingContext`.
- **`CesiumAnyDrawCommand.boundingVolume`** widened from strict `CesiumBoundingSphere` to an optional-fields shape (`center?`, `radius?`, `boundingSphere?`). JS-sourced `DrawCommand` instances have their `boundingVolume` inferred as `{}`; the only WebGPU reader at `WebGPUSceneRenderer.ts:2142` already null-checks `bv.center` before dereferencing.
- **WebGPU dispatcher signatures** (`WebGPUGPUSortKeysDispatcher`, `WebGPUHiZOcclusionDispatcher`) widened parameter types from `{ device: GPUDevice }` to `{ device: GPUDevice | null | undefined }` to match WebGPUContext's nullable `device` getter. Internal null-checks were already present.
- **Feature renderer interface** (both `CesiumFeatureRenderer` in ambient + `FeatureRenderer` in `GraphicsContext.ts`) documents the lazy-construction pattern: optional `RendererClass: new(ctx) => object` + `_instance: object`.
- **Sidecar cache types** made explicit — `_ssrCache`, `_cloudCache`, `_weatherCache`, `_webgpuCache` on `CesiumGraphicsContext` / `CesiumPostProcessStageCollection` now reference real interfaces via `import("./...").TypeName` rather than `unknown`. Each effect module now `export`s its cache interface.
- **`CesiumGraphicsContext.uniformAllocator`** and **`_computeCommandClass`** typed at source, eliminating ad-hoc `as unknown as { ... }` narrowing.
- **4 Scene `.js` files** — removed 8 stale `@ts-expect-error` directives that became obsolete (TS2578) once the `.d.ts` files fixed the underlying type errors they suppressed.

### Notable discoveries during this session

See [WEBGPU_DEBUGGING_LOG.md § "Session 29"](WEBGPU_DEBUGGING_LOG.md) for full writeups:

- **`@private` JSDoc != TS `private`** — CesiumJS uses `@private` to mean "not part of the published API surface" (upstream convention, predates TS tooling). TypeScript correctly interprets `@private` as class-scoped visibility, which **breaks structural subtyping** between `Context` (has `@private readPixels`) and `GraphicsContext` (has `public abstract readPixels`). The right upstream fix is `@internal`; our fix was a co-located `.d.ts` that declares everything public.
- **`CesiumMatrix4 = Float64Array & {...}`** — the ambient type was a lie that forced casts at every boundary.
- **`isDestroyed` protocol drift** — GraphicsContext abstract declared it as a getter, WebGPUContext implemented it as a getter, but `destroyObject.js` overwrites it with a function property — any caller passing these through `destroyObject()` would encounter a TypeError at runtime (latent bug, not yet observed in production because WebGPUContext isn't passed through `destroyObject`).

### Files touched this session (29 modifications + 13 new)

**New .d.ts files (13):** see section above.

**Modified (16):** cesium-js-types.d.ts, GraphicsContext.ts, WebGPUContext.ts, WebGPUFeatureRenderers.ts, WebGPUGlobeSurfaceRenderer.ts, WebGPUPerformanceManager.ts, WebGPUHiZOcclusionDispatcher.ts, WebGPUPostProcessStageCollection.ts, WebGPUSceneRenderer.ts, WebGPUPickFramebuffer.ts, WebGPUBuffer.ts, WebGPUTexture.ts, WebGPUVolumetricFogRenderer.ts, WebGPUGPUSortKeysDispatcher.ts, ContextFactory.ts, WebGPUSSREffect.ts, WebGPUProceduralCloudRenderer.ts, WebGPUWeatherRenderer.ts, renderBufferPointCollection.js, renderBufferPolygonCollection.js, renderBufferPolylineCollection.js, plus misc Scene `@ts-expect-error` cleanup.

---

## Remaining work toward a fully well-typed codebase

The typing push reduced `as unknown as` by 67% but meaningful work remains. This section is **the authoritative backlog for typing work** — copy items into an in-session TodoWrite list when you pick them up.

### A. Legitimate remaining `as unknown as` casts (17 in source, 2 in centralized helpers)

These are **not candidates for removal**. They document real design gaps or centralized escape hatches. Listed here so future sessions don't waste time attacking them without first fixing the underlying issue:

| Site | Why it exists | Real fix (if any) |
| --- | --- | --- |
| [webgpuTypeHelpers.ts:70,115](packages/engine/Source/Renderer/WebGPU/webgpuTypeHelpers.ts) | Centralized `gpuData()` + `numericArray()` helpers — **the whole point is consolidation**. | Leave as-is. |
| [WebGPUContext.ts:1948](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L1948) | `drawCommand.execute(renderPassEncoder as CesiumGraphicsContext)` — WebGPU-specific protocol overload where `execute()` receives a render pass encoder instead of a context. | Overload `CesiumDrawCommand.execute()` with `(ctx: CesiumGraphicsContext \| GPURenderPassEncoder)` union. Medium effort. |
| [WebGPUContext.ts:3468](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L3468) | `new WebGPUPerformanceManager(this as ConstructorParameters<...>[0])` — **WIP module**; `PerformanceManagerContext` interface has forward-looking slots (`appendDraw`, `buildAndSubmit`, etc.) not yet implemented on the real classes. **Do not trim the interface**. | Complete the WebGPUPerformanceManager implementation. |
| [WebGPUFramebufferManager.ts:59](packages/engine/Source/Renderer/WebGPU/WebGPUFramebufferManager.ts#L59) | `GPUTextureUsage.TRANSIENT_ATTACHMENT` — forward-compat probe for a future WebGPU spec bit. | Leave as-is until the spec bit ships in `@webgpu/types`. |
| [GraphicsContext.ts:409](packages/engine/Source/Renderer/GraphicsContext.ts#L409) | Dynamic method introspection (`typeof (this)[method] !== "function"`). | Leave as-is; intentional dynamic dispatch in the validation layer. |

### B. Remaining `as unknown as` casts that CAN be removed (10)

Ranked by estimated effort × payoff.

| Site | What it does | Fix | Effort |
| --- | --- | --- | --- |
| [WebGPUContext.ts:2060, 2065, 2491](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L2060) — 3 casts | Narrows `readState.framebuffer` to `WebGPURenderTargetLike` / `{ _colorTextures?: ... }` for readPixels paths. | Widen `CesiumReadState.framebuffer` to a union including `WebGPURenderTargetLike` so narrowing uses `in` operator. | ~30 min |
| [WebGPUContext.ts:3518](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L3518) — `pm as { getFrameTimings?: () => object }` | Optional-method probe on `_performanceManager`. | Add `getFrameTimings?()` to PerformanceManager class. | 5 min |
| [SharedResourcePool.ts:267, 270](packages/engine/Source/Renderer/SharedResourcePool.ts) — 2 casts | `TypedArrayConstructor.BYTES_PER_ELEMENT` / `.prototype.BYTES_PER_ELEMENT` probe. | Type `TypedArrayConstructor` as the union `Uint8ArrayConstructor \| ... \| Float32ArrayConstructor` which all have `BYTES_PER_ELEMENT` in lib.d.ts. | ~15 min |
| [loadCubeMapWebGPU.ts:85](packages/engine/Source/Renderer/WebGPU/loadCubeMapWebGPU.ts#L85) — `url as { url: string }` | String vs object URL narrowing. | Use `typeof url === "object" && "url" in url` type guard. | 5 min |
| [WebGPUVertexArrayFacade.ts:52](packages/engine/Source/Renderer/WebGPU/WebGPUVertexArrayFacade.ts#L52) — `ComponentDatatype as ComponentDatatypeFull` | ComponentDatatype has methods not declared in the JS source. | Write `ComponentDatatype.d.ts` with the static API. | ~30 min |
| [Stubs/WebGLStubShader.ts:150](packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubShader.ts#L150), [Stubs/WebGLStubTexture.ts:692, 694](packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts#L692) — 3 casts | WebGL-only-build stubs. | Stubs are dead in WebGPU-only builds; low priority. If WebGL stubs are used in production, give them typed interfaces. | ~1 hour |

**Estimated total effort to drop from 19 to ~5:** 2-3 hours. The 5 legitimate survivors in group A stay.

### C. Pending `.d.ts` targets — high-value JS classes not yet covered

Writing a `.d.ts` for each eliminates multiple casts and `Record<string, unknown>` sites downstream. Ranked by downstream payoff.

| Target | Why high-value | Eliminates |
| --- | --- | --- |
| **DrawCommand.d.ts** | Used pervasively; every `frameState.commandList.push(...)` assignment touches it. Would tighten `CesiumAnyDrawCommand.boundingVolume` back to strict `CesiumBoundingSphere`. | ~8-12 cascading cast sites |
| **BoundingSphere.d.ts** | Hot path for all bounding-volume math; currently flows as `{}` from JS. | 4-6 `as CesiumBoundingSphere` narrowings |
| **Ellipsoid.d.ts** | Touched by globe surface, atmosphere, orbital math. | 3-5 sites |
| **RenderState.d.ts** | Passed through draw command machinery. | Unlocks tightening of `CesiumOpaqueRenderState` to real type |
| **ShaderProgram.d.ts** | Referenced through ambient `CesiumOpaqueShaderProgram`; tightening it would cascade into the `ShaderCache` return types. | 4 sites |
| **VertexArray.d.ts** + **Buffer.d.ts** | Draw command machinery; currently typed as opaque. | Unlocks `CesiumOpaqueVertexArray` tightening |
| **ContextLimits.d.ts** | Pure-statics module; typing the static surface unlocks several dispatchers' limit probes. | ~2 sites |
| **ComponentDatatype.d.ts** | See group B above. | 1 site |
| **IndexDatatype.d.ts** | Used by WebGPU index buffer construction. | ~3 sites |
| **Sampler.d.ts** | Already referenced in Texture.d.ts / CubeMap.d.ts as imported type; needs its own `.d.ts`. | Preempts future casts |

**Estimated total effort:** ~4-6 hours across all ten. Pattern is established (see Context.d.ts, Texture.d.ts, CubeMap.d.ts as templates).

### D. Pending ambient interface tightenings (cesium-js-types.d.ts)

The ambient declaration file has several opaque types that could become real types once the corresponding `.d.ts` files land (Group C above).

```ts
// Current: opaque
type CesiumOpaqueTexture = CesiumOpaqueObject;        // → Texture (pending Texture.d.ts — DONE)
type CesiumOpaqueFramebuffer = CesiumOpaqueObject;    // → Framebuffer (pending Framebuffer.d.ts)
type CesiumOpaqueVertexArray = CesiumOpaqueObject;    // → VertexArray
type CesiumOpaqueShaderProgram = CesiumOpaqueObject;  // → ShaderProgram
type CesiumOpaqueShaderSource = CesiumOpaqueObject;   // → ShaderSource
type CesiumOpaqueRenderState = CesiumOpaqueObject;    // → RenderState
```

Each tightening opens additional cast-removal opportunities in WebGPU consumer code.

### E. `Record<string, unknown>` vestiges (11 remaining)

- [GraphicsContext.ts:619](packages/engine/Source/Renderer/GraphicsContext.ts#L619) — `abstract get cache(): Record<string, unknown>` — should be a branded cache interface per-subsystem
- [GraphicsContext.ts:865, 953, 964, 1000](packages/engine/Source/Renderer/GraphicsContext.ts) — `createTexture/createBuffer/getRendererStatistics` take/return `Record<string, unknown>` — should use concrete option types
- [OffscreenContextSupport.ts](packages/engine/Source/Renderer/OffscreenContextSupport.ts) — worker message payloads; these are legitimately heterogeneous so `Record<string, unknown>` is arguably correct
- [WebGPU/Stubs/*](packages/engine/Source/Renderer/WebGPU/Stubs/) — WebGL-only-build stubs; dead code in WebGPU-only builds

Estimated effort to address the non-stub sites: ~2 hours.

### F. `: unknown` in parameters / return types (~100 in Renderer/)

These are variable-type annotations (vs the `as unknown as` casts addressed in groups A/B). Fixing them requires case-by-case judgment: many are genuinely heterogeneous (`owner: unknown` on DrawCommand), others are laziness that would benefit from a real type. Suggested approach: triage by file, start with the files where `.d.ts` work has already narrowed adjacent types.

### G. Upstream `@private` → `@internal` sweep

Cesium's `@private` JSDoc is used to mean "not part of the published API" — semantically closer to TypeScript's `@internal`. Current state: TypeScript correctly enforces `@private` as class-scoped visibility, which forces `.d.ts` overrides at every cross-module boundary.

**Recommended sweep:** Replace `@private` → `@internal` on every JS method that's actually called cross-module. A `@internal` tag is stripped by API-extractor tools the same way `@private` is, preserving Cesium's doc-generation intent. Once done, many `.d.ts` files (`Context.d.ts`, `Texture.d.ts`, `CubeMap.d.ts`) become redundant and can be removed.

**Estimated effort:** ~2-3 hours for the Renderer/ directory. Grep `@private`, check call sites, flip the tag. Full codebase sweep would be ~1 day.

**Risk:** zero runtime behavior change; purely doc-surface and TS-visibility.

### H. Session-by-session roadmap suggestion

1. **Next session (2-3 hours):** Knock out group B (10 easy casts) + write DrawCommand.d.ts (highest-payoff .d.ts). Expected: cast count drops from 19 → ~5, unlocks several downstream tightenings.
2. **Following session (3-4 hours):** Write remaining 9 .d.ts files from group C. Tighten 6 ambient opaque types in cesium-js-types.d.ts. Expected: `: unknown` count drops significantly.
3. **Longer-term (1 day):** `@private` → `@internal` sweep across Renderer/. Remove now-redundant `.d.ts` files that existed only to override visibility.
4. **Continuous:** Triage `: unknown` parameter/return types per file as you touch them (CLAUDE.md's 10-line rule).

---

## Architectural patterns established this session

### Co-located `.d.ts` pattern

When a TS file needs to interop with a JS class that has no `.d.ts`:

1. **Check for `@private` JSDoc first.** If the JS author uses `@private` to mean "not in the published API" (the Cesium convention), a co-located `.d.ts` that declares everything `public` is the correct fix. (`@internal` replacement is the longer-term upstream-friendly answer — see group G.)

2. **Write a co-located `ClassName.d.ts`** next to `ClassName.js`. TypeScript's `allowJs: true, checkJs: false` means a sibling `.d.ts` **overrides** JS inference for imports — no tsconfig changes needed.

3. **For classes that match an existing ambient interface** (e.g., `FrameState` matches ambient `CesiumFrameState`), use declaration merging:
   ```ts
   declare class FrameState { constructor(...); }
   interface FrameState extends CesiumFrameState {}
   ```
   Single source of truth: the ambient interface.

4. **For plain data/math classes** (Matrix4, Cartesian3, Color), declare the full instance + static surface. Don't skimp; these are touched everywhere.

5. **Never honor `@private` JSDoc on methods** that are called cross-module. TypeScript enforces `@private` as class-scoped visibility — if the method is reachable from outside the class, declare it `public` in the `.d.ts` (overriding the JSDoc). See Context.d.ts `readPixels`/`readPixelsToPBO` for example.

### Sidecar cache pattern

Per-module sidecar caches on `CesiumGraphicsContext` / `CesiumObjectWithWebGPUCache`:

1. Each owning module `export`s its cache interface.
2. `cesium-js-types.d.ts` references it via `import("./path").TypeName`.
3. Consumer sites read `context._xCache` without casts.

See SSRCache / CloudCache / WeatherCache / PostProcessCache for four examples.

### Interface merging for JS↔TS class bridging

`declare class X {}` + `interface X extends AmbientShape {}` merges — the class contributes the constructor, the interface contributes all fields. Use when the ambient interface already exists (FrameState pattern).

---

## What landed in Session 28 — Option B Completion + TypeScript Clean Build (2026-04-13)

### Option B Material UBO Split — Completed

All 4 outstanding issues from Session 27b resolved:

1. **PrimitiveMatGridLit.wgsl** — decomposed composite fields (`gridColor`/`cellColor`/`cellCount`) into individual fields matching JS fabric template names (`color`/`cellAlpha`/`lineCount`/`lineThickness`/`lineOffset`). Fragment shader updated to reconstruct cell color from individual fields.

2. **4 Ramp shaders converted** (SlopeRampFlat/Lit, AspectRampFlat/Lit) — renamed `struct Uniforms` → `struct CameraUniforms`, `uniforms.` → `camera.`. Textures moved from group(1) to group(2) matching pipeline layout.

3. **17 textured shader binding conflicts fixed** — all texture sampler + texture_2d bindings moved from `@group(1)` to `@group(2)`. Affects: Image, NormalMap, BumpMap, AlphaMap, SpecularMap, EmissionMap, Water, ElevRamp, PBRTextured (Flat+Lit variants).

4. **WebGPUPolylineRenderer.js fully refactored** — split from monolithic 256-byte UBO to separate camera (112 bytes, group 0) + material (from MaterialUniformBuffer.gpuData, group 1). `packMaterialUniforms` deleted. Pick pipeline uses camera-only bind group. All 5 polyline WGSL shaders (`PolylineCollection`, `PolylineArrow`, `PolylineDash`, `PolylineGlow`, `PolylineOutline`) and pick shader updated: `u.` → `camera.`/`material.`, `viewportSize` moved from MaterialUniforms to CameraUniforms.

5. **Consistency sweep** — Billboard (3 shaders) and Cloud collection shaders renamed `u.` → `camera.` for consistency with the new convention. Zero remaining `struct Uniforms {` or `uniforms.` references in any Primitive or Collection shader.

**Final bind group layout (all shader types):**
```text
group(0): CameraUniforms   — per-frame camera RTE data
group(1): MaterialUniforms  — from MaterialUniformBuffer.gpuData (or placeholder)
group(2): Texture           — sampler + texture_2d (textured materials only)
group(3): Effects           — clipping/shadow receive (via placeholder)
```

### TypeScript Clean Build — 202 → 0 errors

Complete elimination of all TypeScript build errors from `packages/engine/tsconfig.json`:

**cesium-js-types.d.ts rewrite:**
- Zero `any` in any type position (down from 79)
- Added 60+ missing properties across 15 ambient interfaces based on actual property access patterns
- New interfaces: `CesiumPostProcessStage`, `CesiumPostProcessStageCollection`, `CesiumWeatherConfig`, `CesiumEnvironmentState`, `CesiumGlobeTranslucencyState`, `CesiumFeatureRenderer`, `CesiumPickId`, `CesiumShadowPass`, `CesiumShadowMapWebGPUCache`
- Pass-through types use `Record<string, unknown>` (assignable from JS classes, prevents unchecked access)

**WebGPUContext fixes:**
- 6 private fields made public (`_device`, `_canvas`, `_currentCommandEncoder`, `_currentRenderPassEncoder`, `_presentationFormat`, `_frameCount`) — these have public getters but renderers access fields directly for performance
- 5 dynamic rendering properties declared as typed class fields (`_depthStencilView`, `_sceneColorView`, `_sceneColorFormat`, `_msaaSamples`, `useIndirectDrawForTiles`)
- `ShaderCache` and `UniformState` construction uses `as unknown as` casts at the JS↔TS boundary (**eliminated in Session 29**)

**FeatureRenderer base interface** — added optional `update`, `execute`, `render`, `composite` methods

**esbuild errors fixed (19 → 0):**
- 15+ methods across ~13 files missing `async` keyword (lost by ES6 class codemod)
- 3 setters with missing parameter (codemod artifact)

**CLAUDE.md rule added:** `any` is now banned as a variable/parameter/return type. Use `unknown`, specific interfaces, union types, or generics instead.

### Technical debt from Session 28 (status update)

1. **WebGPUContext public underscore fields** — Still open. 30+ external access sites should call `context.device` not `context._device`. Effort: ~2 hours.

2. **`as unknown as TargetType` double-casts** — **MOSTLY RESOLVED in Session 29.** See the "Remaining work toward a fully well-typed codebase" section above for the 19 survivors and their status.

3. **Buffer union type narrowing** — `vertexBuffers: Array<GPUBuffer | { buffer: GPUBuffer; size: number }>` requires `'buffer' in vb` narrowing at every access site. Open.

4. **PostProcessStage uniforms typed as `Record<string, number>`** — open.

5. **ES6 codemod async method audit** — open.

### Next TODO work (priority order)

0. **Remaining typing cleanup** — see Session 29 "Remaining work" section above. 2-3 hours drops `as unknown as` from 19 to ~5.

1. **`var` → `const`/`let` codemod** (~196 files, ~2-3 hours).

2. **`.indexOf()` → `.includes()` codemod** (~57 files, ~30 min).

3. **Remaining `: any` in WebGPU .ts files** (268 across 40 files).

4. **Visual smoke test** — Zero runtime testing done on any of the Option B changes.

5. **WebGPUBillboardRenderer.js bind group split** — Still uses old monolithic pattern.

6. **ViewportExecutor HiZ wiring** (~50 LOC) — Closes the Phase 3 occlusion path end-to-end.

7. **TAA implementation** (~3 days) — Design doc ready at [TAA_DESIGN.md](TAA_DESIGN.md).

8. **CSM implementation** (~4 days) — Design doc ready at [CSM_DESIGN.md](CSM_DESIGN.md).

---

## What landed in Session 27b — Material UBO Split (Option B)

### Completed

- MaterialUniformBuffer.js: Float32Array-backed uniform storage with WGSL-aligned layout (alignment-aware _buildLayout handles vec2→8-byte, vec3/vec4→16-byte rules)
- 49 WGSL shaders split from monolithic `struct Uniforms` to `struct CameraUniforms` (group 0) + `struct MaterialUniforms` (group 1) via codemod script
- `materialColor` → `color` field rename in 6 shaders (PrimitiveMatColorFlat/Lit, PolylineArrow/Dash/Glow/Outline)
- PrimitiveMatGridFlat.wgsl: decomposed `gridColor/cellColor/cellCount` composite fields into individual `color/cellAlpha/lineCount/lineThickness/lineOffset` matching the JS fabric template
- WebGPUPrimitiveCommands.js: pipeline layout split into camera BGL (group 0) + material BGL (group 1), ~295 lines of packMaterialUniforms deleted, material data sourced from MaterialUniformBuffer.gpuData

### Critical design decisions documented

- WGSL MaterialUniforms struct field names MUST exactly match JS fabric uniform names because MaterialUniformBuffer._buildLayout uses fabric names as keys
- The old packMaterialUniforms was a TRANSLATION LAYER between JS names and WGSL names — with Option B, translation is eliminated by making the shader match the JS
- Camera uniforms use Cesium-specific RTE encoding (not industry-standard viewProjection) — this is correct for planetary-scale rendering
- Float32Array backing is sufficient for ALL color values including HDR (Float32 handles values far beyond display range)
- The alignment padding adds ~4-8 bytes per material — negligible cost

### Bind group layout after Option B

```text
group(0): CameraUniforms (96 bytes flat, 240 bytes lit)
group(1): MaterialUniforms (16-64 bytes, material-type dependent)
group(2): Texture sampler + texture (for textured materials) OR Effects/Clipping
group(3): Effects/Clipping (for textured materials)
```

---

## What landed in the 2026-04-12 session (Phase 5 + HDR Parity)

### Phase 5 Modern WebGPU Features

| Feature | New files | Key integration points |
| --- | --- | --- |
| **WGF-4** RTE assertions | `WebGPURTEAssertions.ts` | Wired into `WebGPUBufferPrimitiveRenderer`, `WebGPUGlobeSurfaceRenderer`, `WebGPUUniformGroupManager` (debug-pragma-guarded) |
| **WGF-1** Hardware clip distances | `WebGPUClipDistancePrecompute.ts` | `WebGPUEffectsBindGroup.js` (240-byte UBO), `WebGPUGlobeSurfaceRenderer.ts` (source injection variant + pipeline cache key), `WebGPUContext.ts` (`useHardwareClipDistances` flag) |
| **WGF-3** shader-f16 tonemapping | `Tonemapping_f16.wgsl` | `WebGPUPostProcessPipeline.ts` (variant selection + fallback compile), `WebGPUContext.ts` (`useShaderF16` flag) |

### HDR Pipeline

| Change | File |
| --- | --- |
| Fix: ping-pong textures use `rgba16float` when HDR | `WebGPUPostProcessPipeline.ts` (`_intermediateFormat`, `_hdr`) |
| Fix: stage pipelines target intermediate format | `addTonemapping()`, `addColorGrading()`, `addFXAA()`, `addCustomStage()` |
| New: auto-exposure compute shader | `AutoExposure.wgsl`, `WebGPUAutoExposure.ts` |
| Wire: auto-exposure into pipeline | `WebGPUPostProcessPipeline.ts` (`addAutoExposure()`, dispatch in `execute()`) |
| Wire: scene texture + HDR flag | `WebGPUSceneRenderer.ts` (passes `hdr` + `sceneColorTexture`) |

### Bug Fixes

| Bug | Fix |
| --- | --- |
| OPEN-5 fog too aggressive | `GlobeTerrain.wgsl` `computeFog()` now 3-param with `fogVisualDensityScalar`; `WebGPUGlobeSurfaceRenderer.ts` packs at offset 79; `WebGPUAutoUniforms.js` added `csm_fogVisualDensityScalar` |
| OPEN-1 sky atmo infinite retry | `WebGPUSkyAtmosphereRenderer.js` try/catch + `_pipelineFailed` latch |
| 3 stale EffectsUniforms structs | `PrimitiveBasicColor.wgsl`, `PrimitivePhongColor.wgsl`, `PrimitivePhongTexturedColor.wgsl` updated to 240-byte layout |

---

## What landed in the 2026-04-09 sweep (3 nested sessions)

Three sessions back-to-back closed Phase 6 audit, Phases 1-3 of the remediation order, and laid Phases 4-5 design + cheap visible wins. Full detail in [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) under the three "Phase X sweep (completed 2026-04-09)" sections.

### Key surfaces that now exist (you'll use these heavily next session)

| Surface | Where | Use case |
|---|---|---|
| `Scene.getDebugSnapshot()` | [Scene.js:1438+](packages/engine/Source/Scene/Scene.js#L1438) | Aggregated read of every subsystem's state — snapshot mode, VPT, renderer (bundle/fog/HiZ/sortKeys/capabilities), moon, debug toggles |
| `Scene.logDebugSnapshot()` | [Scene.js:1529+](packages/engine/Source/Scene/Scene.js#L1529) | Pretty-prints the snapshot via `console.groupCollapsed` |
| `Scene.beginPerformanceTrace(label, {frames})` | [Scene.js](packages/engine/Source/Scene/Scene.js) | Per-frame trace recording with CSV / JSON exporters |
| `Scene.endPerformanceTrace()` | [Scene.js](packages/engine/Source/Scene/Scene.js) | Returns `{label, summary, samples}` |
| `scene.performanceTracker` | [PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js) | `.toCSV()` / `.toJSON()` / `.logToConsole()` |
| `GraphicsContext.getRendererStatistics()` | [GraphicsContext.ts](packages/engine/Source/Renderer/GraphicsContext.ts) | Abstract concrete (default `{}`); WebGPUContext overrides with bundle/perf/timestamps/indirectDraw/fog/hiZOcclusion/gpuSortKeys/capabilities |
| `WebGPUContext.getRendererStatistics()` | [WebGPUContext.ts:3106+](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L3106) | Capability snapshot under `.capabilities` (hasShaderF16, hasDualSourceBlending, hasClipDistances, etc.) |
| `scene.debugShowImageryProbe = true` | [Scene.js](packages/engine/Source/Scene/Scene.js) | BUG-11 probe — dumps next 4 tile updates with full payload; rising-edge latch reset |
| `scene.snapshotMode.enabled = true` + `autoEnterIdleFrames = N` | [SnapshotModeService.js](packages/engine/Source/Services/SnapshotModeService.js) | FAST-mode-on-idle preset |

### Dispatchers that exist but aren't fully wired into consumers

| Dispatcher | Built? | Wired? | Where | Next step |
|---|---|---|---|---|
| `WebGPUPointCloudSortDispatcher` | ✅ | ❌ | [WebGPUPointCloudSortDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts) | One-line consumer swap in `WasmPointCloudBridge.sortByDistance` |
| `WebGPUHiZOcclusionDispatcher` | ✅ | ✅ FR registered, OcclusionCulling.initialize() wired | [WebGPUHiZOcclusionDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts) | ViewportExecutor needs to call `dispatchGPU()` + `scheduleReadback()` (~50 LOC) |
| `WebGPUGPUSortKeysDispatcher` | ✅ | ❌ FR registered only | [WebGPUGPUSortKeysDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts) | RenderScheduler integration: SOA buffers + sort pass + reorder commands |

---

## Pending work — concrete next steps in priority order

### 1. Typing push completion (2-3 hours, HIGH VALUE) — NEW, Session 29

Finish the easy 10 remaining `as unknown as` casts in group B + write `DrawCommand.d.ts` + tighten 6 ambient opaque types. See "Remaining work toward a fully well-typed codebase" section above. Expected: cast count 19 → ~5, establishes the rhythm for subsequent .d.ts batches.

### 2. ViewportExecutor wiring for HiZ occlusion (~50 LOC, 0.5 day)

**Why:** Closes the Phase 3 occlusion path end-to-end. Everything else is built; only the per-frame consumer call is missing.

**Files:**
- [ViewportExecutor.js:392-406](packages/engine/Source/Scene/ViewportExecutor.js#L392-L406) — current call site for `occlusionCulling.beginFrame()` + `testCommands()`
- [OcclusionCulling.js](packages/engine/Source/Scene/OcclusionCulling.js) — has the new `dispatchGPU(encoder, depthTextureView, params)` and `scheduleReadback()` methods waiting

### 3. Visual smoke test session (1-2 hours, requires browser)

**Why:** Four sessions of fixes are now waiting for in-browser confirmation. The central debug surface + perf tracker + visual regression CI are all built but never validated against a live scene.

### 4. PointCloudSort consumer integration (1 day)

### 5. WGF-4 Camera UBO migration (~1 day)

**Design:** [PHASE_5_MODERN_WEBGPU_DESIGN.md](PHASE_5_MODERN_WEBGPU_DESIGN.md) — see the WGF-4 section

### 6. TAA implementation (~3 days) — [TAA_DESIGN.md](TAA_DESIGN.md)

### 7. CSM implementation (~4 days) — [CSM_DESIGN.md](CSM_DESIGN.md)

---

## Architectural reminders (from CLAUDE.md)

- **Backend agnosticism**: Scene code MUST NOT import from `Renderer/WebGPU/`. Use `context.getFeatureRenderer(FeatureRendererKey.XXX)` for backend dispatch.
- **64-bit RTE precision**: never use a single `position: vec3<f32>` in vertex buffers. Always `positionHigh` + `positionLow` and the `mvpRelativeToEye` path.
- **Monorepo file placement**: edit `packages/engine/Source/`, never the root `Source/` build output.
- **No JSDoc bloat**: don't add new JSDoc that wasn't there before; preserve existing JSDoc when modernizing.
- **No backwards-compat hacks**: rename/remove cleanly. Don't leave `// removed` comments or unused `_var` shims.
- **No `any` ban** (added Session 28): Use `unknown`, specific interfaces, union types, or generics instead.
- **Co-located `.d.ts` pattern** (established Session 29): See "Architectural patterns established this session" above.

## Testing reminders

- `npx tsc --project packages/engine/tsconfig.json --noEmit` after every meaningful change. Currently clean.
- Pure-CPU specs land in `packages/engine/Specs/` and run via `gulp test`. They follow the same backend-neutral discipline as the source.
- Tests that need a real `GPUDevice` go in `Specs/Renderer/WebGPU/` and run in the browser via the karma harness.
- The visual regression workflow at `.github/workflows/visual-regression.yml` is **manual trigger only** (workflow_dispatch) because GitHub-hosted Linux runners don't ship a WebGPU adapter.

---

## Quick recipe: how to start the next session

```
1. Read this file (NEXT_SESSION_HANDOFF.md) — full picture.
2. If picking up the typing work, read "Remaining work toward a fully well-typed codebase" section above — it's the complete backlog.
3. If picking up visual work, read the relevant design doc:
   - HiZ wiring     → use the existing dispatcher entry points
   - Visual smoke   → use Scene.logDebugSnapshot() + performanceTracker
   - WGF-4 Camera   → PHASE_5_MODERN_WEBGPU_DESIGN.md §WGF-4
   - TAA            → TAA_DESIGN.md
   - CSM            → CSM_DESIGN.md
4. `npx tsc --project packages/engine/tsconfig.json --noEmit` baseline (should be clean — exit=0).
5. Use TodoWrite to track the chosen task's sub-steps.
6. After every meaningful change: `npx tsc --noEmit`.
7. Update WEBGPU_MIGRATION_STATUS.md when the task lands.
```

## Files referenced by this handoff

**Design docs (read these before starting their tasks):**
- [TAA_DESIGN.md](TAA_DESIGN.md)
- [CSM_DESIGN.md](CSM_DESIGN.md)
- [PHASE_5_MODERN_WEBGPU_DESIGN.md](PHASE_5_MODERN_WEBGPU_DESIGN.md)

**Status docs:**
- [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) — full session-by-session history
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — remaining work
- [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) — bug tracking; see "Session 29" for today's typing discoveries

**Project rules:**
- [../CLAUDE.md](../CLAUDE.md) — backend agnosticism, RTE precision, file placement, ES6 modernization, `any` ban, co-located `.d.ts` pattern

**Co-located `.d.ts` files (13 new from Session 29):**
- Core: [Matrix4.d.ts](../packages/engine/Source/Core/Matrix4.d.ts), [Cartesian3.d.ts](../packages/engine/Source/Core/Cartesian3.d.ts), [Color.d.ts](../packages/engine/Source/Core/Color.d.ts), [EncodedCartesian3.d.ts](../packages/engine/Source/Core/EncodedCartesian3.d.ts), [BoundingRectangle.d.ts](../packages/engine/Source/Core/BoundingRectangle.d.ts)
- Renderer: [UniformState.d.ts](../packages/engine/Source/Renderer/UniformState.d.ts), [PassState.d.ts](../packages/engine/Source/Renderer/PassState.d.ts), [ShaderCache.d.ts](../packages/engine/Source/Renderer/ShaderCache.d.ts), [PickId.d.ts](../packages/engine/Source/Renderer/PickId.d.ts), [Context.d.ts](../packages/engine/Source/Renderer/Context.d.ts), [Texture.d.ts](../packages/engine/Source/Renderer/Texture.d.ts), [CubeMap.d.ts](../packages/engine/Source/Renderer/CubeMap.d.ts)
- Scene: [FrameState.d.ts](../packages/engine/Source/Scene/FrameState.d.ts)

**Built-but-unwired dispatchers:**
- [WebGPUHiZOcclusionDispatcher.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts)
- [WebGPUGPUSortKeysDispatcher.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts)
- [WebGPUPointCloudSortDispatcher.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts)
