> **STATUS: SHIPPED — ARCHIVED 2026-05-30.** This decomposition plan was executed and landed; retained as rationale-of-record, not live work. Index: `migration_doc/README.md`; live roll-up: `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`.

# Batch 130 Plan — Extract device-invalidation subscriber registry

**Source:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
candidate #2.
**Status:** Plan only. No code changes yet.
**Predecessor:** Batch 129 (`_initializeWebGLStub` extraction).

## Goal

Move `WebGPUContext`'s device-invalidation subscriber pattern to its
own helper class:

```text
packages/engine/Source/Renderer/WebGPU/WebGPUDeviceInvalidationBus.ts
```

Code being extracted (`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`,
post-Batch 129):

- Field at **line 4070**: `private _deviceInvalidatedListeners = new Set<() => void>();`
- Method at **lines 4076-4081**: `onDeviceInvalidated(callback): () => void`
- Method at **lines 4089-4100**: `private _fireDeviceInvalidated(): void`
- One callsite of `_fireDeviceInvalidated` inside `_clearAllCaches`
  (line **4066**).

Net effect:

- `WebGPUContext.ts`: 4134 → ~4108 lines (−~26 LOC).
- New module: ~70 lines (a small class with `subscribe` + `fire` + a
  `size` accessor for tests, plus JSDoc).
- The Context keeps **identical public API**: `onDeviceInvalidated`
  remains a method, `_fireDeviceInvalidated` remains the internal
  trigger. Both delegate to the bus instance.

## Why this candidate next

- **Smallest extraction available** (~26 LOC moved). After the meatier
  Batch 129, this is a quick confidence-builder that the decomposition
  pattern works for plain subscriber/observer code with no Context-
  specific state.
- **Zero behavior change.** The bus is a literal hoist of three lines
  of state into a class — no method-resolution-order shuffles, no
  visibility changes, no API surface adjustments to consumers. The
  only thing the bus needs from the host is a `string` for the error
  log prefix.
- **Reusable.** Once extracted, the same pattern could host a future
  device-lost subscriber set, a frame-end callback set, or any other
  fire-and-forget event chain on the Context. Today the registry is
  a Context-private detail; afterward it's a named helper available
  for the next subscriber pattern that arrives.

## External call sites (verified)

- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:747`
  — `context.onDeviceInvalidated(() => { ... })`
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — 8
  internal callsites (lines 3486, 3576, 3729, 3744, 3759, 3774, 3807,
  3834) all use `this.onDeviceInvalidated(...)` to wire subsystem-
  owned cache clears.

The contract is `onDeviceInvalidated(cb): () => void` (returns an
unsubscribe function). **Preserved exactly** — extraction is
implementation-only.

`_fireDeviceInvalidated` is invoked only from the Context's own
`_clearAllCaches`, line 4066. The new bus method lives on the
Context as a one-line delegator so internal callers (and the future
device-loss recovery path that re-fires after recovery) don't have
to thread a bus reference around.

## Concrete steps

### 1. Create the new module

`packages/engine/Source/Renderer/WebGPU/WebGPUDeviceInvalidationBus.ts`:

```ts
/**
 * Subscriber bus for device-invalidation events on a WebGPU context.
 *
 * Extracted from `WebGPUContext._deviceInvalidatedListeners` /
 * `onDeviceInvalidated` / `_fireDeviceInvalidated` as Batch 130 of
 * the audit-recommended Context decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` for the
 * roadmap and `migration_doc/BATCH_130_PLAN_DEVICE_INVALIDATION_BUS.md`
 * for this specific extraction.
 *
 * Originally landed under C-R12 (Batch 33). The bus fires once per
 * device-loss event after the Context-owned caches drop their stale
 * GPU handles, giving subscribed subsystems a single hook to do the
 * same with their private caches.
 *
 * Subscriber errors are caught + logged so one failing subscriber
 * doesn't block the rest from cleaning up. The error log includes
 * the owning context's id (or "?" if unset) so multi-context setups
 * can attribute the failure.
 *
 * @module WebGPUDeviceInvalidationBus
 */

export class WebGPUDeviceInvalidationBus {
  private listeners = new Set<() => void>();
  private contextIdProvider: () => string | undefined;

  /**
   * @param contextIdProvider - Returns the owning context's id when
   *   called. Provided as a callable rather than a string snapshot
   *   so the bus picks up changes (e.g. id assignment after the
   *   bus is constructed during early Context init).
   */
  constructor(contextIdProvider: () => string | undefined) {
    this.contextIdProvider = contextIdProvider;
  }

  /**
   * Register a subscriber. Returns an unsubscribe function. Idempotent
   * over a given `callback` reference: a second subscribe with the
   * same callback is a no-op (Set semantics).
   */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Dispatch the invalidation event to every subscriber. Individual
   * subscriber errors are caught + logged so one failing subsystem
   * doesn't block the rest from cleaning up.
   */
  fire(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        const id = this.contextIdProvider() ?? "?";
        console.error(
          `[WebGPU:ctx-${id}] Device-invalidation subscriber threw:`,
          e,
        );
      }
    }
  }

  /**
   * Number of currently-registered subscribers. Exposed for
   * diagnostics + tests; not part of the production hot path.
   */
  get size(): number {
    return this.listeners.size;
  }

  /**
   * Drop all subscribers. Used by the Context's destroy path so a
   * destroyed Context doesn't keep references to long-lived
   * subscriber closures.
   */
  clear(): void {
    this.listeners.clear();
  }
}
```

### 2. Update `WebGPUContext.ts`

Replace the existing field + two methods with:

```ts
// Import alongside the other Batch-127/129 helper imports near
// the top of the file:
import { WebGPUDeviceInvalidationBus } from "./WebGPUDeviceInvalidationBus.js";

