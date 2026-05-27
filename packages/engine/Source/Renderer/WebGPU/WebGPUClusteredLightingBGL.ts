/// <reference types="@webgpu/types" />
/**
 * WebGPUClusteredLightingBGL — Slice 5d Batch 152 (Batch 153 retarget).
 *
 * Per-device helpers for the clustered-lighting bindings.
 *
 * # Group 3 (effects) merge — Batch 153
 *
 * Batch 152 originally targeted a new `@group(4)` BGL on consumer
 * pipelines (Model PBR + the 21 Lit Mat shaders). That approach was
 * reverted after `Tools/visual-regression/probe-device-limits.mjs`
 * confirmed Chromium-on-Windows caps `maxBindGroups` at 4 (both D3D12
 * + Vulkan backends), so a 5th group fails device creation outright.
 *
 * Batch 153 folds the 5 clustered-lighting bindings into the existing
 * `group 3` (effects) BGL at **bindings 18..22**:
 *
 *   binding 18 — clusterLights         : read-only storage
 *   binding 19 — clusterAABBs          : read-only storage
 *   binding 20 — perClusterLightCount  : read-only storage
 *   binding 21 — perClusterLightIndices: read-only storage
 *   binding 22 — clusterParams         : uniform (viewport + planes
 *                                                 + activeLightCount)
 *
 * Visibility = FRAGMENT only. None of these resources are needed in
 * the vertex stage — cluster lookup happens at fragment time using
 * fragCoord + viewZ.
 *
 * This file exports two helpers:
 *
 *   - {@link CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES} — the 5 BGL
 *     entries (bindings 18..22) ready to spread into the effects BGL
 *     entry list. WebGPUEffectsBindGroup.js consumes this so the
 *     binding numbers + visibility live in one place.
 *
 *   - {@link getClusteredLightingPlaceholders} — per-device tiny
 *     placeholder buffers for the 5 bindings. The placeholder
 *     `clusterParams` is zero-filled so `activeLightCount = 0` and
 *     the FS chunk's `evalClusteredLights(...)` early-outs without
 *     touching the storage slots. Used by the effects BGL's
 *     placeholder bind group AND by the active bind group when the
 *     scene's clustered-lighting dispatcher isn't running.
 *
 * # Legacy `@group(4)` helpers — DEPRECATED (kept for backward compat)
 *
 * `getClusteredLightingBGL` and `buildClusteredLightingBindGroup`
 * below are the original Batch 152 `@group(4)` helpers. They are
 * retained so the dispatcher's `consumerBindGroup` lazy getter still
 * compiles (the dispatcher pre-builds a bind group that's no longer
 * consumed — Batch 153 routes the bindings through the effects bind
 * group instead). Mark for removal once Lit Mat consumers (Batch 154+)
 * have all migrated and the dispatcher's getter is retired.
 *
 * @module WebGPUClusteredLightingBGL
 */

/**
 * Starting binding index for clustered lighting on group 3 (effects).
 * Effects bindings 0..17 are claimed by shadow/clip/SDF/atmosphere/CSM/
 * edges/cube-depth resources; 18..22 are the 5 clustered-lighting
 * slots added in Batch 153.
 */
export const CLUSTERED_LIGHTING_EFFECTS_BINDING_BASE = 18;

/**
 * BGL entries for the 5 clustered-lighting bindings, ready to spread
 * into the effects BGL entry list. Bindings 18..22 — read-only storage
 * for clusterLights / clusterAABBs / perClusterLightCount /
 * perClusterLightIndices, plus a uniform buffer for clusterParams.
 *
 * All FRAGMENT visibility — cluster lookup happens at fragment time.
 *
 * Effects BGL builder uses these directly so the binding numbers +
 * types live in one place; the WGSL chunk in
 * `Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl` must declare
 * the matching `@group(3) @binding(18..22)` slots.
 */
export const CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES: ReadonlyArray<GPUBindGroupLayoutEntry> =
  [
    {
      binding: 18,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 19,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 20,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 21,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 22,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    },
  ];

/**
 * Per-device placeholder buffers for the clustered-lighting bindings.
 * `params` is zero-filled so `activeLightCount = 0`, which the FS chunk
 * reads as "early-out, do not sample the storage buffers".
 *
 * Used by:
 *   - the placeholder effects bind group (constructed eagerly at
 *     device init, before any dispatcher exists).
 *   - the active effects bind group when the scene either has no
 *     dispatcher yet OR `scene.clusteredLightingEnabled === false`.
 *
 * Storage buffer sizes must each be at least one element of the
 * matching WGSL array type, because WebGPU validates the bound buffer
 * size against the pipeline's derived `minBindingSize` for unsized
 * `array<T>` storage variables at draw time. With smaller placeholders
 * the validator rejects the pipeline ("buffer binding is too small")
 * even though the FS chunk would short-circuit on activeLightCount=0
 * at execution time.
 *
 * Sizes per binding (match the WGSL declarations in
 * `Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl`):
 *
 *   - clusterLights         : `array<ClusteredLight>`  — 80 B per element
 *   - clusterAABBs          : `array<ClusteredAABB>`   — 32 B per element
 *   - perClusterLightCount  : `array<u32>`             — 4 B per element
 *   - perClusterLightIndices: `array<u32>`             — 4 B per element
 *   - params                : `ClusteredParams` uniform — 32 B
 *
 * Total: ~152 B per device. Cost is trivial compared to the dispatcher's
 * real allocations (~3.7 MB when in use).
 */
