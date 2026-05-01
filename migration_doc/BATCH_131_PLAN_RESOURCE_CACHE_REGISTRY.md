# Batch 131 Plan — Extract `_clearAllCaches` resource-cache registry

**Source:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
candidate #3.
**Status:** Plan only. No code changes yet.
**Predecessors:** Batch 127 (`_initializeContextLimits`), Batch 129
(`_initializeWebGLStub`), Batch 130 (device-invalidation bus).

## Goal

Replace `WebGPUContext._clearAllCaches`'s hard-coded list of cache
clears with a registry that the Context populates once at init. New
file:

```text
packages/engine/Source/Renderer/WebGPU/WebGPUResourceCacheRegistry.ts
```

Code being extracted (`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`,
post-Batch 130):

- The bulk of `_clearAllCaches` at **lines 4035-4054** — 9 cache
  clears + 4 nullings, currently inlined.
- The `clearEffectsPlaceholderCacheForDevice` call at **line 4062**
  — stays in the Context method since it depends on `this._device`
  (see "Out of scope" below).
- The `_fireDeviceInvalidated()` call at **line 4073** — stays
  inline; it's the side-effect that fires AFTER caches clear, not a
  cache itself.

Net effect:

- `WebGPUContext.ts`: 4136 → ~4115 lines (−~20 LOC).
- New module: ~80 lines (small class with `register` + `clearAll` +
  `size` accessor + `names` accessor for diagnostics).
- One new private method on Context, `_registerResourceCaches()`,
  called from `_initialize` after the caches exist. This replaces
  the inline list with a fluent registration block — same total
  surface, different home.
- `_clearAllCaches` body collapses from 23 lines to 4: registry
  call, `clearEffectsPlaceholderCacheForDevice`, fire bus.

## Why this candidate next

- **Per-cache error isolation.** Today if `_webgpuShaderCache.clear()`
  throws (race during device-loss with a concurrent shader compile,
  for example), every subsequent line in `_clearAllCaches` is
  skipped — including `_fireDeviceInvalidated`. The registry
  `try/catch`-es each entry independently, matching the pattern
  already used by the device-invalidation bus's subscriber loop.
- **Named entries.** The current code is "9 lines of cache.clear()
  calls in unspecified order"; with the registry each entry has a
  string name that surfaces in error logs. Lower diagnostic friction.
- **Future caches register at their definition site.** A future
  cache (e.g. compute-pipeline-LRU) currently has to remember to add
  itself to `_clearAllCaches`. With the registry the new cache's
  init code calls
  `this._cacheRegistry.register("foo", () => this._foo.clear())`
  next to the cache field declaration.
- **Modest LOC reduction.** ~20 lines off the Context. Smaller than
  Batch 127/129 but the structural payoff is real.

## External call sites (verified)

- `WebGPUDeviceLossRecovery.ts:296` — calls
  `this._host._clearAllCaches()` via the
  `DeviceLossRecoveryHost` interface (declared at line 73).
- `WebGPUContext.ts:4005` — host adapter forwards the call:
  `_clearAllCaches: () => this._clearAllCaches()`.

The contract is `_clearAllCaches(): void` — preserved exactly. Only
the implementation moves.

The `destroy()` method (lines 2938-2945) clears a *subset* of the
same caches but for a different reason (final teardown vs. recovery
mid-lifetime). It is **not** rewired through the registry in this
batch — see "Out of scope".

## Concrete steps

### 1. Create the new module

`packages/engine/Source/Renderer/WebGPU/WebGPUResourceCacheRegistry.ts`:

```ts
/**
 * Registry of cache-clear callbacks owned by a WebGPU context.
 *
 * Extracted from `WebGPUContext._clearAllCaches`'s inline cache list
 * as Batch 131 of the audit-recommended Context decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` for the
 * roadmap and `migration_doc/BATCH_131_PLAN_RESOURCE_CACHE_REGISTRY.md`
 * for this specific extraction.
 *
 * The Context registers each of its caches once at init; the
 * recovery path calls `clearAll()` to drop stale GPU handles after
 * device loss. Each entry runs inside its own try/catch so a single
 * misbehaving cache (e.g. a concurrent compile racing with the
 * recovery flow) doesn't block the rest of the cleanup or the
 * downstream `_fireDeviceInvalidated()` notification.
 *
 * The registry doesn't track which caches "own" GPU handles vs. JS
 * references — every entry is just a `() => void` callback. The
 * Context retains responsibility for the actual clear logic; the
 * registry is the dispatcher.
 *
 * @module WebGPUResourceCacheRegistry
 */

interface CacheEntry {
  name: string;
  clear: () => void;
}

export class WebGPUResourceCacheRegistry {
  private entries: CacheEntry[] = [];
  private contextIdProvider: () => string | undefined;

