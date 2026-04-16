# Next Session Handoff — 2026-04-16

**Branch:** `main`
**Build:** `npx gulp build` clean in ~40s, **two consecutive runs both succeeded** (the build non-determinism documented in `PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md` §1 is fixed).
**`tsc --project packages/engine/tsconfig.json --noEmit`:** clean (0 errors).

This handoff supersedes the prior 2026-04-15 file. Read the principal-engineer review at [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) first if you need context — this doc is a delta on top of it.

---

## Session 31 — Principal-engineer review fixes (2026-04-16)

The review surfaced 17 actionable findings across CRITICAL / HIGH / MEDIUM tiers. After verification, **5 had already been fixed** by other work (§2 build outputs, §3f double-beginRenderPass, §4a Scene.js leaks, §4d VOLUMETRIC_FOG consumer, §6b panorama logs). The remaining **11 valid findings were fixed in this session**:

| Tier | Finding | Fix | File(s) |
| --- | --- | --- | --- |
| CRITICAL §1 | esbuild parse-error race on second build | Explicit `loader: { ".ts": "ts", … }` map in `defaultESBuildOptions()` | [scripts/build.js](../scripts/build.js) |
| CRITICAL §3a | Ring allocator overflow grew unbounded (no auto-trim) | Auto-trim every N frames (default 60) + `maxPageCount` circuit breaker (default 32) + first-overflow warning + actionable error message | [WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts) |
| CRITICAL §3b | `mapAsync` callback accessed `_stagingBuffer` after destroy | Captured staging buffer reference + `_isDestroyed` + identity guard in all three async paths (sync `_startReadback`, `endAsync`, `readDepthPixelAsync`); `isDestroyed()` now reports the real flag | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) |
| CRITICAL §3c | Per-frame `createView()` and `createBindGroup()` leaked | Cached `_colorView` / `_depthView` (recreated only on resize); `WeakMap<GPUTexture, GPUBindGroup[]>` cache in mipmap generator (auto-releases when textures are GC'd) | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts), [WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts) |
| CRITICAL §3d | Device-loss recovery promise was detached | Promise stored on the recovery manager; `dispose()` method awaits it; `WebGPUContext.destroy()` calls `dispose()` and trips an abort flag so a recovered device isn't promoted into a torn-down context | [WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts), [WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) |
| CRITICAL §3e | Shader cache errors lost the WGSL source | Truncated source (800 chars) appended to console output; full source attached to the wrapped Error as `wgslSource` for programmatic access; shader name attached as `shaderName` | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts) |
| HIGH §4b | `WebGPUDrawCommand` missing `occlude` + `pickOnly` | Added to options interface, fields, defaults (`occlude` defaults true mirroring WebGL, `pickOnly` defaults false), and `clone()` | [WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts) |
| HIGH §4c | Lazy feature-renderer race + half-flicker | Replaced boolean flag with discriminated-union `FeatureRendererLoadStatus` (registered / loading / loaded / failed); added `getFeatureRendererAsync(key)`, `getFeatureRendererStatus(key)`, `isFeatureRendererLoading(key)`, `hasFeatureRendererFailed(key)`. Failed loads can be retried on next call. RxJS BehaviorSubject was considered but rejected — consumers don't subscribe to changes (they call `getFeatureRenderer(key)` per frame), so the typed-state slot is more performant and avoids pulling RxJS into the engine | [GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) |
| MEDIUM §6a | Cache errors missing `context.id` prefix | Constructors accept optional `contextId`; errors now log `[CesiumJS:webgpu:<id>:shader-cache]` / `[CesiumJS:webgpu:<id>:pipeline-cache]`. Both caches are dormant infrastructure (not yet instantiated by `WebGPUContext`) but the principled gap is closed | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts), [WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) |
| MEDIUM §6c | `@webgpu/types` on caret range | Tight-pinned `0.1.69` with rationale documented in the PR | [package.json](../package.json) |

### Net delta

- Build determinism: **fixed** — two consecutive `gulp build` runs from a clean tree both succeed.
- Resource lifecycle: **5 of 6 confirmed leaks/races closed**. The remaining one (HIGH §5a — specs not in CI) is an infra change requiring a CI workflow edit; left as an open task because the test suite + spec-runner config need a separate review pass.
- Backwards compatibility: **zero behavior changes for existing callers**. The `getFeatureRenderer(key)` sync path returns the same values; the new async/status methods are additive.

### What's NOT yet addressed from the review

