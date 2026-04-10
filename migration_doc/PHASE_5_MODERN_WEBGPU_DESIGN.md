# Phase 5 — Modern WebGPU Feature Adoption Design

**Status:** Capability detection landed 2026-04-09; per-feature implementations deferred.
**Created:** 2026-04-09

---

## Capability snapshot (now reachable from `Scene.getDebugSnapshot()`)

`WebGPUContext.getRendererStatistics()` now exposes a `capabilities` block:

```js
scene.getDebugSnapshot().renderer.capabilities
// {
//   enabledFeatures: ["float32-filterable", "shader-f16", ...],
//   hasShaderF16: true,
//   hasDualSourceBlending: false,
//   hasClipDistances: true,
//   hasTimestampQuery: true,
//   hasIndirectFirstInstance: true,
//   hasFloat32Filterable: true,
//   hasSubgroups: true,
//   hasBgra8UnormStorage: false,
// }
```

This is the source of truth for "can I wire feature X on this adapter today?". The migration plan below assumes the operator has verified the snapshot before opting into a feature.

The following features are already in the `DESIRED_FEATURES` list and auto-requested at device creation time. The capability snapshot reflects what the adapter actually granted.

| Feature | Auto-requested | Wired consumer | Notes |
|---|---|---|---|
| `float32-filterable` | Yes | Yes (terrain heightmaps via `WebGPUContext.textureFloatLinear`) | Already in production |
| `texture-compression-bc` / `etc2` / `astc` | Yes | Yes (via the `s3tc` / `etc` / `astc` flags) | Already in production |
| `timestamp-query` | Yes | Yes (`WebGPUTimestampProfiler`) | Used by `Scene.beginPerformanceTrace` |
| `subgroups` | Yes | Partial (`FrustumCull` + `PointCloudLOD`) | Subgroup-aware compute variants |
| `clip-distances` | Yes | **No** | See WGF-1 below |
| `dual-source-blending` | Yes | **No** | See WGF-2 below |
| `shader-f16` | Yes | **No** | See WGF-3 below |
| `indirect-first-instance` | Yes | **No** | Pairs with `WebGPUIndirectDrawManager` — see WGF-5 |
| `bgra8unorm-storage` | Yes | **No** | Niche; for compute-write to swap chain |
| `rg11b10ufloat-renderable` | Yes | **No** | HDR render targets |

---

## WGF-4 — Uniform Buffer Standard Layout (drop std140 padding)

**Goal:** drop the manual `_pad0` / `_pad1` fields scattered through every UBO struct in `Source/Renderer/WebGPU/`. The WebGPU spec already permits the standard layout for storage buffers; the std140 padding is a habit inherited from GLSL/UBOs.

**Important clarification:** WGF-4 is *not* a WebGPU device feature flag. It's a WGSL packing rule that's already part of the spec (`uniform_buffer_standard_layout` in the GLSL extension equivalent). The migration is purely:
1. Drop the explicit `_pad0` / `_pad1` fields from WGSL structs
2. Drop the corresponding zero writes from the JS uniform packers
3. Verify the new sizes match `device.limits.minUniformBufferOffsetAlignment` (256 bytes is the standard)

**Estimated win:** ~20% UBO size reduction, modest CPU win on the per-frame `queue.writeBuffer` path because there's less data to copy.

**Migration order** (incremental, one UBO at a time):

1. **Camera UBO** (`WebGPUCameraUniforms.ts`) — biggest, most-touched. Drop the trailing `_pad` slot and audit the consumer shaders for explicit `_pad` references.
2. **Tile UBO** (`WebGPUGlobeSurfaceRenderer.ts` tile uniform packing) — second biggest. Currently 256 bytes with at least 4 padding floats; should compress to ~240.
3. **Effect UBOs** — color grading (the new one we just landed), tonemapping, FXAA, bloom params. Each is small but auditing them as a batch closes the door on future drift.
4. **Compute UBOs** — atmosphere LUT, volumetric fog params, sort keys, occlusion test. Already small; mostly cosmetic.

**Per-UBO acceptance criteria**:
- WGSL struct compiles without padding fields
- JS packer doesn't write to the dropped offsets (no off-by-one bugs)
- Uniform buffer size still satisfies `minUniformBufferOffsetAlignment` after dropping padding (round up to 16/64/256 as required)
- Existing scene renders identically

**Risk:** silent off-by-one in a JS packer that still writes to the old offset, scribbling into the next field. **Mitigation:** add a runtime assertion in debug builds that the packer's last-written offset matches the new struct size.

**Effort:** ~1 day per major UBO, ~0.5 day per small UBO. Total ~3-5 days to flip everything. Recommendation: do the camera UBO first (biggest single win), measure with the perf tracker, then commit to the rest.

