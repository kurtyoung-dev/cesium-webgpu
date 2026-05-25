# Slice 5d Plan — Forward-Clustered Lighting on WebGPU

**Status:** SCOPING (Batch 137, 2026-05-25). Implementation deferred —
this doc captures the work-unit breakdown so any future session can
pick up the arc without re-discovering the dependencies.

**Goal:** Multi-light Forward+ on the WebGPU backend, with per-pixel
diffuse + specular for arbitrary scene-placed lights (point + spot +
directional beyond the existing single sun). Closes
[FEAT-SURVEY-40](FEATURE_INVENTORY.md#d-future--deferred) and the
[NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING](DEFERRED_WORK.md) entry.

**Reference implementation:**
[toji/webgpu-clustered-shading](https://github.com/toji/webgpu-clustered-shading)
— Brandon Jones's (Google WebGPU lead) canonical Forward+ on WebGPU.
Most pieces are directly portable; the deltas are noted in step 4
below.

---

## Why this arc isn't "just one batch"

Three independent pieces have to land in order:

1. **Light data plumbing.** `KHR_lights_punctual` glTF extension
   isn't loaded today — the loader silently drops these light defs.
   Without it, there's nothing to cluster except the single sun (and
   sun lighting doesn't benefit from clustering — it's whole-scene).
2. **Cluster infrastructure.** Two compute passes (cluster bounds +
   light-to-cluster assignment) plus storage buffers for the
   per-cluster light index list.
3. **Consumer.** ModelPBRComplete + the Lit Mat shaders need to
   replace their current single-sun loops with per-cluster light
   list iteration using the G-buffer normal at the fragment.

Skipping any step yields a broken or invisible feature — the user
doesn't see clustered lighting until all three land.

---

## Sub-batch sequence

### Batch 137a — `KHR_lights_punctual` glTF loader

**Effort:** ~120 LOC, ~half a day. Self-contained.

**Scope:** `packages/engine/Source/Scene/GltfLoader.js`

1. Read `gltf.extensions.KHR_lights_punctual.lights[]` at the
   document level. Each entry: `{ type: "point"|"spot"|"directional",
   color: [r,g,b], intensity?, range?, spot?: { innerConeAngle,
   outerConeAngle } }`.
2. Per-node walk to find `node.extensions.KHR_lights_punctual.light`
   (index into the document-level array). Compose world transform
   from the parent chain.
3. Materialize each as a `PointLight` / `SpotLight` /
   `DirectionalLight` instance.
4. Merge into the model's owned `LightCollection` (which doesn't
   exist yet — that's part of this sub-batch). Surface as
   `model.lights` getter so users can inspect / mutate per-asset.

**Done when:** Sandcastle scene loads a glTF with KHR_lights_punctual
and `model.lights.length > 0`. No visual change yet — the lights are
collected but not consumed.

**References:**
- glTF spec: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_lights_punctual
- DEFERRED_WORK.md lines 1854-1867 (existing scoping for this).

### Batch 137b — `Scene.lights` LightCollection bridge

**Effort:** ~80 LOC, ~half a day.

**Scope:** `packages/engine/Source/Scene/Scene.js`,
`packages/engine/Source/Scene/LightCollection.js` (new).

1. New `LightCollection` class — array-backed, supports
   `add(light) / remove(light) / get(index) / length`. Lights are
   `PointLight | SpotLight | DirectionalLight` instances (also new
   classes if they don't exist — check first).
2. `Scene` gets a `lights` getter that returns the scene-level
   `LightCollection`. Default empty.
3. `FrameState` carries `frameState.lights` (existing pointer? or new
   field) populated each frame by walking
   `scene.lights.values + scene.primitives.flatMap(p => p.model?.lights)`.

**Done when:** Setting `scene.lights.add(new C.PointLight(...))`
populates `frameState.lights` each render. Still no visual change.

### Batch 137c — Cluster bounds compute pass

**Effort:** ~2 days. Numerically tricky (RTE precision boundary,
near-plane edge cases).

**Scope:** `packages/engine/Source/Renderer/WebGPU/WebGPUClusterBoundsRenderer.ts`
(new), `packages/engine/Source/Shaders/WebGPU/Compute/ClusterBounds.wgsl` (new).

1. Compute shader: one thread per cluster in a `(X, Y, Z) = (16, 9,
   24)` grid (matches toji). Reads `frustum.near`, `frustum.far`,
   `projection.fov`, viewport from a uniform; writes a per-cluster
   AABB to a storage buffer (`array<vec4<f32>, 16*9*24>` for `min` +
   same for `max`).
2. **RTE delta from toji:** cluster bounds must be in *eye-space*, not
   world-space, so the cluster compute doesn't need the RTE plumbing —
   eye-space positions are already small enough to fit in f32 without
   precision issues. (This is one of the few places where Cesium's
   eye-space convention is actively *helpful*.)
3. Cache invalidation: re-dispatch when `(viewport, frustum near/far,
   projection)` changes. Plug into the existing
   `_scenePipelineFormatGeneration` bus or add a separate
   `_clusterBoundsGeneration` counter.

**Done when:** Storage buffer is populated with sane AABB values
verifiable via a debug overlay (extend `WebGPUDebugGBufferOverlay`
with a cluster-color mode). Still no visual lighting change.

### Batch 137d — Light-to-cluster assignment compute pass

**Effort:** ~1.5 days.

**Scope:** `packages/engine/Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.ts`
(new), `packages/engine/Source/Shaders/WebGPU/Compute/ClusterAssign.wgsl` (new).

1. Compute shader: one thread per cluster. Reads the cluster's AABB
   from step 137c's storage buffer, walks the active light list
   (from `frameState.lights`), tests sphere-AABB intersection for
   each point/spot light, emits two storage buffers:
   - Per-cluster light count (`array<u32, 16*9*24>`).
   - Per-cluster light index list (flat array indexed by per-cluster
     offset; offset table also in a storage buffer).
2. **Toji delta:** the example does N²-light walking which is fine for
   <100 lights but Cesium scenes may have thousands of lights in
   tilesets. Cap at 1024 lights per scene initially; spatial culling
   on the CPU side can drop that further. Document the limit
   explicitly.
3. **Dirty tracking:** only re-dispatch when light list or camera
   moves. `RenderScheduler` already has per-frame dirty bits for
   camera motion — reuse those.

**Done when:** A scene with one PointLight gets its light index
written into the storage buffer cells whose AABB the light intersects.
Verifiable via the cluster-debug overlay extended to show "cells
containing >0 lights".

### Batch 137e — Forward+ fragment consumer

**Effort:** ~1-2 days. The shader work is straightforward; the bind
group plumbing through the existing pipeline cache + shader define
system is the bulk of the time.

**Scope:** `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`,
all 21 Lit Mat shaders, `WebGPUModelPipelineCache.js` + Lit Mat
pipeline cache, `WebGPUEffectsBindGroup.js` (or new bind group).

1. **Shader changes:** add a new bind group entry holding the
   cluster index/offset buffers + light data buffer + cluster bounds
   uniforms (viewport, frustum near/far, grid dimensions). Fragment
   computes its cluster from `gl_FragCoord.xy` + linearized depth,
   reads the cluster's light count + offset, iterates that range of
   the global light index list, evaluates diffuse + specular per
   light. Uses **G-buffer normal at slot 1** (already populated by
   Batches 117-121 + 135) — no re-derivation needed.
2. **Shader define gate:** add `ShaderDefine.CLUSTERED_LIGHTING` so
   scenes with no lights skip the cluster loop. Default off.
3. **Bind group:** new `@group(4)` entry across all consuming
   pipelines. Centralize via `makeClusteredLightingBGL()` helper.
4. **Pipeline cache:** the existing scene-format-generation cache
   already invalidates on toggle changes; just make sure the new
   define participates.

**Done when:** A scene with `scene.lights.add(new C.PointLight({
position, color, intensity }))` produces visible per-pixel diffuse
+ specular at the light's region. Sandcastle demo: a glTF model
inside a "light bulb" PointLight, viewed from various angles —
lighting wraps the model correctly.

---

## Cumulative effort

~6-8 days of focused work across 5 sub-batches. Significantly more
if cluster-bounds RTE numerics need iteration (typical first cut at
RTE-aware compute shaders) or if light-list management requires UI
support (which is out of scope for this slice).

## Out-of-scope (separate future arcs)

- **Light shadows** — point-light cube shadow maps already exist for
  the single point light (Batch 165, B.12). Multi-light shadow
  mapping is a separate huge arc and not part of clustered lighting.
- **IBL per-cluster probes** — DDGI per-tile probe cages
  ([FEAT-SURVEY-46](FEATURE_INVENTORY.md#d-future--deferred)) is a
  different research-stage feature, not a follow-on.
- **Light-list streaming for huge tilesets** — Batch 137d caps at
  1024 active lights. Streaming light data per-tile-load is a
  separate optimization track.

## Decision points before starting

1. **Is the user ready to invest 6-8 days?** This is a multi-week
   slice with no incremental visible payoff until 137e ships.
2. **Should KHR_lights_punctual loader land standalone first** (as a
   "lights are parsed but ignored" stepping stone) so other work can
   take advantage of `model.lights` even if clustered shading
   isn't ready? Recommend yes — 137a is independently valuable.
3. **What's the max-lights cap?** 1024 is a defensible default but
   should be configurable via `Scene.maxClusteredLights`.
