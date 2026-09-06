# Feature Renderer Onboarding — Adding a New Feature Renderer to the WebGPU Backend

_Registry spine re-derived from HEAD 2026-09-05. Source of truth:_
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
const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
if (fr) {
  fr.update(this, frameState, frameState.commandList);
  return;
}
// WebGL fallback follows as the default path
```

That snippet is the **push** command contract, verified at
`BillboardCollection.js:753-766`. It is not the only one: some FRs **return**
their command instead of pushing it (`Sun.js:319-327`). Both are live; Step 5
documents them side by side. Pick your contract deliberately — the caller and
the FR must agree, and nothing in the registry checks that they do.

This is the mechanism that satisfies CLAUDE.md Principle 2 (Backend
Agnosticism): the only system that knows the current backend is the renderer
layer. Scene files stay free of `if (context.isWebGPU)` branches and free of
WebGPU imports.

The registry lives on the abstract `GraphicsContext` base class
(`GraphicsContext.ts`), so both `Context.js` (WebGL) and `WebGPUContext.ts`
inherit the same registry API. WebGPU registers its implementations from
`registerWebGPUFeatureRenderers(context)`, which `WebGPUContext` calls once
during init (`WebGPUContext.ts:1431`). The registry is **not** WebGPU-only:
`Context.js:777-792` registers a lazy `STAR_FIELD` renderer on the WebGL side
through exactly the same API, so everything below applies to both backends.

---

## The registry data model (read this first)

`GraphicsContext` stores **four** parallel arrays indexed by the numeric key
(O(1) lookup, no hashing), plus a listener set and a monotonic counter
(`GraphicsContext.ts:779-803`):

- `_featureRenderers[key]` — the **installed** FR object, or `undefined`
  (`:801-803`). This is the only one of the four that is pre-sized, to
  `FeatureRendererKey.COUNT`.
- `_featureRendererLoaders[key]` — a lazy `() => Promise<FeatureRenderer>`
  loader (`:779-781`). Read that return type twice: the loader **returns** the
  renderer; it does **not** install it. Step 4 explains why.
- `_featureRendererStatus[key]` — the key's `FeatureRendererReadiness`
  (`:788-789`).
- `_featureRendererGenerations[key]` — the slot's lifetime token (`:792`),
  issued from the monotonic `_nextFeatureRendererGeneration` (`:795`).
- `_featureRendererReadinessListeners` — a `Set` of completion listeners
  (`:798-799`). `Scene.js:537-543` subscribes and calls `requestRender()` on
  every `ready`, so a `requestRenderMode` scene cannot hibernate with a
  fallback frame on screen while a dynamic import is still settling.

### The readiness union — four states, and only one of them is yours

`FeatureRendererReadiness` (`GraphicsContext.ts:390-406`) is a four-way
discriminated union. Every variant also carries a `generation`.

| `kind`        | payload    | what it means for a Scene consumer                                  |
| ------------- | ---------- | ------------------------------------------------------------------- |
| `unsupported` | —          | this backend has nothing for the key — **your legacy path may run** |
| `loading`     | `promise`  | a loader is in flight; the selected backend owns this frame         |
| `ready`       | `renderer` | the FR is installed; delegate to it                                 |
| `failed`      | `error`    | the loader rejected; **terminal** — ordinary lookup never retries   |

**Only `unsupported` may fall through.** `loading` and `failed` belong to the
selected backend, and a consumer that treats them as "no renderer" will build
WebGL resources underneath a WebGPU frame. That rule is written into the API's
own contract at `:2089-2090`, and `VoxelPrimitive.js:508-510` is the shape to
copy:

```javascript
if (readiness.kind !== "unsupported") {
  return;
}
// ... legacy WebGL realization path follows ...
```

### The generation token — what makes a stale completion harmless

Each slot carries a lifetime token. A dynamic import is a multi-frame gap, and
a lot can happen in it: the context can be destroyed, the device can be lost, a
loader can be replaced, an eager `registerFeatureRenderer` can win the race.
Any of those **advances** the slot's generation
(`GraphicsContext.ts:385-388`, `_advanceFeatureRendererGeneration` at `:2289`).

The loader's completion handler captured the generation it started in and
re-reads the array before installing (`:2207-2212`); on a mismatch — or if the
context is already destroyed — it returns without publishing. The rejection
handler does the same (`:2229-2235`).

Concretely, **after a device loss**: the device-lost handler
(`WebGPUContext.ts:7493-7500`) calls `_invalidatePendingFeatureRenderers()` at
`:7498` for every loss that is not already a completed recovery, and that call
advances every slot (`GraphicsContext.ts:2274-2287`). Imports still in flight
against the dead device settle into a generation mismatch and install nothing,
so the recovered context can never inherit a renderer built for the device that
died. Context destruction runs the same invalidation before clearing the arrays
(`:2349-2366`).

This is the whole reason installation is the registry's job and not the
loader's. See Step 4.

### The lookup APIs

`getFeatureRenderer(key)` (`:2080`) is the **legacy renderer-or-undefined
adapter**: it calls the canonical lookup and collapses everything that is not
`ready` to `undefined`. It is fine for a consumer with no legacy path to fall
back to, and wrong for one that has.

Seven entry points exist; pick by what you actually need:

| API                                     | line    | use it for                                                  |
| --------------------------------------- | ------- | ----------------------------------------------------------- |
| `getFeatureRenderer(key)`               | `:2080` | FR-or-`undefined`; no legacy path to guard                  |
| `getFeatureRendererReadiness(key)`      | `:2092` | the canonical lookup — **starts** a dormant loader          |
| `getFeatureRendererAsync(key)`          | `:2119` | await an in-flight (or cold) loader off the draw path       |
| `getFeatureRendererStatus(key)`         | `:2141` | introspection only — **non-starting**, see the trap below   |
| `isFeatureRendererLoading(key)`         | `:2159` | diagnostics                                                 |
| `hasFeatureRendererFailed(key)`         | `:2169` | diagnostics                                                 |
| `subscribeFeatureRendererReadiness(fn)` | `:2264` | wake `requestRenderMode` on install; returns an unsubscribe |

Two more members read the registry without touching readiness at all:
`hasFeatureRenderer(key)` (`:2326`) tests `_featureRenderers[key] !== undefined`
directly — so it answers `false` for a registered-but-dormant lazy key — and
`registeredFeatureCount` (`:2334`) counts installed renderers. Both are
diagnostics, and neither starts a loader.

**Trap.** A registered-but-never-requested lazy slot is stored internally as
`unsupported` (`registerFeatureRendererLoader`, `:2058`). Only a readiness
lookup advances it to `loading` (`_kickLazyLoader` `:2178-2257`, publishing at
`:2250-2255`). `getFeatureRendererStatus` is deliberately non-starting so debug
tooling does not download chunks (`:2135-2137`) — which means it reports a
dormant lazy slot as `unsupported`. Never dispatch a frame off it; use
`resolveFeatureRendererReadiness` (Step 5) or `getFeatureRendererReadiness`.

`COUNT` in the enum pre-sizes `_featureRenderers` and MUST equal the highest
key + 1 (`FeatureRendererKey.js:267-273`; sole runtime consumer
`GraphicsContext.ts:802` — the Jasmine specs below read it too).
The registry-audit tool does **not** check it — `Tools/audit-feature-renderers.mjs:66`
skips `COUNT` when it reads the enum — but the Jasmine suite does:
`FeatureRendererKeySpec.js:57-71` asserts the values are dense `0..COUNT-1` and
that `values.length === COUNT`, and `:21-38` asserts every key is `< COUNT`. A
wrong `COUNT` is a red `npm test`, not a silent hole.

---

## Step 1 — Add a `FeatureRendererKey` enum entry

Edit `packages/engine/Source/Renderer/FeatureRendererKey.js`.

- **Append** the new key with the next free integer. Group it under a section
  comment matching the existing layout (`// ── Collections ──`, etc.).