  /**
   * @param contextIdProvider - Returns the owning context's id when
   *   called. Used in error logs so multi-context setups can
   *   attribute failures.
   */
  constructor(contextIdProvider: () => string | undefined) {
    this.contextIdProvider = contextIdProvider;
  }

  /**
   * Register a cache-clear callback. Returns `this` so registration
   * blocks can chain. The same `name` may be registered more than
   * once — duplicates are kept and called in registration order
   * (some callers may legitimately split a single conceptual cache
   * across multiple slots).
   */
  register(name: string, clearFn: () => void): this {
    this.entries.push({ name, clear: clearFn });
    return this;
  }

  /**
   * Clear every registered cache, in registration order. Each entry
   * runs inside its own try/catch so one failing clear doesn't block
   * the rest. Errors are logged with the cache name + owning context
   * id for diagnostic attribution.
   */
  clearAll(): void {
    for (const entry of this.entries) {
      try {
        entry.clear();
      } catch (e) {
        const id = this.contextIdProvider() ?? "?";
        console.error(
          `[WebGPU:ctx-${id}:cache-registry] '${entry.name}' clear threw:`,
          e,
        );
      }
    }
  }

  /**
   * Number of registered cache entries. Exposed for diagnostics +
   * tests.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Names of registered caches in registration order. Useful for
   * snapshot tests that pin the expected registry shape.
   */
  get names(): readonly string[] {
    return this.entries.map((e) => e.name);
  }

  /**
   * Drop every registered entry. Used by the Context's destroy path
   * so registered closures release immediately.
   */
  clear(): void {
    this.entries = [];
  }
}

export default WebGPUResourceCacheRegistry;
```

### 2. Update `WebGPUContext.ts`

#### 2a. Add the import

Alongside the Batch-127/129/130 helper imports near the top:

```ts
import { WebGPUResourceCacheRegistry } from "./WebGPUResourceCacheRegistry.js";
```

#### 2b. Add the registry field

Where the bus field lives now (around line 4070 post-Batch 130) is
fine, or co-locate next to `_deviceInvalidationBus` for consistency:

```ts
// Resource-cache registry (Batch 131). Populated by
// `_registerResourceCaches()` during `_initialize` after the caches
// exist. `_clearAllCaches` walks it in order during device-loss
// recovery.
private _cacheRegistry = new WebGPUResourceCacheRegistry(
  () => this.id,
);
```

#### 2c. Add the registration method

Near `_clearAllCaches`, define:

```ts
/**
 * Register every Context-owned cache with `_cacheRegistry`. Called
 * once from `_initialize` after the caches and pools exist. Order
 * matches the original inline `_clearAllCaches` body so any
 * implicit dependency between clears is preserved.
 *
 * Note: `clearEffectsPlaceholderCacheForDevice` is NOT registered —
 * it needs the *current* `this._device` ref, and the recovery flow
 * may have already swapped to a new device by the time `clearAll`
 * fires. Keeping it inline in `_clearAllCaches` preserves the
 * original ordering relative to `_fireDeviceInvalidated`.
 *
 * @private
 */