// Field declaration (replaces line 4070):
//   `_deviceInvalidatedListeners = new Set<() => void>()`
// becomes:
private _deviceInvalidationBus = new WebGPUDeviceInvalidationBus(
  () => this.id,
);

// Method (replaces lines 4076-4081):
onDeviceInvalidated(callback: () => void): () => void {
  return this._deviceInvalidationBus.subscribe(callback);
}

// Method (replaces lines 4089-4100):
private _fireDeviceInvalidated(): void {
  this._deviceInvalidationBus.fire();
}
```

The `() => this.id` lambda is a thunk so the bus reads the id at fire
time, not construction time. (`id` is set early on the
`GraphicsContext` base, so a snapshot would also work — but the
thunk is cheaper than thinking about ordering and matches the
original behaviour, which read `this.id` per fire call at line 4095.)

### 3. Optional: clear bus in destroy path

The original code never explicitly cleared the listener Set on Context
destroy — relying on GC of the Context object to release the listener
closures. The new `bus.clear()` makes that explicit. Two options:

- **A. Match original behaviour.** Don't call `bus.clear()` in
  `destroy()`. Listeners drop on Context GC.
- **B. Tighten lifetime.** Call `this._deviceInvalidationBus.clear()`
  inside `WebGPUContext.destroy()` so subscriber closures are dropped
  immediately, even if some long-lived holder keeps the Context
  reference alive.

**Recommendation:** option B. Trivial 1-line addition; mirrors the
pattern used by `_clearAllCaches` (which already explicitly clears
sub-caches rather than relying on GC). Track in commit message; not a
behaviour change visible to subscribers since they were already
expected to drop their refs in their own callback when fired.

If chosen, locate the existing `destroy()` method (currently around
lines 3082-3175 post-Batch 129; verify line numbers at execution
time) and add the `bus.clear()` call near the existing cache-clearing
section.

### 4. Verification

Same gate as Batch 129:

```bash
npx tsc --noEmit                                        # ~30s
npx gulp build                                          # ~50s
node Tools/visual-regression/verify-glb-side-by-side.mjs   # ~60s
node Tools/visual-regression/verify-b3dm-render.mjs        # ~120s
node Tools/visual-regression/verify-model-feature-pick.mjs # ~120s
```

**Pass criteria:**

- `tsc` clean.
- Build clean.
- glb side-by-side: airplane silhouette ≥ 5000 px at `(149, 149, 149)`
  (Batch 124-129 baseline ~6150).
- b3dm: `tilesFeaturesLoaded=10, modelReady=true, primCacheKeyCount=1`
  (Batch 124-129 baseline).
- C-R9 pick: `featurePickIdCount=30, featurePickTexExists=true,
  featurePickFeaturesLength=30` (Batch 125-129 baseline).

The bus is on the device-loss recovery path, not the steady-state
render path — so the smoke tests don't exercise it directly. They
DO exercise that the constructor wiring works (the bus is
instantiated as part of every Context init), so any TS / runtime
breakage during init surfaces as a smoke-test failure. To exercise
the fire path itself, the existing `WebGPUDeviceLossRecovery` Jasmine
suite (`Specs/Renderer/WebGPU/WebGPUDeviceLossRecovery*Spec.js` —
verify exact filename at execution time) is the canonical coverage.

## Risks & mitigations

| Risk                                                                              | Mitigation                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscriber added before bus instantiation                                         | The bus is a class field with a default initialiser, so it's constructed before any constructor body runs. Same lifecycle as the original `Set` field declaration.      |
| `this.id` thunk fires too early (id not yet set)                                  | Original code already handles this — line 4095 read `this.id ?? "?"`. Preserve the same fallback in the bus's `fire()` body.                                            |
| Existing 8 internal callsites of `this.onDeviceInvalidated(...)` break            | Method signature is preserved exactly. Internal callsites are unchanged.                                                                                                |
| `_clearAllCaches` calls `this._fireDeviceInvalidated()` and breaks if rewired     | The new method is a 1-line delegator with the same name and signature. Not a breaking change.                                                                           |
| Thunk binding: `() => this.id` captures `this` at construction — works as expected | TS arrow inside a class field initialiser captures the lexical `this` of the enclosing class. Verified pattern; no `function`-style binding pitfall.                    |

## Out of scope for this batch

- Changing the bus's public API to take typed event payloads (today
  it's parameterless — `() => void`). Keep the contract identical.
- Promoting the bus to a generic `EventBus<T>` for reuse. Tempting,
  but the next subscriber pattern hasn't materialised yet; one
  concrete consumer first, then generalise.
- Touching the `WebGPUDeviceLossRecovery` adapter (`_setupDeviceLostHandler`,
  `_clearAllCaches`). Their `_fireDeviceInvalidated` callsite stays
  inside `_clearAllCaches`; only the implementation behind that name
  changes.

## Branch & commit

- Work on `main` directly.
- Single commit titled
  `Batch 130 — WebGPUContext decomposition: extract device-invalidation subscriber bus`.
- Push to origin/main after all five verification commands pass.

## Estimated effort

~30 minutes. Bus is small, callsites are narrow, no shader / pipeline
work required.
