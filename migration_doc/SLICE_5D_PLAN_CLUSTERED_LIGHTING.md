# Slice 5d Plan — Forward-Clustered Lighting on WebGPU

**Status:** ✅ SHIPPED end-to-end (Batch 153, 2026-05-26). Steps 1 + 2
(Batch 142), steps 3 + 4 (Batches 147 + 148), step 5 scaffolding
(Batches 149-151), and the Model PBR consumer (Batch 153) all landed.
The `@group(4)` approach was blocked by the platform `maxBindGroups: 4`
ceiling (Batch 152) and replaced by folding the 5 cluster bindings into
the existing group 3 (effects) BGL at bindings 18..22. Verified by
`probe-clustered-visible.mjs`: a glTF model lit by a scene PointLight
shows a +24 mean-brightness delta over 53.8k pixels with 0 device
errors. **A latent `perturbNormal` NaN bug** (degenerate result on
normal-mapped primitives without TANGENT attributes — silently zeroed
ALL lighting, not just clustered) was found + fixed as part of this
batch.

**Batches 154-155 (2026-05-26):** Extended the consumer to all 19
primitive `Mat*Lit` material shaders. The chunk's `@group(N)` index is
now a `__CL_GROUP__` token substituted per-pipeline (Model PBR = 3;
primitives = 2 when no texture group, 3 when textured) because the
effects BGL lands at a different group across pipelines. Batch 154 =
mechanism + ColorLit (group 2) + NormalMapLit (group 3); Batch 155 =
the remaining 17 (Image/Checker/Grid/Stripe/Dot/Fade/RimLighting/
AlphaMap/EmissionMap/SpecularMap/BumpMap/Water/ElevBand/ElevContour/
ElevRamp/SlopeRamp/AspectRamp). Verified: `probe-clustered-litmat.mjs`
(group 2 visible), `probe-clustered-matsweep.mjs` (7 non-textured lit
materials, 0 device errors), `probe-clustered-visible.mjs` (Model PBR
group 3, no regression). Blinn-Phong primitives have no PBR material so
F0=0.04 / roughness=0.5 are synthesized for the evaluator.

