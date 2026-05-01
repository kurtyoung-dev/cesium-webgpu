# Batch 129 Plan — Extract `_initializeWebGLStub` from `WebGPUContext.ts`

**Source:** `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` candidate #1.
**Status:** Plan only. No code changes yet.

## Goal

Move the 230-line `WebGPUContext._initializeWebGLStub()` method
(`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`, lines
**1761-1988** post-Batch 127) to its own module:

```text
packages/engine/Source/Renderer/WebGPU/WebGPUContextWebGLStubInit.ts
```

Net effect:

- `WebGPUContext.ts`: 4354 → ~4124 lines (−230 LOC).
- New module: ~250 lines (the state literal + a thin builder function).
- The Context method body collapses to one line:
  `this._gl = buildWebGLCompatibilityStub(this);`

## Why this candidate first

- **Mechanical, no semantic change.** The body is 95% a state-proxy
  literal handed to an already-extracted factory
  (`createWebGLCompatibilityStub`). No control-flow rewrites.
- **Clean API boundary already exists.** `WebGLStubState` is a public
  type in `Stubs/WebGLStubTypes.ts`. The extracted function consumes
  the Context, returns a stub. No new abstraction invented.
- **Largest single-method LOC reduction available** without touching
  semantics.

## Concrete steps

### 1. Promote the proxied private fields to public

