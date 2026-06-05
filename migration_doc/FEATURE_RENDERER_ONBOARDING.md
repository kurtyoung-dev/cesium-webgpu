# Feature Renderer Onboarding — Adding a New Feature Renderer to the WebGPU Backend

_Derived from live code (2026-06-05). Source of truth:_
`packages/engine/Source/Renderer/FeatureRendererKey.js`,
`packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts`,
`packages/engine/Source/Renderer/GraphicsContext.ts`.
Keep this doc in sync when those files change.

---

## What a Feature Renderer is

A **Feature Renderer (FR)** is the unit of backend-specific rendering in this
fork. Scene code never imports from `Renderer/WebGPU/`; instead it asks the
context for a renderer by an enumerated key:

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = frameState.context.getFeatureRenderer(FeatureRendererKey.SUN);
if (fr) {
  fr.update(this, frameState, frameState.commandList);
  return;
}
// WebGL fallback follows as the default path
```

This is the mechanism that satisfies CLAUDE.md Principle 2 (Backend
Agnosticism): the only system that knows the current backend is the renderer
layer. Scene files stay free of `if (context.isWebGPU)` branches and free of
WebGPU imports.

The registry lives on the abstract `GraphicsContext` base class
(`GraphicsContext.ts`), so both `Context.js` (WebGL) and `WebGPUContext.ts`
inherit the same registry API. WebGPU registers its implementations from
`registerWebGPUFeatureRenderers(context)`, which `WebGPUContext` calls once
during init (`WebGPUContext.ts:937`).

---

## The registry data model (read this first)

`GraphicsContext` stores three parallel arrays indexed by the numeric key
(O(1) lookup, no hashing):

- `_featureRenderers[key]` — the registered FR object (or `undefined`).
- `_featureRendererLoaders[key]` — a lazy `() => Promise<void>` loader.
- `_featureRendererStatus[key]` — a discriminated status:
  `{ kind: "registered" | "loading" | "loaded" | "failed" }`.

`getFeatureRenderer(key)` returns the FR synchronously if present; otherwise it
fires the lazy loader (fire-and-forget) and returns `undefined` **this frame**
so the caller's WebGL fallback runs. Once the dynamic import settles and calls
`registerFeatureRenderer`, subsequent frames get the real FR. `COUNT` in the
enum pre-sizes these arrays — it MUST equal the highest key + 1.

---

## Step 1 — Add a `FeatureRendererKey` enum entry

Edit `packages/engine/Source/Renderer/FeatureRendererKey.js`.

- **Append** the new key with the next free integer. Group it under a section
  comment matching the existing layout (`// ── Collections ──`, etc.).
- **Bump `COUNT`** to `highest key + 1`. The internal arrays are pre-allocated
  to `COUNT`; forgetting this leaves a hole.
- **Append-only discipline (mirrors the ShaderDefine rule).** Do **not**
  reorder or renumber existing keys — the values are baked into cache indices
  and every registration/lookup site. The file already documents one removed
  slot (`DEFERRED_GBUFFER` at old index 33) and the resulting shift; that kind
  of churn is to be avoided. If a key's last consumer disappears, leave the key
  with a comment rather than renumbering (see the `FOG` precedent — kept in the
  enum, intentionally unregistered).
- Document non-obvious keys with a short block comment explaining what the
  renderer does and what is/isn't shipped (the file is full of these — match
  the density).

---

## Step 2 — Write the WebGPU renderer module

Create the implementation under `packages/engine/Source/Renderer/WebGPU/`
(canonical source — never edit root `Source/`). Two shapes are in use; pick the
one that matches your feature.

### Shape A — free functions (most common)

Export `update` / `destroy` (and optionally `execute`, `composite`, `render`,
`createCommands`, `init`, `getStatistics`, …). Example from
`WebGPUEllipsoidPrimitiveRenderer.ts`:

```typescript
function updateWebGPUEllipsoidPrimitive(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void { /* build buffers/pipeline, push WebGPUDrawCommand(s) into
              frameState.commandList */ }

function destroyWebGPUEllipsoidPrimitiveResources(
  primitive: CesiumObjectWithWebGPUCache,
): void { /* destroy GPU buffers, clear primitive._webgpuCache */ }

export { updateWebGPUEllipsoidPrimitive, destroyWebGPUEllipsoidPrimitiveResources };
```

### Shape B — `RendererClass` constructor

