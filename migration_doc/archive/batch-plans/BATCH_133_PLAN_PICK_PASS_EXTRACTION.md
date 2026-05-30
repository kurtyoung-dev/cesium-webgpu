> **STATUS: SHIPPED — ARCHIVED 2026-05-30.** This decomposition plan was executed and landed; retained as rationale-of-record, not live work. Index: `migration_doc/README.md`; live roll-up: `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`.

# Batch 133 Plan — Extract `_executePickPass` from `WebGPUSceneRenderer`

**Source:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`
SceneRenderer candidate "Pick path".
**Status:** Plan + execute (auto mode).
**Predecessors:** Batches 127, 129, 130, 131, 132 (all on
`WebGPUContext`). This is the first SceneRenderer extraction.

## Goal

Move `WebGPUSceneRenderer`'s pick-pass orchestration to its own
module:

```text
packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts
```

Scope (`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`):

- `_executePickPass(config)` at **lines 1707-1860** (154 lines).
- `_executePickBatch(...)` at **lines 1866-1907** (42 lines, only
  caller is `_executePickPass` — pre-flight grep confirmed).
- `_updateFrustumUniforms` at **lines 1911-1933** stays on the
  SceneRenderer — it's also called from `executeCommands` at lines
  1287 and 1488. The pick path will reach back to it via a host
  interface.

Net effect:

- `WebGPUSceneRenderer.ts`: 3626 → ~3430 lines (~−196 LOC).
- New module: ~210 lines.
- The Context/SceneRenderer keeps the public `executeCommands(config)`
  signature; the only change is that `executeCommands`'s `if (picking)`
  branch now calls `executePickPass(this, config)` from the new
  module instead of `this._executePickPass(config)`.

## Why this candidate

- **Largest single audit-recommended extraction** that's still
  self-contained (~196 LOC vs. up to ~705 for `executeCommands`,
  which is the central orchestration spine and high-risk).
- **Fully isolated.** `_executePickBatch` is only called from
  `_executePickPass`. Pick FBO setup happens outside the SceneRenderer
  in `WebGPUPickFramebuffer`; the pick pass just consumes the
  `passState.framebuffer` it's handed.
- **Closes a SceneRenderer audit bullet.** The architecture audit
  explicitly listed "pick path" as a self-contained extraction
  candidate roughly 400 LOC; pre-flight measurement shows the
  in-SceneRenderer portion is 196 LOC. The remaining ~200 LOC
  estimated in the audit lives in `WebGPUPickFramebuffer.ts` already
  — that file is its own thing and doesn't need extraction.

## External / cross-method call sites (verified)

- `_executePickPass` — single caller: `executeCommands` line 1007.
- `_executePickBatch` — six callers, ALL inside `_executePickPass`.
- `_updateFrustumUniforms` — three callers: `_executePickPass` line
  1779, `executeCommands` line 1287, `executeCommands` line 1488.
  **Two of three callers stay on SceneRenderer**, so the helper
  stays. The pick-path call becomes a host-callback.

## Module shape

```ts
// WebGPUSceneRendererPickPass.ts

import Pass from "../../Scene/Pass.js";
import { selectCommandVariant } from "./WebGPUDerivedCommandSelector.js";  // verify import path
import type { /* CesiumScene, CesiumPassState, ... */ } from "...";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPURenderFrameConfig } from "./WebGPURenderFrameConfig.js";

/**
 * Host interface — the SceneRenderer's surface that the extracted
 * pick path reaches back to. Keeps the dependency arrow pointing
 * SceneRenderer → PickPass, never the reverse.
 */
export interface PickPassHost {
  /**
   * Apply the given near/far to the camera frustum and refresh the
   * uniform state's projection matrix without permanently mutating
   * the camera frustum (it stores originals, applies, refreshes,
   * restores).
   */
  updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void;
}

export function executePickPass(
  host: PickPassHost,
  config: WebGPURenderFrameConfig,
): void {
  // ... body of _executePickPass, with `this._updateFrustumUniforms(...)`
  //     replaced by `host.updateFrustumUniforms(...)` and
  //     `this._executePickBatch(...)` replaced by an internal
  //     `executePickBatch(...)` helper in the same file.
}