The state proxy reads/writes these 26 `private` fields on the Context.
TypeScript will reject access from outside the class, so promote them
to `public _xxx` (matching the documented convention at
`WebGPUContext.ts:277-279`: *"Public underscore fields: these have
public getters but renderers also access the fields directly for
performance. Marking public is honest about the actual access pattern
across the WebGPU renderer module."*).

| Field | Current decl line |
| --- | --- |
| `_clearColor` | 491 |
| `_clearDepth` | 492 |
| `_clearStencil` | 493 |
| `_scissorTest` | 507 |
| `_depthTestEnabled` | 516 |
| `_depthWriteEnabled` | 517 |
| `_depthCompare` | 522 |
| `_blendEnabled` | 523 |
| `_cullFaceEnabled` | 524 |
| `_cullMode` | 525 |
| `_frontFace` | 526 |
| `_colorWriteMask` | 527 |
| `_blendSrc` | 528 |
| `_blendDst` | 529 |
| `_blendSrcAlpha` | 530 |
| `_blendDstAlpha` | 531 |
| `_blendOp` | 532 |
| `_blendOpAlpha` | 533 |
| `_boundVertexBuffer` | 547 |
| `_boundIndexBuffer` | 548 |
| `_activeTextureUnit` | 549 |
| `_textureBindings` | 550 |
| `_boundFramebuffer` | 554 |
| `_boundReadFramebuffer` | 555 |
| `_boundDrawFramebuffer` | 556 |
| `_boundRenderbuffer` | 557 |
| `_framebuffers` | 558 |

**Verified safe** by grep over `packages/engine/Source/` — no code
outside `WebGPUContext.ts` currently accesses any of these via
`ctx._xxx` / `context._xxx`. Promotion is purely a TS visibility
change with zero runtime effect.

### 2. Create the new module

`packages/engine/Source/Renderer/WebGPU/WebGPUContextWebGLStubInit.ts`:

```ts
/**
 * Builds the WebGL-compatibility stub that masquerades as a
 * WebGLRenderingContext for legacy JS resources (Texture.js, CubeMap.js,
 * Framebuffer.js, etc.) that read `context._gl.FLOAT`, `gl.RGBA`, etc.
 *
 * Extracted from `WebGPUContext._initializeWebGLStub` as Batch 129 of
 * the audit-recommended Context decomposition.
 *
 * The state object is a *live* proxy: getters/setters read/write
 * through to the Context's underscore-prefixed public fields. Keep it
 * a literal returned from the function — Cesium's stub modules expect
 * to mutate the object's slots directly (e.g.
 * `state.boundVertexBuffer = newBuffer` from texImage2D).
 */

import { copyTextureRegion as copyTextureRegionUtil } from "./WebGPUTextureCopyHelper.js";
import {
  createWebGLCompatibilityStub,
  type WebGLStubState,
} from "./WebGLCompatibilityStub.js";
import {
  webglToWebGPUBlendFactor,
  webglToWebGPUBlendOp,
  webglToWebGPUCompareFunction,
} from "./WebGPUStateConversions.js";
// (Re-uses the same imports the Context currently has; the caller-
// side import block in WebGPUContext.ts can drop these.)

/** Fields the stub needs to reach on the Context. */
export interface WebGLStubInitHost {
  // ── Read-only top-level GPU resources ──
  readonly _device: GPUDevice | null;
  readonly _context: GPUCanvasContext | null;
  readonly _currentCommandEncoder: GPUCommandEncoder | null;
  readonly _currentRenderPassEncoder: GPURenderPassEncoder | null;

  // ── Read/write proxied state (the 26 fields from §1) ──
  _activeTextureUnit: number;
  _textureBindings: Map<number, unknown>;
  _boundVertexBuffer: GPUBuffer | null;
  _boundIndexBuffer: GPUBuffer | null;
  _boundFramebuffer: unknown;
  _boundReadFramebuffer: unknown;
  _boundDrawFramebuffer: unknown;
  _boundRenderbuffer: unknown;
  readonly _framebuffers: Map<number, unknown>;
  _clearColor: { red: number; green: number; blue: number; alpha: number };
  _clearDepth: number;
  _clearStencil: number;
  _depthTestEnabled: boolean;
  _depthWriteEnabled: boolean;
  _depthCompare: GPUCompareFunction;
  _blendEnabled: boolean;
  _cullFaceEnabled: boolean;
  _cullMode: GPUCullMode;
  _frontFace: GPUFrontFace;
  _colorWriteMask: number;
  _blendSrc: GPUBlendFactor;
  _blendDst: GPUBlendFactor;
  _blendSrcAlpha: GPUBlendFactor;
  _blendDstAlpha: GPUBlendFactor;
  _blendOp: GPUBlendOperation;
  _blendOpAlpha: GPUBlendOperation;
  _scissorTest: boolean;

  // ── Methods the stub state delegates to ──
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  disableScissorTest(): void;
  copyTextureRegion(
    src: GPUTexture,
    dst: GPUTexture,
    sx: number,
    sy: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
  ): void;
}

export function buildWebGLCompatibilityStubFor(
  ctx: WebGLStubInitHost,
): ReturnType<typeof createWebGLCompatibilityStub> {
  const state: WebGLStubState = {
    // ── Live getters on read-only fields ──
    get device() { return ctx._device; },
    get context() { return ctx._context; },
    get currentCommandEncoder() { return ctx._currentCommandEncoder; },
    get currentRenderPassEncoder() { return ctx._currentRenderPassEncoder; },

    // ── Live get/set on each of the 26 promoted public fields ──
    get activeTextureUnit() { return ctx._activeTextureUnit; },
    set activeTextureUnit(v) { ctx._activeTextureUnit = v; },
    get textureBindings() { return ctx._textureBindings; },
    // ... (all 26 fields, mechanical translation of the existing literal)

    // ── Stub-local state (not mirrored on the context) ──
    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },
    stencilTestEnabled: false,
    stencilFrontCompare: "always",
    stencilBackCompare: "always",
    stencilReadMask: 0xff,
    stencilWriteMask: 0xff,
    stencilReference: 0,
    stencilFailOp: "keep",
    stencilDepthFailOp: "keep",
    stencilPassOp: "keep",
    mipmapGenerator: null,

    // ── Methods that delegate to Context methods ──
    setViewport: (x, y, w, h) => ctx.setViewport(x, y, w, h),
    setScissorRect: (x, y, w, h) => ctx.setScissorRect(x, y, w, h),
    disableScissorTest: () => ctx.disableScissorTest(),
    copyTextureRegion: (src, dst, sx, sy, dx, dy, w, h) =>
      ctx.copyTextureRegion(src, dst, sx, sy, dx, dy, w, h),
    webglToWebGPUBlendFactor,
    webglToWebGPUBlendOp,
    webglToWebGPUCompareFunction,
  };

  return createWebGLCompatibilityStub(state);
}
```

### 3. Drop the wrapper conversions if possible

The current `_webglToWebGPUBlendFactor`, `_webglToWebGPUBlendOp`,
`_webglToWebGPUCompareFunction` private methods on the Context exist
*only* to feed the state literal. Once the literal moves out, these
three wrappers can be deleted from `WebGPUContext.ts` (lines
3176-3193 post-Batch 127 — verify line numbers before editing) — the
extracted module imports the module-level functions directly. Net
extra savings: ~18 LOC.

**Risk:** any code calling
`(context as WebGPUContext)._webglToWebGPUBlendFactor(...)` from
outside Context. Check via `grep -rn "_webglToWebGPU" packages/`
before deletion. (Initial check shows only Context internals; verify
again at execution time.)

### 4. Update `WebGPUContext.ts`

Replace the body of `_initializeWebGLStub` (1761-1988) with:

```ts
private _initializeWebGLStub(): void {
  this._gl = buildWebGLCompatibilityStubFor(this);
}
```

Drop these imports from the top of the file (now consumed only by the
new module):

- `createWebGLCompatibilityStub`
- `WebGLStubState` (type-only)
- `webglToWebGPUBlendFactor`, `webglToWebGPUBlendOp`,
  `webglToWebGPUCompareFunction` (only if §3 deletes the wrappers)
- `copyTextureRegion as copyTextureRegionUtil` (only if it's not used
  elsewhere — `grep -n "copyTextureRegionUtil" WebGPUContext.ts`
  before removing)

Keep `_gl!: ReturnType<typeof createWebGLCompatibilityStub>` field
declaration; the type is fine to import for the field annotation alone.

### 5. Verification

Order matters — fail fast on the cheap checks before running tests.

```bash
npx tsc --noEmit                              # ~30s — must pass clean
npx gulp build                                # ~50s — emits Cesium*.js
node Tools/visual-regression/verify-glb-side-by-side.mjs   # ~60s
node Tools/visual-regression/verify-b3dm-render.mjs        # ~120s
node Tools/visual-regression/verify-model-feature-pick.mjs # ~120s
```

**Pass criteria:**

- `tsc` reports zero errors.
- glb side-by-side: WebGPU renders the airplane silhouette with at
  least 5000 non-bg pixels at `(149, 149, 149)` (matches Batch 124
  baseline).
- b3dm: building rooftops visible (non-zero count of `(149, 149, 149)`
  cluster).
- C-R9 probe: `featurePickIdCount: 30, featurePickTexExists: true`
  (matches Batch 125 baseline).

Don't proceed to commit if any of those regress.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Promoting 26 private fields to public widens the API surface | Match existing convention (`public _device`, `public _frameCount`, etc.). Document in commit message. |
| `WebGLStubInitHost` interface drifts from real Context as new fields arrive | Keep the interface in the same file as the builder; future field additions to the stub will surface as TS errors against the interface, forcing both sites to update. |
| The stub state holds a long-lived reference to the Context via `ctx` | Identical to the current behavior — the literal already captures `ctx = this` in a closure. No GC change. |
| Some `private` field is actually accessed by another file via TS structural typing or a cast | Pre-execution grep. Initial scan found zero callers; re-verify before promoting. |

## Out of scope for this batch

- Other candidates from
  `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` (#2-#6) — keep
  one batch per extraction so regressions bisect cleanly.
- Renaming the underscore-prefixed fields. They stay
  `public _foo`, matching the rest of the file's convention.
- Touching `WebGPUSceneRenderer.ts`. Separate batch.

## Branch & commit

- Work on `main` directly (per the repo's trunk-only convention).
- Single commit titled
  `Batch 129 — WebGPUContext decomposition: extract _initializeWebGLStub`.
- Push to origin/main after all five verification commands pass.

## Estimated effort

One session. The bulk of the work is the mechanical proxy literal
move; verification is the longer pole.
