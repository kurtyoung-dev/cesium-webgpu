> **STATUS: SHIPPED — ARCHIVED 2026-05-30.** This decomposition plan was executed and landed; retained as rationale-of-record, not live work. Index: `migration_doc/README.md`; live roll-up: `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`.

# Batch 132 Plan — Extract WebGPU feature-flag plumbing

**Source:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
candidate #4.
**Status:** Plan only. No code changes yet.
**Predecessors:** Batches 127, 129, 130, 131.

## Goal

Pull the WebGPU optional-feature subsystem out of `WebGPUContext` into
a dedicated helper class:

```text
packages/engine/Source/Renderer/WebGPU/WebGPUFeatureFlags.ts
```

Code being extracted (`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`,
post-Batch 131):

- `static DESIRED_FEATURES` constant at **lines 1612-1635** (24 lines
  including comments).
- `_enabledFeatures: Set<string>` field at **line 305**.
- `_buildFeatureList(adapter)` method at **lines 1646-1660** (15 lines).
- `_updateFeatureFlags()` method at **lines 1668-1713** (~45 lines).
- `hasFeature(name)` method at **lines 1730-1732** (3 lines).
- `enabledFeatures` getter at **lines 1738-1740** (3 lines).
- The two assignment sites in `_initialize`:
  - **line 696** (build request list).
  - **line 801** (record enabled set from device).
- The diagnostic filter at **lines 803-806** (uses `_enabledFeatures.has`).

Net effect:

- `WebGPUContext.ts`: ~4182 → ~4090 lines (~−90 LOC). Possibly
  smaller win in practice, accounting for the registration block
  shape we saw bloat Batch 131.
- New module: ~120 lines (class with `DESIRED_FEATURES` + 4 methods +
  2 accessors + JSDoc).
- The Context retains:
  - The cap-flag side-effects in `_updateFeatureFlags` (because the
    flags `textureFloatLinear`, `_s3tc`, `_bc7`, `etc`, `astc`, etc.
    are read all over the renderer — moving them is a separate
    multi-batch refactor).
  - The public `hasFeature` / `enabledFeatures` API as 1-line
    delegators so external callers don't need to update.

## Why this candidate next

- **Cleanest API surface yet.** The feature-flag subsystem already
  has well-defined inputs (adapter, user-requested set) and outputs
  (request list, enabled Set, `has(name)` predicate). It's textbook
  "facade in front of a Set + a constant".
- **Static feature list belongs with its consumers.** `DESIRED_FEATURES`
  is currently a `private static readonly` on Context; in the new
  module it can be a top-level `const` next to the helper that uses
  it. Easier to find, easier to extend.