export interface ClusteredLightingPlaceholderBuffers {
  clusterLights: GPUBuffer;
  clusterAABBs: GPUBuffer;
  perClusterLightCount: GPUBuffer;
  perClusterLightIndices: GPUBuffer;
  params: GPUBuffer;
}

const _placeholderCache = new WeakMap<
  GPUDevice,
  ClusteredLightingPlaceholderBuffers
>();

export function getClusteredLightingPlaceholders(
  device: GPUDevice,
): ClusteredLightingPlaceholderBuffers {
  const cached = _placeholderCache.get(device);
  if (cached) return cached;

  const makeStorage = (label: string, size: number): GPUBuffer => {
    const buf = device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Zero-fill — when the FS chunk DOES read at activeLightCount > 0
    // these would be garbage, but the placeholder path always has
    // activeLightCount = 0 so the bytes never matter. Zero-init keeps
    // the buffer in a deterministic state for debugging.
    device.queue.writeBuffer(buf, 0, new Uint8Array(size));
    return buf;
  };

  const params = device.createBuffer({
    label: "ClusteredLighting placeholder params (activeLightCount=0)",
    size: 32, // 2 vec4 = 32 bytes — matches the WGSL ClusteredParams layout
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(params, 0, new Float32Array(8));

  const placeholders: ClusteredLightingPlaceholderBuffers = {
    // ClusteredLight = 5 vec4 = 80 bytes per element
    clusterLights: makeStorage(
      "ClusteredLighting placeholder clusterLights",
      80,
    ),
    // ClusteredAABB = 2 vec4 = 32 bytes per element
    clusterAABBs: makeStorage("ClusteredLighting placeholder clusterAABBs", 32),
    // array<u32> stride = 4 bytes
    perClusterLightCount: makeStorage(
      "ClusteredLighting placeholder perClusterLightCount",
      4,
    ),
    perClusterLightIndices: makeStorage(
      "ClusteredLighting placeholder perClusterLightIndices",
      4,
    ),
    params,
  };
  _placeholderCache.set(device, placeholders);
  return placeholders;
}

/**
 * Drop the per-device placeholder cache entry. Called from
 * WebGPUContext device-loss recovery so the dead device's placeholder
 * buffers become unreachable immediately.
 */
export function clearClusteredLightingPlaceholdersForDevice(
  device: GPUDevice,
): void {
  _placeholderCache.delete(device);
}

// ===========================================================================
// Legacy @group(4) helpers (Batch 152) — DEPRECATED, see module docstring
// ===========================================================================

const _legacyBglCache = new WeakMap<GPUDevice, GPUBindGroupLayout>();

/**
 * @deprecated Batch 152 `@group(4)` BGL — kept for the dispatcher's
 * `consumerBindGroup` lazy getter which is no longer consumed by any
 * pipeline. Slated for removal after the Lit Mat consumers (Batch 154+)
 * migrate to the group-3 effects bindings.
 */
export function getClusteredLightingBGL(device: GPUDevice): GPUBindGroupLayout {
  const cached = _legacyBglCache.get(device);
  if (cached) return cached;

  const bgl = device.createBindGroupLayout({
    label: "ClusteredLighting BGL (legacy @group(4), Batch 152 — unconsumed)",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  _legacyBglCache.set(device, bgl);
  return bgl;
}

/**
 * @deprecated Batch 152 helper — see `getClusteredLightingBGL` note.
 */
export function buildClusteredLightingBindGroup(
  device: GPUDevice,
  buffers: {
    clusterLights: GPUBuffer;
    clusterAABBs: GPUBuffer;
    perClusterLightCount: GPUBuffer;
    perClusterLightIndices: GPUBuffer;
    params: GPUBuffer;
  },
): GPUBindGroup {
  return device.createBindGroup({
    label: "ClusteredLighting BG (legacy @group(4), unconsumed)",
    layout: getClusteredLightingBGL(device),
    entries: [
      { binding: 0, resource: { buffer: buffers.clusterLights } },
      { binding: 1, resource: { buffer: buffers.clusterAABBs } },
      { binding: 2, resource: { buffer: buffers.perClusterLightCount } },
      { binding: 3, resource: { buffer: buffers.perClusterLightIndices } },
      { binding: 4, resource: { buffer: buffers.params } },
    ],
  });
}