---

## WGF-1 — `clip-distances`

**Goal:** replace stencil-based clipping plane support with hardware clip distances. Faster (no fragment discard cost) and avoids the depth attachment side effect.

**State:** detected, never wired. The `ClippingPlaneCollection` infrastructure already lives in Scene; the WebGPU receive path currently does fragment discard against per-pixel plane equations.

**Migration:**
1. Add a `@builtin(clip_distances)` array<f32, 8> output to the affected vertex shaders (terrain + primitive)
2. The vertex shader writes the signed distance to each enabled clipping plane
3. Drop the corresponding `if (clipDistance < 0) { discard; }` blocks from the fragment shaders

**Estimated win:** ~10-15% fragment cost on heavily-clipped scenes. Negligible on scenes with no clipping.

**Effort:** ~1-2 days, all in the shader chunks. No JS-side changes.

---

## WGF-2 — `dual-source-blending`

**Goal:** replace the multi-pass weighted-blended OIT with a single-pass version that uses dual-source output.

**State:** detected, never wired. The current OIT path is in `WebGPUOIT.ts` and uses two render targets + a separate composite pass.

**Migration:**
1. Audit `WebGPUOIT.ts` for the current weighted-average accumulator structure
2. Add a second `@location(1)` fragment output to the OIT-aware fragment shaders, using the dual-source blend factors
3. Set `targets[0].blend.color.srcFactor = "one"` and the dual-source equivalents
4. Drop the composite pass

**Estimated win:** ~30-50% reduction in OIT cost (one pass instead of two, no MRT). Only matters when many translucent objects are visible.

**Effort:** ~2-3 days. The blend equation tuning is the tricky part — dual-source weights need to match the existing visual output.

---

## WGF-3 — `shader-f16`

**Goal:** half-precision math in selected fragment shaders for 2× bandwidth and 2× ALU throughput on supported GPUs.

**State:** detected, never wired. The shader-f16 extension lets WGSL declare `f16` types and use them in arithmetic.

**Where it pays off:**
- **Tonemapping** — color is already in [0, 1] SDR, half precision is more than enough
- **Color grading** (the one we just landed) — same reason
- **Bloom blur kernels** — the blurred values are anyway clamped
- **FXAA** — luminance differences fit comfortably in f16
- **Sky / atmosphere fragment shaders** — except for the LUT lookups themselves; the result of the lookup goes through f16 just fine

**Where it does NOT pay off:**
- Any shader that touches the camera RTE positions (precision-critical)
- Globe terrain main shader (tile UV coords need f32)
- Anything that participates in the depth buffer

**Migration:**
1. Add a `@requires` directive to the targeted shaders (with a fallback shader for adapters without `shader-f16`)
2. Convert color math from `f32` to `f16` types
3. Add a runtime check in the dispatcher to pick the right shader variant

**Estimated win:** ~20-40% fragment ALU saving on the targeted post-process passes. Doesn't help vertex-bound shaders.

**Effort:** ~2-3 days for the post-process effects. Whole-pipeline conversion would be much more.

---

## WGF-5 — `indirect-first-instance` + `chromium-experimental-multi-draw-indirect`

**Goal:** GPU-driven N-draw rendering with per-instance data indexing — the foundation for "issue 10000 draw calls in one API call".

**State:** `indirect-first-instance` detected; `chromium-experimental-multi-draw-indirect` not yet detected (needs adding to `DESIRED_FEATURES`).

**Migration:**
1. Add `chromium-experimental-multi-draw-indirect` to `DESIRED_FEATURES` and the capability snapshot
2. Wire `WebGPUIndirectDrawManager` to use `multiDrawIndirect` when available
3. Build a "command bucket → indirect buffer" CPU-side packer for static tile sets

**Estimated win:** massive on tightly-instanced point cloud / batched-table tile sets. Negligible on scenes with unique per-tile bind groups (the common case for textured terrain).

**Effort:** ~3-4 days. The CPU-side bucket packer is the bulk of the work.

---

## Recommended order

1. **Capability snapshot** — done 2026-04-09
2. **WGF-4 camera UBO migration** — biggest single UBO win, ~1 day
3. **WGF-1 `clip-distances`** — small, contained, 1-2 days, immediate visible perf
4. **WGF-3 `shader-f16` for color grading + bloom + tonemap** — opt-in via shader variant, ~2 days
5. **WGF-2 `dual-source-blending`** — only if a real translucent-heavy scene shows up
6. **WGF-5 `multi-draw-indirect`** — only if a point cloud / batched scene shows up

The first three (~5-6 days total) are high-leverage and low-risk. The remaining two are scene-dependent and should wait for a real consumer.