For stateful system renderers (globe, scene orchestration), register a
`RendererClass` constructor that the context instantiates on first touch and
caches on `_instance` (see `GLOBE_SURFACE` → `WebGPUGlobeSurfaceRenderer`,
`SCENE_RENDERER` → `WebGPUSceneRenderer`).

Prefer TypeScript for new renderer code. Never use a single
`position: vec3<f32>`; use RTE `positionHigh`/`positionLow` and
`mvpRelativeToEye` (CLAUDE.md 64-bit precision section).

---

## Step 3 — Lifecycle method vocabulary

The FR registry is **duck-typed** — callers check for a method before calling
it, so an FR only implements the subset it needs. The base `FeatureRenderer`
interface (`GraphicsContext.ts`) plus the three sub-type interfaces define the
vocabulary:

- **`update(collection, frameState, ...args)`** — `CollectionRenderer`. The
  per-frame entry point and by far the most common (collections, environment,
  model, clipping, post-process). Builds resources and pushes draw commands.
- **`createCommands(...)` / `updateCommandUniforms(...)` / `createMaterial…` /
  `updatePickCommandUniforms(...)`** — `PrimitiveCommandRenderer` (the
  `PRIMITIVE` command factory and the ground/vector-tile classifiers).
- **`execute(...)`** — full-screen / post-process effects (SSR, NPR outlines,
  contact shadows, procedural clouds).
- **`composite(...)`** — a second pass run later in the frame (volumetric fog
  populates with `update`, then `composite`s into scene color).
- **`init(...)` / `dispatch(...)` / `readback(...)` / `getStatistics(...)`** —
  compute/system renderers (Hi-Z occlusion, GPU sort keys, shadow map,
  imagery reprojection).
- **`RendererClass` + `_instance`** — Shape B constructor pattern.
- **`destroy(collection?)`** — tear down GPU resources. Note: during *context*
  destruction the device teardown frees GPU resources automatically;
  `_destroyFeatureRenderers()` just nulls the slots. Per-object cleanup (e.g.
  destroying a collection) is what calls your `destroy` with the scene object.
- **`name`** — optional debug label; also used by **marker FRs** (see Step 6).

Implement only what your feature needs — there is no required method.

---

## Step 4 — Register: eager vs lazy

All registration happens in `registerWebGPUFeatureRenderers(context)` in
`WebGPUFeatureRenderers.ts`. Two registration calls exist:

### `registerFeatureRenderer(key, renderer)` — EAGER

Use when the renderer is small and/or on a core path (collections, primitive,
globe, model, clipping, IBL, environment). The module is statically imported at
the top of `WebGPUFeatureRenderers.ts`, so it lands in the main bundle.

```typescript
context.registerFeatureRenderer(FeatureRendererKey.ELLIPSOID_PRIMITIVE, {
  update: updateWebGPUEllipsoidPrimitive,
  destroy: destroyWebGPUEllipsoidPrimitiveResources,
});
```

You can pass closures that capture `context` for `init`/`getStatistics`-style
methods, or set `RendererClass` for Shape B. Calling `registerFeatureRenderer`
also clears any pending loader for the key and flips status to `"loaded"`.

### `registerFeatureRendererLoader(key, loader)` — LAZY

Use when the renderer pulls in heavy code (large WGSL, compute pipelines) that
should only download on first use. **Do not** statically import the module;
instead register a loader that dynamic-imports it and then calls
`registerFeatureRenderer` itself:

```typescript
context.registerFeatureRendererLoader(
  FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
  async () => {
    const mod = await import("./WebGPUSSREffect.js");
    context.registerFeatureRenderer(FeatureRendererKey.SCREEN_SPACE_REFLECTIONS, {
      execute: mod.executeSSR,
      destroy: mod.destroySSRResources,
    });
  },
);
```

Until the loader resolves, `getFeatureRenderer(key)` returns `undefined`, so the
scene falls back to WebGL for a frame or two. The loader fires exactly once
(in-flight calls are coalesced); a failed load is retried on the next access.
Current lazy entries: Gaussian splat, point cloud, point-cloud EDL, voxel, SSR,
NPR outlines, contact shadows, weather particles, procedural clouds.

**Rule of thumb:** opt-in / rarely-used / heavy-WGSL → lazy. Always-on / core /
tiny → eager.

---

## Step 5 — Consume from Scene (backend-agnostic + Scene-Logic-Extractor)

Scene code looks the FR up by key and delegates. The canonical shape, from
`Scene/Sun.js`:

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