- **Largest LOC reduction available** of the remaining decomposition
  candidates (~90 LOC vs. ~20-26 for #2/#3/#5/#6). Worth doing while
  the pattern is fresh.
- **Reusable for future feature-detection probes.** A future
  capability like "subgroups + subgroup-broadcast" two-tier check can
  add to the helper without touching Context.

## External call sites (verified)

Pre-flight grep over `packages/engine/Source/`:

- `context.hasFeature(...)` — only called from inside
  `WebGPUContext.ts` (debug snapshot at lines 3721-3730 + 3743). No
  cross-file callers.
- `context.enabledFeatures` getter — only callsite is inside
  `WebGPUContext.ts`'s debug snapshot. No cross-file callers.
- `context._enabledFeatures` (private, direct access) — six callsites,
  all inside `WebGPUContext.ts`.

The public method/getter signatures `hasFeature(name)` / `enabledFeatures`
are preserved exactly. Only the implementation moves.

## Concrete steps

### 1. Create the new module

`packages/engine/Source/Renderer/WebGPU/WebGPUFeatureFlags.ts`:

```ts
/**
 * WebGPU optional-feature plumbing for `WebGPUContext`.
 *
 * Extracted from `WebGPUContext.DESIRED_FEATURES` /
 * `_buildFeatureList` / `_updateFeatureFlags` / `_enabledFeatures` /
 * `hasFeature` / `enabledFeatures` as Batch 132 of the audit-
 * recommended Context decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` for the
 * roadmap and `migration_doc/BATCH_132_PLAN_FEATURE_FLAGS.md` for
 * this specific extraction.
 *
 * Responsibilities:
 *   - Owns `DESIRED_FEATURES` — the priority-ordered list of
 *     CesiumJS-relevant WebGPU optional features.
 *   - Builds the `requiredFeatures` array passed to
 *     `adapter.requestDevice` by merging user-requested features
 *     with auto-detected adapter-supported entries from
 *     DESIRED_FEATURES.
 *   - Records which features the device actually granted (so
 *     `has(name)` can answer cheaply later).
 *
 * What it deliberately does NOT do:
 *   - It does NOT mutate Context cap flags (`textureFloatLinear`,
 *     `_s3tc`, etc.). Those are read across the renderer; moving
 *     them is a separate multi-batch refactor. Context's
 *     `_updateFeatureFlags()` keeps the flag-mapping logic and just
 *     reads through `this._featureFlags.has(...)` instead of
 *     `this._enabledFeatures.has(...)`.
 *
 * @module WebGPUFeatureFlags
 */

/**
 * Priority-ordered list of optional WebGPU features that CesiumJS
 * benefits from. Each is only requested if the adapter supports it.
 * Comments below pair each entry with the work item that consumes
 * it; keep these in sync when capability flags get added or
 * retired.
 */
export const DESIRED_FEATURES: GPUFeatureName[] = [
  // C1: Terrain heightmaps use float32 textures — enables HW
  // bilinear filtering.
  "float32-filterable" as GPUFeatureName,
  // C3: Native GPU clip planes for ClippingPlaneCollection
  // (Chrome 128+).
  "clip-distances" as GPUFeatureName,
  // C4: Weighted-average OIT in single render pass (Chrome 128+).
  "dual-source-blending" as GPUFeatureName,
  // I4: HDR render targets for post-processing (Chrome 121+).
  "rg11b10ufloat-renderable" as GPUFeatureName,
  // I6: GPU-side performance profiling (Chrome 121+).
  "timestamp-query" as GPUFeatureName,
  // I5: Half-precision floats in shaders.
  "shader-f16" as GPUFeatureName,
  // I1: GPU-driven rendering with indirect draw calls (Chrome 128+).
  "indirect-first-instance" as GPUFeatureName,
  // S4: SIMD-like subgroup operations for compute shaders
  // (Chrome 132+).
  "subgroups" as GPUFeatureName,
  // BGRA8 storage textures for compute-based post-processing.
  "bgra8unorm-storage" as GPUFeatureName,
  // Texture compression formats (requested if adapter supports them).
  "texture-compression-bc" as GPUFeatureName,
  "texture-compression-etc2" as GPUFeatureName,
  "texture-compression-astc" as GPUFeatureName,
];

export class WebGPUFeatureFlags {
  private _enabled: Set<string> = new Set();

  /**
   * Build the `requiredFeatures` array to pass to
   * `adapter.requestDevice({ requiredFeatures: ... })`. Merges the
   * user-requested features with auto-detected adapter-supported
   * entries from {@link DESIRED_FEATURES}.
   *
   * Pure function over its inputs — no internal state is touched.
   * Call after the adapter is acquired and before requestDevice.
   *
   * @param adapter - The acquired GPUAdapter.
   * @param userRequested - Optional user-supplied required features
   *   (typically `WebGPUContextOptions.requiredFeatures`). Forwarded
   *   verbatim into the result.
   */
  buildRequestList(
    adapter: GPUAdapter,
    userRequested?: readonly GPUFeatureName[],
  ): GPUFeatureName[] {
    const features = new Set<GPUFeatureName>(userRequested ?? []);
    for (const feature of DESIRED_FEATURES) {
      if (adapter.features.has(feature)) {
        features.add(feature);
      }
    }
    return Array.from(features);
  }

  /**
   * Record which features the freshly-created device actually
   * granted. Replaces any prior recorded state — call once per
   * device init (and again after device-loss recovery to refresh
   * from the new device).
   *
   * @param deviceFeatures - The `device.features` Set from the
   *   newly-created GPUDevice.
   */
  markEnabled(deviceFeatures: ReadonlySet<string>): void {
    this._enabled = new Set(deviceFeatures);
  }

  /**
   * Check if a specific WebGPU feature is enabled on the device.
   *
   * @param featureName - Feature name (e.g. `'float32-filterable'`,
   *   `'clip-distances'`, `'dual-source-blending'`,
   *   `'timestamp-query'`, `'shader-f16'`).
   */
  has(featureName: string): boolean {
    return this._enabled.has(featureName);
  }

  /** All currently-enabled feature names, in arbitrary order. */
  get enabledList(): string[] {
    return Array.from(this._enabled);
  }

  /**
   * Read-only view of the enabled set. Useful for callers that want
   * to do their own bulk filtering (e.g. "list every requested
   * feature that was actually granted").
   */
  get enabled(): ReadonlySet<string> {
    return this._enabled;
  }

  /** Drop the enabled set. Used by the Context's destroy path. */
  clear(): void {
    this._enabled = new Set();
  }
}

export default WebGPUFeatureFlags;
```

### 2. Update `WebGPUContext.ts`

#### 2a. Add the import

Alongside the Batch-127/129/130/131 helper imports near the top:

```ts
import { WebGPUFeatureFlags } from "./WebGPUFeatureFlags.js";
```

#### 2b. Replace the `_enabledFeatures` field with a flags instance

Around line 305:

```ts
// WebGPU optional features that were successfully enabled.
// Body extracted to `WebGPUFeatureFlags` in Batch 132. The Context
// retains `hasFeature` / `enabledFeatures` as 1-line delegators so
// external callers and the debug snapshot don't move.
private _featureFlags = new WebGPUFeatureFlags();
```

#### 2c. Delete the static `DESIRED_FEATURES` block (lines 1612-1635)

It now lives in `WebGPUFeatureFlags.ts`. The Context never needs to
read it directly post-extraction.

#### 2d. Rewrite `_buildFeatureList` as a 1-line delegator

```ts
private _buildFeatureList(adapter: GPUAdapter): GPUFeatureName[] {
  return this._featureFlags.buildRequestList(
    adapter,
    this._options.requiredFeatures,
  );
}
```

Or inline the call at the `_initialize` site (line 696):

```ts
const requestedFeatures = this._featureFlags.buildRequestList(
  this._adapter,
  this._options.requiredFeatures,
);
```

**Recommendation:** inline at the call site and delete `_buildFeatureList`
entirely. There's only one caller (`_initialize`), so the wrapper
adds no value once the underlying logic moves out.

#### 2e. Replace the device-feature recording line in `_initialize`

```ts
// line 801 today:
this._enabledFeatures = new Set(this._device.features);

// becomes:
this._featureFlags.markEnabled(this._device.features);
```

#### 2f. Update the diagnostic filter at lines 803-806

```ts
const optionalEnabled = requestedFeatures.filter((f) =>
  this._featureFlags.has(f),
);
```

#### 2g. Update `_updateFeatureFlags()` body

Replace `this._enabledFeatures.has(...)` with `this._featureFlags.has(...)`
in the four branches (`float32-filterable`, `texture-compression-bc`,
`texture-compression-etc2`, `texture-compression-astc`). The
cap-flag side-effects stay in place — only the predicate source
changes.

#### 2h. Public delegators

```ts
hasFeature(featureName: string): boolean {
  return this._featureFlags.has(featureName);
}

get enabledFeatures(): string[] {
  return this._featureFlags.enabledList;
}
```

#### 2i. Optional: clear flags in destroy()

Mirror the Batch 130/131 lifecycle pattern:

```ts
// Inside destroy(), near the bus.clear() / cacheRegistry.clear() lines:
this._featureFlags.clear();
```

Trivial; drops the `_enabled` Set's reference. Probably overkill (the
Set is small and dies with the Context anyway), but consistent with
the established pattern. Track in commit message; not load-bearing.

### 3. Verification

Same gate as Batches 127/129/130/131:

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
  (Batch 124-131 baseline ~6150).
- b3dm: `tilesFeaturesLoaded=10, modelReady=true, primCacheKeyCount=1`
  (Batch 124-131 baseline).
- C-R9 pick: `featurePickIdCount=30, featurePickTexExists=true,
  featurePickFeaturesLength=30` (Batch 125-131 baseline).

Feature flags are exercised at init time (build request list, mark
enabled) and during `getDebugSnapshot()` calls (every `hasFeature`
read). The smokes don't call `getDebugSnapshot()`, but they DO go
through `_initialize`, so any breakage in build/mark surfaces as a
smoke-test failure. To exercise the flag-read path, manual probe
via `viewer.scene.context.hasFeature('shader-f16')` in the
DevTools console after a smoke run.

## Risks & mitigations

| Risk                                                                                                          | Mitigation                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESIRED_FEATURES` ordering matters (priority order for some hypothetical future iteration)                   | The list is preserved verbatim with comments intact. Iteration order in `buildRequestList` is unchanged.                                                                                                                                                                                                                            |
| `_initialize` reads `this._enabledFeatures.has(...)` BEFORE `markEnabled` runs (race during pre-init logging) | The `markEnabled` call (step 2e) replaces the existing `this._enabledFeatures = new Set(...)` line at the same `_initialize` site, line 801. Order of subsequent reads is preserved.                                                                                                                                                |
| External code does `context._enabledFeatures.has(...)` directly                                               | Pre-flight grep confirms zero cross-file callers. Internal Context callers are migrated as part of this batch.                                                                                                                                                                                                                      |
| `enabledFeatures` getter return type changes (was `string[]`, helper exposes both `enabledList` + `enabled`)  | The Context's public getter keeps its `string[]` return shape by delegating to `this._featureFlags.enabledList`. The new `enabled: ReadonlySet<string>` is purely internal to the helper.                                                                                                                                           |
| Capability cap flags (`textureFloatLinear` etc.) get out of sync because their writer (`_updateFeatureFlags`) reads from a different source | The flags class is the *only* place that records device features after this batch. `_updateFeatureFlags` reads through `this._featureFlags.has(...)`. There is no second source to drift against.                                                                                                                                  |
| Device-loss recovery doesn't re-call `markEnabled` after a new device is acquired                             | Pre-existing behaviour: today's recovery path also doesn't refresh `_enabledFeatures` from the new device's features. Both before and after this batch the assumption is that recovery yields a device with the same feature set — if it doesn't, that's a separate bug. Not introduced by this batch.                            |

## Out of scope for this batch

- **Moving the cap-flag side-effects out of Context.** `textureFloatLinear`,
  `_s3tc`, `_bc7`, `etc`, `astc` are read all over the renderer. A
  future batch could either move them onto a "Capabilities" struct
  or expose them via the flags class — both are bigger refactors
  than this one.
- **Adding new features to `DESIRED_FEATURES`.** Pure list move; no
  additions or removals.
- **Refreshing flags on device-loss recovery.** Pre-existing
  behaviour; would need its own fix and verification.

## Branch & commit

- Work on `main` directly.
- Single commit titled
  `Batch 132 — WebGPUContext decomposition: extract feature-flag plumbing`.
- Push to origin/main after all five verification commands pass.

## Estimated effort

~30-45 minutes. Slightly more touchpoints than Batch 130 (~6 sites
in WebGPUContext.ts get rewritten), but each is a 1-line swap. The
actual logic moves wholesale.