**Batch 156 (2026-05-26):** Extended the consumer to the legacy Phong
primitive shaders (phong / phongTextured) AND fixed a pre-existing
first-site primitive MSAA black-render bug (sampleCount=1 pipelines vs
the MSAA=4 scene FB pass — Batch 132's fix only covered the Mat* site).
See WEBGPU_DEBUGGING_LOG Bug 156.1.

**Batch 157 (2026-05-26):** Fixed `PerInstanceColorAppearance` (flat:false)
rendering UNLIT — `selectWebGPUShader` ran on the COMPRESSED geometry
attributes (normal oct-encoded in `compressedAttributes`) and missed the
normal, falling back to the unlit `basic` shader. Fix: decode
(`ensureUncompressedAttributes`) before shader selection. That exposed +
fixed two latent phong-shader WGSL compile bugs (bare-vec4 return vs
FragOutput; `textureSampleCompare` in non-uniform flow). The phong
clustered consumer is now exercised end-to-end (`probe-clustered-phong.mjs`,
delta +543). See WEBGPU_DEBUGGING_LOG Bug 157.1-157.3.

**Batch 158 (2026-05-26):** Shipped the `WebGPU Clustered Lighting`
Sandcastle gallery demo — 6 colored orbiting point lights illuminating
glTF models (Model PBR) + a lit ground plane (matColorLit), with
clustered-on/off + animate + light-count toggles. Verified via
`probe-clustered-demo-scene.mjs` (replicates the demo scene: 6 active
lights, clustered contribution delta +46 over ~56% of the frame, 0 device
errors). WebGPU gallery demos ship without a `.jpg` thumbnail (matches the
18 existing WebGPU demos; the build treats the thumbnail as optional).

**Slice 5d is COMPLETE** — Forward+ clustered lighting consumed by Model
PBR + all 19 primitive Mat*Lit shaders + the Phong primitive shaders, with
a Sandcastle demo. Update history below the sub-batch sequence.

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

### Batch 137a — `KHR_lights_punctual` glTF loader — ✅ SHIPPED (Batch 134, verified Batch 142)

**Status update (Batch 142, 2026-05-26):** Already implemented during Batch 134 work; rediscovery during Slice 5d kickoff. End-to-end verified by `Tools/visual-regression/probe-khr-lights-punctual.mjs` against `Apps/SampleData/models/TestLightsPunctual/TestLightsPunctual.gltf` (3 lights × 4 node references → 4 resolved light instances with correct position/direction/cone resolution under TRS + parent matrix, 0 device errors).

Implementation lives at:

- `GltfLoader.js` — `materializeKhrLightsPunctual()` (extension reader + per-node walk + TRS resolution)
- `Model.js` — `model.lightsFromGltf` getter
- `WebGPUModelRenderer.js` — `packPunctualLights()` (consumes lightsFromGltf into the per-model light UBO)

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

### Batch 137b — `Scene.lights` LightCollection bridge — ✅ SHIPPED (Batch 134, verified Batch 142)

**Status update (Batch 142, 2026-05-26):** Already implemented during Batch 134 work. The `LightTypes.ts` module defines `Light` (base), `DirectionalLight`, `PointLight`, `SpotLight`, and `LightCollection`; `Scene.js` instantiates `this.lights = new LightCollection()` in the constructor and writes `frameState.lights = this.lights` in the update loop. The renderer's `packPunctualLights` already reads `frameState.lights` and merges with `model.lightsFromGltf`. Cap is `LightCollection.MAX_LIGHTS = 8` (matches the WGSL slot count).

Batch 142 added the missing public-API surface — the multi-light classes were internal-only because the build's `*.js` workspace glob didn't pick up `LightTypes.ts`. Now re-exported through `packages/engine/index.js` AND injected into the auto-generated `Source/Cesium.js` barrel via `scripts/build.js::createCesiumJs`. Users can now `new Cesium.PointLight(...)` and `scene.lights.add(...)`.

Note: `Light` (base class) is intentionally NOT re-exported under that name — the upstream `Scene/Light.js` already occupies the slot as an abstract type marker. Users construct concrete subclasses.

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

### Batch 137c — Cluster bounds compute pass — ✅ SHIPPED (Batch 147, 2026-05-26)

**Status update (Batch 147 + 148):** Shipped as
`WebGPUClusterBoundsRenderer.ts` + `Shaders/WebGPU/Compute/ClusterBounds.wgsl`.
16×9×24 grid (3456 clusters), exponential depth slicing, per-renderer
uniform buffer (96B → 256 padded) + storage buffer (~108 KiB).
Dirty tracking on projection matrix via `_cachedProjection: number[]`
(originally Float32Array, fixed in Batch 148 to preserve f64 input
for proper diffs). Verified end-to-end via
`Tools/visual-regression/probe-cluster-bounds.mjs` against a fixed
80°×60° frustum (near=1, far=1000): all 8 NDC corners unproject to
expected eye-space coordinates, with -Z forward convention
(probe assertions use `Math.abs(z)` for sign-agnostic Z magnitude
comparison).

**Effort actual:** ~1 day (versus 2-day estimate). Numerics fell out
clean once the f64 dirty-tracking bug was found.

---

**Original plan (preserved for reference):**

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

### Batch 137d — Light-to-cluster assignment compute pass — ✅ SHIPPED (Batch 148, 2026-05-26)

**Status update (Batch 148):** Shipped as
`WebGPUClusterAssignRenderer.ts` + `Shaders/WebGPU/Compute/ClusterAssign.wgsl`.
One thread per cluster, sphere-AABB intersection per (cluster, light).
Caps: `CLUSTER_MAX_LIGHTS = 1024` total, `CLUSTER_MAX_LIGHTS_PER_CLUSTER = 256`.
Directional lights always overlap; point/spot tested by range². CPU
pack with `ClusteredLightDef` interface (5 vec4 = 80 bytes per record),
plus checksum-based dirty tracking. Verified end-to-end via
`Tools/visual-regression/probe-cluster-assign.mjs`: single point light
at known eye-space position writes its index into exactly the cluster
cells whose AABB the light's range sphere intersects; directional-only
case produces 3456 baseline overlaps.

**Effort actual:** ~1 day (versus 1.5-day estimate).

---

**Original plan (preserved for reference):**

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

Decomposed into three sub-batches once the original `@group(4)`
approach hit the platform's `maxBindGroups: 4` ceiling. Final state:
infrastructure landed (149-151), consumer wiring redesigned and shipped
(153), and the 21 Lit Mat shaders consumed the cluster bindings
(154-158). All SHIPPED.

#### Batch 149 — FS chunk + dispatcher → SCAFFOLDED ✅

Landed:

- `packages/engine/Source/Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl` — declares the bindings (`clusterLights`, `clusterAABBs`, `perClusterLightCount`, `perClusterLightIndices`, `clusterParams`), `clusterIndexFor(fragCoord, viewZ)` lookup, and `evalClusteredLights(...)` (Lambert + Cook-Torrance GGX with KHR_lights_punctual smooth falloff).
- Cluster-debug visualizer pipeline reads the FS chunk and renders each cluster's light count as a heatmap — proves end-to-end that the chunk reads the dispatcher's storage buffers correctly.

#### Batch 150 — per-frame dispatcher orchestration → SCAFFOLDED ✅

Landed:

- `WebGPUClusteredLightingDispatcher.ts` — orchestrates bounds + assign renderers. CPU-side world→eye-space transform via view matrix. Exposes public buffers (`clusterLightsBuffer`, `clusterAABBsBuffer`, `perClusterLightCountBuffer`, `perClusterLightIndicesBuffer`, `paramsBuffer`) and a lazy `consumerBindGroup` getter.
- `Scene._clusteredLightingEnabled` boolean + `Scene.clusteredLightingEnabled` getter/setter as the user-facing toggle.

#### Batch 151 — SceneRenderer per-frame hook → SCAFFOLDED ✅

Landed:

- `WebGPUSceneRenderer._dispatchClusteredLighting(config)` called early in `executeCommands`. Uses `context.endCurrentRenderPass?.()` → dispatch → `context.resumeDefaultRenderPass?.()` to avoid the encoder-locked race (BUG family of Batch 144's CesiumMan startup race).
- Walks `scene.lights` (`LightCollection` from Batch 137b), reads `inverseProjection` + `view` from `uniformState`, hands them to the dispatcher.
- Verified end-to-end via `Tools/visual-regression/probe-clustered-per-frame.mjs`: 2 lights → 4048 cluster overlaps (3456 directional baseline + ~592 point), toggle-on/off observed, 0 device errors.

#### Batch 152 — Model PBR consumer at `@group(4)` → REVERTED ❌, infrastructure-only

Attempted to wire `evalClusteredLights(...)` into `ModelPBRComplete.wgsl` via a new `@group(4)` BGL. Reverted after `Tools/visual-regression/probe-device-limits.mjs` confirmed Chromium-on-Windows caps `maxBindGroups` at **4** (both D3D12 + Vulkan backends in the current dev environment) — the requested `requiredLimits: { maxBindGroups: 5 }` fails device creation entirely with `Required limit (5) is greater than the supported limit (4)`.

What remains live from Batch 152 (infrastructure-only):

- `WebGPUClusteredLightingBGL.ts` — `getClusteredLightingBGL(device)` + `buildClusteredLightingBindGroup(device, buffers)` helpers. Layout is correct; group number is provisional and will change when Batch 153's group-3 merge lands.
- `WebGPUDevicePool.ts` opt-up-only `maxBindGroups` branch — falls through cleanly when the adapter exposes only 4.
- Doc updates flagging the consumer wiring as deferred to Batch 153.

What was reverted:

- `WebGPUModelPipelineCache.js` — removed `getClusteredLightingBGL` import, removed group-4 entry from `_getOrCreatePipelineLayout`, removed chunk prepend from `_getOrCreateShaderModule`.
- `WebGPUModelRenderer.js` — removed group-4 `bindGroups` entry.
- `WebGPUSceneRenderer.ts` — removed `context._clusteredLightingBindGroup` stash (kept a `void this._clusteredLightingDispatcher.consumerBindGroup` to keep the lazy build warm).
- `ModelPBRComplete.wgsl` — removed `evalClusteredLights(...)` call site (replaced with a deferred-to-Batch-153 marker comment).

Verified clean revert via `Tools/visual-regression/probe-model-pbr-audit.mjs`: 5 PBR assets (CesiumMan, CesiumMilkTruck, GroundVehicle, BoxInstanced, BoxUnlit), **0 device errors** (was 6212-6228 errors per asset before revert).

#### Batch 153 — group-3 merge + Model PBR consumer wiring → ✅ SHIPPED (Batch 153)

**Goal (achieved):** Fold the 5 clustered-lighting bindings (`clusterLights`, `clusterAABBs`, `perClusterLightCount`, `perClusterLightIndices`, `clusterParams`) into the existing **group 3 (effects)** BGL so consumer pipelines don't need a 5th bind group. Verified live: `evalClusteredLights(...)` is the additive call at `ModelPBRComplete.wgsl:2255`, reading the `@group(3)` cluster bindings declared by the prepended `ClusteredLighting.wgsl` chunk.

**Scope:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js` — add 5 new entries to the effects BGL at bindings `[18..22]` (current effects bindings end at 17). Pass through the dispatcher's buffer handles via a new constructor option `clusteredLightingBuffers`. Add same 5 entries to both the construction sites (line 679 BGL builder + line 1325 bind-group factory per the Batch 152 pre-compaction note).
- `packages/engine/Source/Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl` — remap `@group(4)` → `@group(3)`; bindings `0..4` → `18..22`. Re-label the BGL inside `WebGPUClusteredLightingBGL.ts` (or retire the helper outright if effects fully subsumes it).
- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — reinstate the `evalClusteredLights(...)` additive call at the deferred-marker site after the sun-direct line (Batch 152 reverted-position).
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js` — prepend `ClusteredLightingChunk` to the Model shader source (the call from Batch 152 that was reverted), unchanged pipeline layout (group count stays at 4).
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — re-add `context._clusteredLightingBindGroup` stash but the bind group is now the effects bind group (already built per frame).

**Verification:**

- `Tools/visual-regression/probe-model-pbr-audit.mjs` continues at 0 device errors.
- Re-run `probe-clustered-per-frame.mjs` to confirm dispatcher still functions.
- New `probe-clustered-visible.mjs`: load a model with a known PointLight at a known position; sample the canvas pixel under the light's footprint; assert brightness > baseline (light off) by a threshold.

**Risk:** The effects BGL is hot — globe, primitive, and Model all read it. Adding 5 more bindings means every consumer pipeline's BGL signature changes, forcing pipeline cache invalidation. This is a one-time cost; the runtime cost is one extra storage buffer read per FS invocation when clustered lighting is enabled (gated by `clusterParams.activeLightCount.x` so it's a uniform branch).

**Effort estimate:** ~1 day. Most of the work is updating the effects BGL builder + downstream pipeline caches; the shader changes are mechanical.

#### Batch 154+ — Lit Mat shaders (21 variants) → ✅ SHIPPED (Batches 154-158)

Same merge applied. After Batch 153 landed and Model PBR consumed the
cluster bindings via group 3 effects, the merge was repeated for each of
the 21 Lit Mat shader sources — each got the same chunk prepend +
`evalClusteredLights(...)` additive call, with the chunk's `@group(N)`
index resolved per-pipeline via the `__CL_GROUP__` token
(`ClusteredLighting.wgsl:100-113`; verified consumed by all 21 sources
under `Shaders/WebGPU/Primitive/`). Batch 154 = mechanism + ColorLit +
NormalMapLit; Batch 155 = the remaining 17 Mat*Lit; Batch 156 = the
legacy Phong primitives; Batch 157 = `PerInstanceColorAppearance`
decode-before-select fix; Batch 158 = the Sandcastle gallery demo. See
the update history at the top of this doc for the full per-batch detail.

**Effort actual:** Batches 154-158 (the per-shader merge plus the Phong
extension, the COMPRESSED-attribute decode fix, and the demo).

---

#### Original step 137e (preserved for reference)

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
plus specular at the light's region. Sandcastle demo: a glTF model
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