- **Bump `COUNT`** to `highest key + 1` (`FeatureRendererKey.js:267-273`). It
  pre-allocates `_featureRenderers` (`GraphicsContext.ts:801-803`, its sole
  runtime consumer); forgetting it leaves a hole. `FeatureRendererKeySpec.js:57-71`
  catches that for you — it asserts the values are dense `0..COUNT-1` and that
  `values.length === COUNT` — so a missed bump is a red `npm test`. The
  registry-audit tool will not catch it: `Tools/audit-feature-renderers.mjs:66`
  skips `COUNT` when it reads the enum.
- **Append-only discipline (mirrors the ShaderDefine rule).** Do **not**
  reorder or renumber existing keys — the values are baked into cache indices
  and every registration/lookup site. Two precedents in the file show what to
  do instead:
  - A key whose renderer was **deleted** keeps its slot.
    `GROUND_ATMOSPHERE: 29` (`FeatureRendererKey.js:73-78`) is retired — ground
    atmosphere now shades inside `GlobeTerrain.wgsl` — and the comment states
    "Keys are positional, so slot 29 stays reserved and the number is never
    reused" (rationale repeated at `WebGPUFeatureRenderers.ts:802-808`).
  - A key that is deliberately **never registered** keeps its slot too. `FOG: 8`
    is the case; its reason is recorded in the audit tool's
    `INTENTIONAL_UNWIRED_KEYS` (`Tools/audit-feature-renderers.mjs:37-44`), not
    in the enum file, so add your reason there if you reserve a key.