update(frameState, passState, useHdr) {
  if (!this.show) return undefined;
  const mode = frameState.mode;
  if (mode === SceneMode.SCENE2D || mode === SceneMode.MORPHING) return undefined;
  if (!frameState.passes.render) return undefined;

  // Backend-specific rendering via Feature Renderer
  const fr = frameState.context.getFeatureRenderer(FeatureRendererKey.SUN);
  if (fr) {
    fr.update(this, frameState, frameState.commandList);
    return undefined;
  }
  // ... WebGL path continues as the default fallback ...
}
```

Two rules from CLAUDE.md govern this call site:

- **Backend agnosticism (Principle 2).** Scene files must NOT import from
  `Renderer/WebGPU/` and must NOT branch on `context.isWebGPU`. Go through
  `getFeatureRenderer(key)` and treat WebGL as the default fallback.
- **Scene-Logic-Extractor pattern (CRITICAL for collections).** Any shared,
  backend-neutral scene logic — `show` checks, scene-mode gating,
  `passes.render` gating, dirty tracking, visibility, bounding-volume
  computation — MUST run **before** the `getFeatureRenderer` branch point, as in
  the `Sun.update` example above. Do not duplicate that logic inside the FR;
  the FR receives an already-validated scene object and only does GPU work.

In `.ts` consumers, narrow the return type:
`const fr = context.getFeatureRenderer(key) as CollectionRenderer | undefined;`
(or use the `isCollectionRenderer` type guard). In `.js` consumers just call
the method directly.

---

## Step 6 — Marker FRs (no-render bridges)

Some keys register a **marker** FR carrying only `name` (optionally a
`createCommands` alias). The renderer either runs elsewhere or doesn't exist
yet, but the marker lets the scene file use the FR-key check instead of an
`isWebGPU` branch. Examples: `DEPTH_PLANE` (handled inside
`WebGPUSceneRenderer`, not the FR-dispatch loop) and `CLASSIFICATION_PRIMITIVE`.
Use this pattern only to retire a Principle-2 violation when a full renderer
isn't ready — and track the real renderer as deferred work
(`DEFERRED_WORK.md`), per CLAUDE.md Principle 9.

---

## Step 7 — Build-variant compat exemption (backend-neutral files only)

By default every file under `Source/Renderer/WebGPU/**` is stubbed out of the
**webgl-only** bundle variant. That's correct for normal renderers. But if your
new file under `Renderer/WebGPU/` exports a **backend-neutral** API that
webgl-only builds legitimately consume (a shader translator, a pluggable
registry — not an actual GPU renderer), add its path to
`WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js`
(current entries: `WebGLCompatibilityStub`, `WebGPUShaderTranslator`,
`WebGLStubPipelineExtractor`, `WebGPUNagaTranspiler`). Such a file's runtime
paths MUST be safe to execute in a webgl-only bundle (lazy-load any WebGPU
deps; never throw at module load). Ordinary feature renderers do **not** get
exempted — leave them to be stubbed.

---

## Step 8 — Parity, tests, verification

- **WebGL/WebGPU parity (Principle 5).** A renderer-agnostic feature should
  exist for both backends; new shaders need both WGSL and GLSL unless
  architecturally impossible. New `DrawCommand` fields go on
  `WebGPUDrawCommand` too.
- **Specs** live in `packages/engine/Specs/Renderer/WebGPU/`. Add registration
  / lifecycle coverage there.
- **Feature inventory.** Add the feature to `FEATURE_INVENTORY.md` §B (NEW), or
  move it from §C/§D as its status changes (Principle 6).
- **Visual verification (Principle 8).** If the renderer produces visible
  output, verify via a Playwright probe under `Tools/visual-regression/` with a
  WebGL-vs-WebGPU pixel diff before claiming it works — do not ask the user to
  eyeball it.

---

## Checklist

1. Append key + bump `COUNT` in `FeatureRendererKey.js` (append-only).
2. Write the renderer module in `packages/engine/Source/Renderer/WebGPU/`
   (RTE precision; TS preferred).
3. Implement only the lifecycle methods you need (`update`/`createCommands`/
   `execute`/`composite`/`init`/`destroy`/…).
4. Register in `registerWebGPUFeatureRenderers` — eager for core/small, lazy
   (`registerFeatureRendererLoader`) for heavy/opt-in.
5. Consume from Scene via `getFeatureRenderer(key)`; shared logic BEFORE the
   branch; WebGL is the fallback. No WebGPU imports, no `isWebGPU` checks.
6. Add a compat exemption only if the file is backend-neutral.
7. Specs + inventory + Playwright probe.