function executePickBatch(
  frustumCommands: CesiumFrustumCommands,
  passIndex: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
  pickRenderPass: GPURenderPassEncoder,
): void {
  // ... body of _executePickBatch, unchanged.
}
```

## Concrete steps

1. **Create `WebGPUSceneRendererPickPass.ts`** with `PickPassHost`
   interface, `executePickPass` exported function, and
   module-private `executePickBatch` helper. Body lifted verbatim
   from the SceneRenderer methods with two replacements:
   - `this._updateFrustumUniforms(...)` → `host.updateFrustumUniforms(...)`
   - `this._executePickBatch(...)` → `executePickBatch(...)`

2. **Make SceneRenderer expose `updateFrustumUniforms` publicly** (or
   add it to a host adapter). Currently `_updateFrustumUniforms` is
   `private`. Cleanest path: rename to `public updateFrustumUniforms`
   matching the public-underscore-fields convention used elsewhere
   in the renderer module. The two internal callers
   (`executeCommands` at 1287 and 1488) still work; they just call
   `this.updateFrustumUniforms(...)` (or `this._updateFrustumUniforms`
   if I keep the underscore for ABI symmetry).

   **Preferred:** keep the underscore prefix to signal "internal
   despite being public" — `public _updateFrustumUniforms(...)`,
   matching the `public _device` / `public _frameCount` convention
   on WebGPUContext.

3. **Replace `_executePickPass` body in SceneRenderer** with a
   1-line delegator:
   ```ts
   private _executePickPass(config: WebGPURenderFrameConfig): void {
     executePickPass(this, config);
   }
   ```
   Or inline the call at the `executeCommands` site (line 1007) and
   delete the private method entirely. **Inline preferred** —
   matches the Batch 132 pattern of dropping single-caller wrappers.

4. **Delete `_executePickBatch`** from SceneRenderer (now lives in
   the new file as a module-private function).

5. **Verify**:
   - `npx tsc --noEmit` clean.
   - `npx gulp build` clean.
   - glb side-by-side: airplane silhouette ≥ 5000 px (current
     baseline ~6160).
   - b3dm: `tilesFeaturesLoaded=10, modelReady=true,
     primCacheKeyCount=1`.
   - C-R9 pick: `featurePickIdCount=30, featurePickTexExists=true,
     featurePickFeaturesLength=30`. **The C-R9 pick smoke is the
     load-bearing test for this batch** — it actually exercises the
     pick path end-to-end.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `selectCommandVariant` import path differs in the new file | Pre-flight grep confirms it lives in `./WebGPUDerivedCommandSelector` (re-verify at execution time). |
| `Pass` enum import path | `../../Scene/Pass.js` — same as the existing import in `WebGPUSceneRenderer.ts`. |
| `_updateFrustumUniforms`'s internal callers break after rename | Leave the name as `_updateFrustumUniforms` (just flip `private` → `public`). No internal call-site changes required. |
| Pick FBO state read via `passState?.framebuffer` cast — type drift | The cast narrows to `CesiumOpaqueFramebuffer & { _isWebGPUPickFBO?: boolean; colorView?; depthView? }`. Lift the inline type alias into a named `WebGPUPickFBOShape` in the new module for readability. |
| `context._currentRenderPassEncoder` direct write (line 1770, 1856) | Already public on Context (verified previously). No change needed. |
| C-R9 smoke regresses because pick-id resolution depends on `selectCommandVariant` reaching the right pick variant | The new module imports the same `selectCommandVariant` and calls it with the same `(command, scene, true)` arguments. Behaviour is preserved exactly. |

## Out of scope

- Changing pick FBO allocation. That lives in
  `WebGPUPickFramebuffer.ts` already.
- Touching `_updateFrustumUniforms` body — copy of behaviour stays;
  visibility flip only.
- Decomposing `executeCommands` (the ~705-line orchestration spine)
  — separate, higher-risk batch.

## Effort

~30 minutes. Bigger than Batch 132 because there's a host-interface
to wire, but mechanical otherwise.

## Branch & commit

- `main`, single commit: `Batch 133 — WebGPUSceneRenderer
  decomposition: extract pick pass`.
- Push after verification.