private _registerResourceCaches(): void {
  this._cacheRegistry
    .register("samplerCache", () => this._samplerCache.clear())
    .register("bindGroupLayoutCache", () =>
      this._bindGroupLayoutCache.clear(),
    )
    .register("bindGroupCache", () => this._bindGroupCache.clear())
    .register("bufferPool", () => this._bufferPool.clear())
    .register("uniformBufferPool", () => {
      this._uniformBufferPool = [];
    })
    .register("depthTexture", () => {
      this._depthTexture = null;
      this._depthTextureView = null;
    })
    .register("viewportQuad", () => {
      this._viewportQuadVertexBuffer = null;
      this._viewportQuadPipeline = null;
    })
    .register("shaderCache", () => this._webgpuShaderCache?.clear())
    .register("pipelineCache", () => this._webgpuPipelineCache?.clear())
    .register("computePipelineCache", () =>
      this._webgpuComputePipelineCache?.clear(),
    );
}
```

Call it once from `_initialize` after the relevant fields are set
(verify exact insertion point at execution time — the right home is
just before the `_setupDeviceLostHandler()` call so the recovery
infrastructure sees a fully-populated registry on its first fire).

#### 2d. Replace `_clearAllCaches` body

```ts
private _clearAllCaches(): void {
  // Per-cache try/catch + named error logs live inside the registry
  // (Batch 131). What stays inline:
  //   - `clearEffectsPlaceholderCacheForDevice` — needs the current
  //     `this._device` ref and runs strictly between the cache
  //     clears and the invalidation fire.
  //   - `_fireDeviceInvalidated` — the side-effect that notifies
  //     external subscribers AFTER all caches drop their stale
  //     handles.
  this._cacheRegistry.clearAll();

  // C-R12 (Batch 33) — drop the module-level placeholder cache for
  // the dead device. The WeakMap would self-heal once the device
  // object becomes unreachable, but we can't rely on other holders
  // (cached shader modules, long-lived closures) releasing it fast
  // enough.
  if (this._device) {
    clearEffectsPlaceholderCacheForDevice(this._device);
  }

  // C-R12 (Batch 33) — fire the invalidation event so every
  // subscribed subsystem / feature renderer / per-object cache
  // drops its stale GPU handles.
  this._fireDeviceInvalidated();
}
```

#### 2e. Optional: clear registry in destroy path

Mirroring the Batch 130 lifecycle pattern:

```ts
// Inside destroy(), near the existing _deviceInvalidationBus.clear():
this._cacheRegistry.clear();
```

Trivial 1-line addition; drops the registered closures so they don't
keep the Context's own fields alive past destroy.

### 3. Verification

Same gate as Batches 127/129/130:

```bash
npx tsc --noEmit                                           # ~30s
npx gulp build                                             # ~50s
node Tools/visual-regression/verify-glb-side-by-side.mjs   # ~60s
node Tools/visual-regression/verify-b3dm-render.mjs        # ~120s
node Tools/visual-regression/verify-model-feature-pick.mjs # ~120s
```

**Pass criteria:**

- `tsc` clean.
- Build clean.
- glb side-by-side: airplane silhouette ≥ 5000 px at `(149, 149, 149)`
  (Batch 124-130 baseline ~6150).
- b3dm: `tilesFeaturesLoaded=10, modelReady=true, primCacheKeyCount=1`
  (Batch 124-130 baseline).
- C-R9 pick: `featurePickIdCount=30, featurePickTexExists=true,
  featurePickFeaturesLength=30` (Batch 125-130 baseline).

The registry is on the device-loss recovery path, not the steady-
state render path — so the smoke tests don't exercise `clearAll()`
directly. They DO exercise that `_registerResourceCaches()` runs
during init without throwing, which catches any mistake in the
registration block (typo, dangling reference, etc.). To exercise the
clear path itself, the existing
`Specs/Renderer/WebGPU/WebGPUDeviceLossRecovery*Spec.js` Jasmine
suite is the canonical coverage; verify it still passes after this
batch.

## Risks & mitigations

| Risk                                                                                       | Mitigation                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration order matters for some hidden inter-cache dependency                          | Preserve the **exact** order the inline list uses today. The plan's `_registerResourceCaches()` block keeps the same sequence (sampler → BGL → BG → bufferPool → uniformBufferPool → depthTexture → viewportQuad → shader → pipeline → compute).                                          |
| `_registerResourceCaches()` runs before `_webgpuShaderCache` is allocated                  | The register-time closures only capture `this`, not the current cache value. The `?.clear()` chain on `_webgpuShaderCache` / `_webgpuPipelineCache` / `_webgpuComputePipelineCache` already gates on the lazy allocations. No early-init failure.                                         |
| Per-entry try/catch swallows an error that today crashes the recovery                      | The current code does NOT crash visibly on a cache-clear throw — it just stops mid-list. Adding try/catch is strictly better: the rest of the cleanup runs AND `_fireDeviceInvalidated` still fires. The per-entry `console.error` makes the failure louder, not quieter.                 |
| `clearEffectsPlaceholderCacheForDevice` called against the wrong device after recovery     | Pre-existing concern, unchanged by this batch. The plan keeps the call inline at the same spot in `_clearAllCaches`, so behavior is identical.                                                                                                                                            |
| `destroy()` rewired through registry by mistake                                            | Don't do it. `destroy()`'s subset clear is intentional and runs strictly before `device.destroy()`. The plan only touches `_clearAllCaches`. See "Out of scope".                                                                                                                          |
| Registration block forgotten when adding a new cache field                                 | Same risk exists today (dev has to remember to add to `_clearAllCaches`). The registry doesn't fix this — only a lint rule or co-location pattern does, both out of scope.                                                                                                                |

## Out of scope for this batch

- **Rewiring `destroy()` through the registry.** The two methods
  serve different purposes (mid-lifetime recovery vs. final
  teardown). Merging them is a separate refactor.
- **Generalising the registry beyond cache-clear.** The bus pattern
  from Batch 130 already covers fire-and-forget event chains; the
  registry covers list-of-callbacks-with-names. Two distinct
  patterns; don't merge them speculatively.
- **Auto-registration via decorators or a `@Cache` mixin.** The
  fluent `register(...)` chain is plenty for ten entries. Revisit if
  the count grows past ~30.
- **Touching `WebGPUDeviceLossRecovery`.** Its
  `DeviceLossRecoveryHost` contract still calls `_clearAllCaches`;
  the implementation behind the name is what changes.

## Branch & commit

- Work on `main` directly.
- Single commit titled
  `Batch 131 — WebGPUContext decomposition: extract resource-cache registry`.
- Push to origin/main after all five verification commands pass.

## Estimated effort

~30-45 minutes. Slightly more than Batch 130 because the registration
block is verbose (10 entries) and there's a new init-time call site
to wire up correctly.