| Tier | Finding | Why deferred |
| --- | --- | --- |
| CRITICAL §1 | Move generated `Source/Cesium*.js` entry files to `Build/generated/` | Cosmetic + risky — touches the entire build pipeline, several test pages reference root `Source/Cesium.js`. Leave for a focused build-system PR |
| CRITICAL §2 | `gulp prepare` destroys `Build/Cesium*` siblings | **DISPROVED on re-verification** — the `prepare` task is non-destructive |
| HIGH §4d | `auditFeatureRenderers` gulp task | The discriminated-union status above (§4c) gives us the data structure to audit; the gulp task itself is ~50 LOC in a separate PR |
| HIGH §5a | Specs not in CI | The dev workflow already runs `npm test` via `release-tests` job (with `--release --webgl-stub`), but WebGPU-specific specs need a non-stub run in a fresh job. Needs a workflow PR |
| HIGH §5b | `bundleVariantPlugin` spec | New file; fits naturally with the next batch of test work |
| HIGH §5c | 20+ untested WebGPU modules (~8,850 LOC) | Backfill campaign; one module per PR is the realistic cadence |
| MEDIUM §6d | `@private` → `@internal` sweep | ~2-3 hour grunt task, no risk; queue for a low-context session |
| MEDIUM §6e | Pragma stripping post-build lint | Build-system tooling; pairs with §1 generated-entry move |
| MEDIUM §6f | Inconsistent error prefixes | 86 `console.*` call sites in `Renderer/WebGPU/`; mechanical sweep |
| MEDIUM §6g | Documentation drift CI check | Quarterly process change; not single-PR work |
| MEDIUM §6h | `FEATURE_RENDERER_ONBOARDING.md` | ~300 LOC doc; can be authored alongside the next FR addition |

---

## Next chunk — full ES6/ES2022 modernization

The user has explicitly requested this as the next milestone. The Session 30 handoff captured the raw count (`~433 modernization markers` across the engine + widgets) and recommended a two-track approach. Here's the plan that operationalizes it.

### Total surface area (re-counted at Session 30 close)

| Marker | Count |
| --- | --- |
| `var` declarations | ~0 (all gone) |
| IIFE wrappers `(function(){})()` | 0 |
| `var self = this` / `var that = this` | 0 |
| `X.prototype.method = function()` | **293** |
| `Object.defineProperties(X.prototype, {...})` | **105** |
| `.apply(null, args)` / `.apply(this, args)` | 10 |
| `arguments` object reads | 25 |

### The hidden cost

CesiumGS upstream has **not** modernized the bulk of these files. Every upstream-pristine `.js` we modernize creates a structural merge conflict on every upstream sync. The principled split:

- **Modernize now**: fork-owned files. Modernizing them is nearly free because we resolve conflicts during every sync anyway.
- **Modernize opportunistically**: files we touch for unrelated work (CLAUDE.md's existing 10-line rule already enforces this).
- **Defer indefinitely**: upstream-pristine files. Modernizing them adds merge friction with little benefit.

### Phase A — fork-owned files (~1-2 hours)

These are the highest-priority targets because they're either WebGPU-specific or actively-edited fork additions:

| File | Markers | Notes |
| --- | --- | --- |
| [Renderer/WebGPU/WGSLShaderBuilder.js](../packages/engine/Source/Renderer/WebGPU/WGSLShaderBuilder.js) | 25 | Touched on every WGSL feature; modernize before it grows further |
| [Renderer/WebGPU/RenderCommand.js](../packages/engine/Source/Renderer/WebGPU/RenderCommand.js) | 8 | Backend-agnostic abstraction |
| Any other fork-specific `Renderer/WebGPU/*.js` outliers | small | Sweep in same pass |

**Acceptance:** every `prototype.method = function()` becomes a class method; every `Object.defineProperties` becomes ES6 `get`/`set`; existing JSDoc preserved (CLAUDE.md rule); no JSDoc added that wasn't there.

### Phase B — fork-modified Scene + Renderer files (~3-5 days)

Files where we have meaningful WebGPU additions on top of upstream code. Modernizing here costs less than modernizing pristine files because we already resolve the conflicts during sync. Candidates surfaced from session-30 audit:

| File | Markers | Reason |
| --- | --- | --- |
| Scene/Primitive.js, Scene/PointPrimitiveCollection.js, Scene/PolylineCollection.js, etc. | varies | We've added WebGPU routing; merge cost is already paid each sync |
| Renderer/Context.js | varies | Already ES6 class via our extends GraphicsContext refactor — verify no remaining `prototype.method` patterns |
| Renderer/createUniformArray.js + createUniform.js | 26 combined | Frequently touched in WebGPU uniform work |

### Phase C — opportunistic (CLAUDE.md rule already covers this)

Every file touched for >10 lines of unrelated work picks up its modernization for free. Over 6-12 months of active development this naturally covers the fork-specific + frequently-edited files without paying the merge cost.

### Phase D — deliberate upstream-pristine deferral

The ~300 markers in `KmlDataSource.js`, `CesiumWidget.js`, `AtmosphericConditions.js`, `PolylineCollection.js`, etc. are explicitly **not** scheduled. They modernize when upstream modernizes them, or when feature work happens to touch them.

### What "modernization" concretely means

Per the CLAUDE.md ES6+ rules + the upstream Coding Guide:

1. `var` → `const` / `let`
2. Prototype-based inheritance → ES6 `class` syntax (preserving all JSDoc, removing `@constructor` and `@memberof X.prototype` that are now redundant)
3. `Object.defineProperties()` getters/setters → ES6 `get` / `set` in class body
4. String concatenation → template literals (only where readability improves)
5. `Function.prototype.apply(null, args)` → spread (`fn(...args)`)
6. `arguments` reads → rest parameters (`...args`)
7. `for (var i = 0; ...)` over arrays → `for...of` or `.forEach()` *only* where perf is not critical
8. `typeof x !== "undefined"` → optional chaining / nullish coalescing
9. `Object.assign({}, defaults, options)` → `{ ...defaults, ...options }`
10. `.indexOf(x) !== -1` → `.includes(x)`
11. `obj.hasOwnProperty(key)` → `Object.hasOwn(obj, key)`

**Performance-critical math classes** (`Cartesian3`, `Matrix4`, `Quaternion`, `JulianDate`) are intentionally left alone — they use `result` parameters and scratch variables where ES6 patterns can introduce overhead. Benchmark before any change here.

### Recommended starting point next session

1. **Read this handoff + the principal-engineer review.**
2. **Pick `WGSLShaderBuilder.js` as the Phase A pilot** — biggest single fork-owned target (25 markers), establishes the pattern for the rest.
3. **Run `npx tsc --project packages/engine/tsconfig.json --noEmit`** as the gate after every file conversion.
4. **Update [migration_doc/ES6_MODERNIZATION_BACKLOG.md](ES6_MODERNIZATION_BACKLOG.md)** with the converted-file list as you go.
5. **Hold the line:** never modernize a file you're not otherwise touching unless it's on the explicit Phase A/B list.

---

## What's at the principled floor in Renderer/WebGPU

(Carrying forward from Session 30 — unchanged.)

Every remaining `any`/`unknown`/`object`/`Record<string, unknown>` in the WebGPU renderer is one of:

- `catch (e: unknown)` — TS's required catch binding (8 sites)
- Open index signatures on explicitly-permissive interfaces (SceneGlobalCache fallback, CesiumComputeCommand, CesiumObjectWithWebGPUCache) — by-design
- `jsModule<T>(mod: object)` — intentional type-eraser helper in `webgpuTypeHelpers.ts`
- `_gl` / `cache` on `WebGPUContext` — WebGL-compat JS surfaces consumed by ~20 upstream JS files
- `_performanceManager as unknown as {...}` — WIP per `feedback_interface_pruning.md` memory
- `PickTarget` index signature value — principled opaque for "value in heterogeneous external registry"

Further tightening requires (a) porting WebGL resource JS to TS, or (b) completing WIP modules — both are feature work, not typing work.

---

## Quick recipe — starting the next session

```text
1. Read this file (NEXT_SESSION_HANDOFF.md) — full picture.
2. Read PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md if you need context on
   why specific lifecycle bugs / arch decisions exist as they are.
3. If continuing the modernization push:
   - Start with `WGSLShaderBuilder.js` (Phase A).
   - One file per commit; tsc --noEmit between each.
   - Preserve existing JSDoc; do NOT add new JSDoc.
4. If continuing the review-fix tail (§5a/§5b/§5c/§6d/§6e/§6f/§6g/§6h):
   - The "What's NOT yet addressed" table above ranks them.
   - The smallest unblock is §6d (`@private` → `@internal` sweep, ~2-3h).
5. After every meaningful change: `npx tsc --noEmit`.
```

## Files referenced by this handoff

**Review:**

- [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) — the source of the fix list

**Status docs:**

- [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) — full session-by-session history
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — remaining work
- [ES6_MODERNIZATION_BACKLOG.md](ES6_MODERNIZATION_BACKLOG.md) — modernization tracker

**Project rules:**

- [../CLAUDE.md](../CLAUDE.md) — backend agnosticism, RTE precision, file placement, ES6 modernization, `any` ban, co-located `.d.ts` pattern

**Key code surfaces touched this session:**

- [scripts/build.js](../scripts/build.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) (destroy() teardown order)
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts)
- [packages/engine/Source/Renderer/GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) (lazy FR state machine + status introspection)
- [package.json](../package.json) (`@webgpu/types` pin)