- **Density and append-only are the same rule, as long as you never *delete* a
  key line.** Retired keys keep their slots, so `0..COUNT-1` stays dense and
  `FeatureRendererKeySpec.js:57-71` stays green. They only come into conflict if
  you follow `FeatureRendererKeySpec.js:57-62`, whose comment still recommends
  renumbering subsequent keys when one is removed. That comment is stale and
  contradicts the enum file itself (`FeatureRendererKey.js:76-77`: "Keys are
  positional, so slot 29 stays reserved and the number is never reused").
  Follow the enum file. The spec's *assertions* are compatible with append-only;
  only its comment is not.

  The enum carries a standing note where a `DEFERRED_GBUFFER` slot is often
  expected: "There is no `DEFERRED_GBUFFER` slot: nothing ever registered or
  consumed one, and the lookup array stays dense. A deferred path would append
  after GPU_SORT_KEYS rather than reclaim an interior index"
  (`FeatureRendererKey.js:263-265`). Take the rule, not the address — the
  comment names `GPU_SORT_KEYS` because that was the tail when it was written;
  the tail today is `FFT_OCEAN: 53` (`:261`). And take the claim narrowly: it
  says nothing registers or consumes such a slot *today*, not that the name
  never existed — one was removed with a renumbering before this discipline was
  formalized (`WEBGPU_DEBUGGING_LOG.md:6385`).
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
`WebGPUEllipsoidPrimitiveRenderer.ts` (`:918` and `:1268`), whose registration
is the eager example in Step 4:

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

### Before you hand-roll buffers or bind groups — read these two

"Build buffers/pipeline" hides the two places a new renderer most often goes
wrong silently. Both have their own reference sections; do not re-derive them
here:

- **Uniform-buffer packing** — the WGSL-struct ↔ JS-packer correspondence, the
  tail-append discipline and its float-count cursor assertion, alignment, and
  the ring allocator: `ARCHITECTURE.md` **§5.5 "Uniform buffers"**. A mid-struct
  insert shifts every offset below it and produces garbage, not an error.
- **Caches** — which of the shipped caches your renderer should be reaching for,
  keyed by what, with the `CesiumDebug` counter that proves it is being hit:
  `ARCHITECTURE.md` **§6.5 "The cache map"**. Allocating a bind group per frame is
  the single most common new-renderer performance defect.

---

## Step 3 — Lifecycle method vocabulary

The FR registry is **duck-typed** — callers check for a method before calling
it, so an FR only implements the subset it needs. The base `FeatureRenderer`
interface (`GraphicsContext.ts:309-380`) plus its three sub-types —
`CollectionRenderer` (`:459`), `PrimitiveCommandRenderer` (`:481`) and
`SystemRenderer` (`:520`) — define the vocabulary:

- **`update(collection, frameState, ...args)`** — `CollectionRenderer`. The
  per-frame entry point and by far the most common (collections, environment,
  model, clipping, post-process). Builds resources and pushes draw commands.
- **`createCommands(...)` / `updateCommandUniforms(...)` / `createMaterial…` /
  `updatePickCommandUniforms(...)`** — `PrimitiveCommandRenderer` (the
  `PRIMITIVE` command factory and the ground/vector-tile classifiers).
- **`execute(...)`** — full-screen / post-process effects (SSR, NPR outlines,
  contact shadows, procedural clouds).
- **`composite(...)`** — a second pass run later in the frame. `VOLUMETRIC_FOG`
  is the shipped example: one descriptor carrying `update`, `composite`,
  `destroy` and a `getStatistics` closure over `context`
  (`WebGPUFeatureRenderers.ts:450-459`).
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
// The real ellipsoid registration, WebGPUFeatureRenderers.ts:689-692.
context.registerFeatureRenderer(FeatureRendererKey.ELLIPSOID_PRIMITIVE, {
  update: updateWebGPUEllipsoidPrimitive,
  destroy: destroyWebGPUEllipsoidPrimitiveResources,
});
```

You can pass closures that capture `context` for `init`/`getStatistics`-style
methods, or set `RendererClass` for Shape B. `registerFeatureRenderer`
(`GraphicsContext.ts:2023-2037`) advances the slot's generation, installs the
renderer, clears any pending loader for the key, publishes `ready`, and notifies
the readiness listeners. Advancing the generation is what makes an eager
registration win a race against an in-flight lazy loader for the same key.

### `registerFeatureRendererLoader(key, loader)` — LAZY

Use when the renderer pulls in heavy code (large WGSL, compute pipelines) that
should only download on first use. **Do not** statically import the module.
Register a loader that dynamic-imports it and **returns** the renderer:

```typescript
// The real SSR registration, WebGPUFeatureRenderers.ts:812-821.
context.registerFeatureRendererLoader(
  FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
  async () => {
    const mod = await import("./WebGPUSSREffect.js");
    return {
      execute: mod.executeSSR,
      destroy: mod.destroySSRResources,
    };
  },
);
```

#### Return the renderer. Never call `registerFeatureRenderer` from inside a loader.

The loader's type is `() => Promise<FeatureRenderer>`
(`GraphicsContext.ts:2050-2053`), and its JSDoc says why: "Installation remains
owned by this registry so a completion from a stale device/context generation
cannot publish itself" (`:2043-2045`).

A self-installing loader routes around that guard, because
`registerFeatureRenderer` **advances** the generation (`:2027`, `:2289-2293`)
instead of being checked against it. The registry's own install path checks the
generation it started in and refuses to publish on a mismatch (`:2207-2212`) —
that check is the only thing standing between a device loss and a renderer built
for a dead device being installed into the recovered context. Returning the
object keeps you inside it.

All 11 lazy WebGPU loaders return (`WebGPUFeatureRenderers.ts:696`, `:708`,
`:722`, `:739`, `:812`, `:826`, `:841`, `:855`, `:871`, `:887`, `:902`), as does
the WebGL `STAR_FIELD` loader (`Context.js:777-792`). There is no exception in
the tree; if you find yourself wanting one, you want a different key.

Resolving without a renderer is a hard error, not a silent no-op — the registry
throws `"Feature renderer loader for key N resolved without a renderer"`
(`:2213-2216`), which lands in the same terminal `failed` state as a rejected
import.

#### Lifecycle facts you need before choosing lazy

- **Dormant until first asked.** Registering a loader sets the slot to
  `unsupported` internally (`:2058`); the first readiness lookup starts it and
  flips it to `loading` (`:2178-2255`).
- **Fires exactly once per generation.** `_kickLazyLoader` returns the existing
  state for `loading` / `ready` / `failed` (`:2179-2186`), so concurrent callers
  coalesce onto one promise.
- **Failure is terminal.** A rejected import writes `failed` (`:2236-2241`) and
  ordinary lookup never retries it — the JSDoc states this outright at
  `:2164-2165` ("Failures are stable; ordinary lookup never retries them."), and
  `_kickLazyLoader`'s early return at `:2180-2186` is the enforcement. Plan for
  a permanent absence, not a transient one.
- **A synchronous throw inside the loader** is deferred into a microtask
  (`:2198-2201`) so it becomes the same stable `failed` state as a rejection.
- **An eager registration wins.** `registerFeatureRendererLoader` bails if a
  renderer is already installed for the key (`:2055`).
- **The scene must be woken.** `Scene.js:537-543` subscribes to readiness and
  calls `requestRender()` on `ready`; you get that for free, but it is why a
  `requestRenderMode` app does not freeze on the fallback frame.

Current lazy entries (11, all WebGPU): `GAUSSIAN_SPLAT`, `POINT_CLOUD`,
`POINT_CLOUD_EDL`, `VOXEL_PRIMITIVE`, `SCREEN_SPACE_REFLECTIONS`,
`NPR_OUTLINES`, `CONTACT_SHADOWS`, `WEATHER_PARTICLES`, `PROCEDURAL_CLOUDS`,
`FLOW_FIELD`, `FFT_OCEAN` — plus `STAR_FIELD` on WebGL.

**Rule of thumb:** opt-in / rarely-used / heavy-WGSL → lazy. Always-on / core /
tiny → eager.

---

## Step 5 — Consume from Scene (backend-agnostic + Scene-Logic-Extractor)

Scene code looks the FR up by key and delegates. **Which lookup you use depends
on whether you own a WebGL implementation to fall back to.**

### If you own a legacy path — use `resolveFeatureRendererReadiness`

This is the Scene entry point (`GraphicsContext.ts:429-440`). It is a free
function, not a method: it takes the readiness path on a real
`GraphicsContext` and degrades to renderer-or-undefined on the older context
doubles that tests use, so one call site works everywhere.

```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import { resolveFeatureRendererReadiness } from "../Renderer/GraphicsContext.js";

// Shape from VoxelPrimitive.js:474-510.
const readiness = resolveFeatureRendererReadiness(
  frameState.context,
  FeatureRendererKey.VOXEL_PRIMITIVE,
);
const fr = readiness.kind === "ready" ? readiness.renderer : undefined;
if (fr) {
  fr.update(this, frameState);
  return;
}
if (readiness.kind !== "unsupported") {
  return; // loading or failed — the selected backend owns this frame
}
// ... WebGL realization path continues as the default fallback ...
```

The last guard is the point of the whole section. `loading` and `failed` are
**not** "no renderer" — they are "the selected backend has this key and is not
ready". Building WebGL buffers, shader programs and textures underneath a
WebGPU frame is the failure this shape prevents, and it is silent when it
happens. `VoxelPrimitive.js:472-473` states it in the code itself:
"Loading/failed belong to the selected backend. Do not initialize the legacy
traversal/resources until the backend says it is unsupported."

Four Scene files use this today — the four keys whose renderers are lazy and
therefore genuinely spend frames in `loading`:

| consumer                             | lookup   | fall-through guard |
| ------------------------------------ | -------- | ------------------ |
| `VoxelPrimitive.js`                  | `:474`   | `:508-510`         |
| `PointCloud.js`                      | `:174`   | `:273-275`         |
| `PointCloudEyeDomeLighting.js`       | `:61`    | `:73-75`           |
| `GaussianSplatPrimitive.js`          | `:1482`  | `:1487-1489`       |

`GaussianSplatPrimitive` composes the guard differently and is worth reading for
it: `if (!defined(fr) && readiness.kind !== "unsupported") return;`
(`:1487-1489`). It returns early on `loading`/`failed` exactly like the others,
but it does **not** return on `ready` — the shared, backend-neutral splat
pipeline (`_updateSplatData`, `:1495`) runs on every backend before the FR is
called at `:1497-1499`. That is the Scene-Logic-Extractor pattern and the
readiness guard cooperating in one `update`; the guard decides who owns the GPU
work, the extractor keeps the CPU work shared.

### If the key is eager, or there is no legacy path — `getFeatureRenderer` is fine

`context.getFeatureRenderer(key)` collapses everything that is not `ready` to
`undefined`. That is safe in exactly two cases, and **eagerness is the one that
does the work**:

1. **The key is registered eagerly.** `registerFeatureRenderer`
   (`GraphicsContext.ts:2023-2037`) publishes `ready` in the same call that
   installs the renderer, so an eager slot is `ready` from
   `registerWebGPUFeatureRenderers` onward — and `unsupported` on a backend that
   never registers it (`_kickLazyLoader` `:2189-2196`, no loader → `unsupported`).
   It never spends a frame in `loading`, so here `undefined` really does mean
   "the selected backend does not have this key".
2. **The `if (fr)` branch is the only implementation** and the else-branch
   genuinely does nothing. Then there is no legacy path to run early, whatever
   the slot's state.

`Sun.js:319` and `BillboardCollection.js:750-752` are the **first** case, not the
second. Both keep substantial WebGL else-branches — `Sun.js:329+` re-bakes
`this._texture` against the drawing-buffer size, `BillboardCollection.js:769+`
asserts instancing/VTF support and runs the vertex-array build — and they are
safe only because `SUN` (`WebGPUFeatureRenderers.ts:389`) and
`BILLBOARD_COLLECTION` (`:278`) are eager registrations.

**So copy that shape only for an eager key.** For a lazy one — anything
registered through `registerFeatureRendererLoader` — a bare `getFeatureRenderer`
above a real else-branch is precisely the silent defect above: the slot is
`loading` for as long as the dynamic import takes, `undefined` reads as "no
renderer", and the else-branch builds GL objects underneath a WebGPU frame. A
lazy key belongs on the `resolveFeatureRendererReadiness` path in the previous
section, even if its legacy branch is small.

### The two command contracts — both are live, pick one deliberately

Nothing in the registry checks how an FR delivers its commands. The FR and its
caller must agree, and the two shipped conventions are:

**Push** — the FR appends its commands to a list the caller supplies, and the
caller returns nothing:

```javascript
// BillboardCollection.js:753-766 (the :755-763 rationale comment elided)
if (fr) {
  this._featureRenderer = fr;
  // …
  computeBoundingVolumeForFeatureRenderer(this, frameState);
  fr.update(this, frameState, frameState.commandList);
  return;
}
```

**Return** — the FR returns its command and the caller publishes it:

```javascript
// Sun.js:319-327
const fr = frameState.context.getFeatureRenderer(FeatureRendererKey.SUN);
if (fr) {
  const drawCommand = fr.update(this, frameState);
  scratchBackendCommands.drawCommand = drawCommand;
  if (defined(drawCommand)) {
    return scratchBackendCommands;
  }
  return undefined;
}
```

Return is the right choice when the caller must stay the authority over the
command — `Sun.js:313-318` gives the reason for this one: Scene publishes the
result as `sunDrawCommand` and the renderer applies the authoritative visibility
result while injecting it into the ENVIRONMENT pass, so a second binned copy
would bypass `isSunVisible`.

`CubeMapPanorama.js:293-302` is a second clean **return**: it calls
`fr.update(this, frameState, useHdr)` at `:295` and returns that command at
`:302`.

`Moon.js:796-803` is neither, and is the reason to read the call site rather
than assume. The FR pushes — but into a *swapped* list: the caller saves
`frameState.commandList`, points it at a scratch array, calls
`fr.update(this, frameState, scratchCommandList)` (`:801`), restores the real
list, and then **returns** `routeMoonCommand(...)` (`:803`). It is a push whose
output the caller intercepts and re-publishes, so it reads like the push
exemplar and behaves like the return one.

Whichever you pick, document it beside the registration — the doc you are
reading taught the push shape with a returning exemplar for months.

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

## Step 6 — Marker FRs and alias registrations

Some keys register an FR that does no rendering of its own. The point is to give
the scene file a truthful FR-key check instead of an `isWebGPU` branch. The two
shipped cases are not the same shape, so read both before copying either:

- **`DEPTH_PLANE` (`WebGPUFeatureRenderers.ts:642-644`)** is the pure marker —
  the descriptor carries `name` and nothing else
  (`"DepthPlane (marker — handled by WebGPUSceneRenderer)"`). The work happens
  inside `WebGPUSceneRenderer`, not the FR-dispatch loop, so the key exists only
  so a scene consumer can ask "does this backend own the depth plane?".
- **`CLASSIFICATION_PRIMITIVE` (`:656-660`)** is *not* a no-render bridge. Its
  descriptor carries `name` plus real methods —
  `createCommands: createWebGPUGroundPrimitiveCommands` and
  `destroy: destroyWebGPUGroundPrimitiveResources` — aliased onto the
  ground-primitive renderer, because `ClassificationPrimitive` reuses the same
  depth-sample classification pipeline as `GroundPrimitive` (`:646-655`). It is
  an alias registration, not a placeholder.

Use the pure-marker form only to retire a Principle-2 violation when a full
renderer isn't ready — and track the real renderer as deferred work
(`DEFERRED_WORK.md`), per CLAUDE.md Principle 9. If two keys can share one
implementation, prefer the alias form: it is a real registration and behaves
like one at every lookup.

---

## Step 7 — Build-variant compat exemption (backend-neutral files only)

By default every file under `Source/Renderer/WebGPU/**` is stubbed out of the
**webgl-only** bundle variant. That's correct for normal renderers. But if your
new file under `Renderer/WebGPU/` exports a **backend-neutral** API that
webgl-only builds legitimately consume (a shader translator, a pluggable
registry — not an actual GPU renderer), add its path to
`WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js`. The list is
short and it moves, so **read it at the source rather than trusting a copy**:
`scripts/bundleVariantPlugin.js:276-286` (5 entries at the time of writing; the
consumer that applies them is `isWebGPUFile` at `:296`, via the loop at `:310`).
Every prose copy of this list in the repo has been stale at some point,
including the one that used to sit here.

Such a file's runtime paths MUST be safe to execute in a webgl-only bundle
(lazy-load any WebGPU deps; never throw at module load) — the fifth entry's own
comment (`:281-284`) is the model for how to justify one. Ordinary feature
renderers do **not** get exempted; leave them to be stubbed.

---

## Step 8 — Parity, tests, verification

- **WebGL/WebGPU parity (Principle 5).** A renderer-agnostic feature should
  exist for both backends; new shaders need both WGSL and GLSL unless
  architecturally impossible. New `DrawCommand` fields go on
  `WebGPUDrawCommand` too.
- **Specs** live in `packages/engine/Specs/Renderer/WebGPU/`. Add registration
  / lifecycle coverage there. The enum's own contract is already covered by
  `packages/engine/Specs/Renderer/FeatureRendererKeySpec.js`.
- **Run the registry audit before you land — and read it as a diff, not a
  verdict.** `npm run audit-feature-renderers` cross-checks every enum key
  against its registrations and consumers:

  ```bash
  npm run audit-feature-renderers            # always exits 0
  npm run audit-feature-renderers -- --strict # exit 1 on any finding
  ```

  `--strict` is what turns a finding into a non-zero exit
  (`Tools/audit-feature-renderers.mjs:30`, `:195`), and keys listed in
  `INTENTIONAL_UNWIRED_KEYS` (`:37-44`) are excluded — the `hasFindings` test at
  `:191-194` reads only the unregistered / dead-registration / stale-consumer
  buckets, never `intentional`.

  **`--strict` exits 1 today, on a clean tree.** Measured at HEAD 2026-09-05:
  `FR audit: 54 keys, 41 registered, 47 consumed` with 12 "unregistered" keys
  and 1 "dead registration". Every one of those 13 is an artefact of how the
  tool scans, not a defect in the registry:

  - Its registration regex is
    `/registerFeatureRenderer\s*\(\s*FeatureRendererKey\.([A-Z0-9_]+)/` (`:90-92`).
    It requires `(` immediately after `registerFeatureRenderer`, which the lazy
    form's `Loader(` cannot supply — so **all 11 lazy keys report as
    unregistered**, plus the genuinely retired `GROUND_ATMOSPHERE`.
  - Its consumer regex (`:97-99`) is
    `/get(?:FeatureRenderer(?:Async|Status)?)\s*\(\s*FeatureRendererKey\.([A-Z0-9_]+)/`,
    which recognises `getFeatureRenderer`, `…Async` and `…Status` but **not
    `getFeatureRendererReadiness` and not `resolveFeatureRendererReadiness`** —
    so the four Scene consumers in Step 5 are invisible to it. Today that is
    masked, because those same four keys are already in the "unregistered"
    bucket from the bullet above; fixing the registration regex **alone** would
    flip them straight from a false "unregistered" into a false "dead
    registration". The two regexes have to be fixed in the same change.
  - `stripComments` (`:76-80`) can over-strip. Its block-comment pass
    (`/\/\*[\s\S]*?\*\//g`, `:78`) runs **before** the line-comment pass
    (`:79`), so it consumes any `/*` the line pass has not removed yet —
    including one sitting inside a `//` comment. In
    `GroundPolylinePrimitive.js` the glob path `Source/Shaders/*.js`, quoted in
    the line comment at `:531`, opens a phantom block that closes on the next
    `*/`: the JSDoc terminator at `:923`. That deletes 71% of the file
    (33,164 → 9,550 chars) and both real
    `getFeatureRenderer(FeatureRendererKey.GROUND_POLYLINE)` sites (`:535`,
    `:829`) with it — which is the whole of the standing `GROUND_POLYLINE`
    "dead registration" finding, a false positive. Note for whoever fixes the
    tool: the trigger is a line comment, not a string or regex literal.

  So the useful workflow is: run it before your change, run it after, and
  confirm **your** key did not add a line. Do not expect green, and do not
  silence a finding by adding your key to `INTENTIONAL_UNWIRED_KEYS` unless it
  is genuinely reserved-and-unwired the way `FOG` is.

  **CI does not do this for you either.** `.github/workflows/dev.yml:90-91` runs
  the bare `npm run audit-feature-renderers`, which prints its findings and
  exits 0. Making that step strict is blocked on the three scan defects above,
  not on policy.
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
5. Consume from Scene. If you own a WebGL fallback, use
   `resolveFeatureRendererReadiness` and fall through **only** on
   `unsupported`; if you don't, `getFeatureRenderer(key)` is fine. Shared
   backend-neutral logic runs BEFORE the branch. No WebGPU imports, no
   `isWebGPU` checks.
6. Add a compat exemption only if the file is backend-neutral (check the live
   list at `scripts/bundleVariantPlugin.js:276-286`, don't trust a prose copy).
7. Run `npm run audit-feature-renderers` before and after, and confirm your key
   added no line. `--strict` exits 1 on a clean tree today (Step 8 explains
   why), and CI runs it without `--strict`, so nothing else will catch you.
8. Specs + inventory + Playwright probe.
