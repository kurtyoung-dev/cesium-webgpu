/// <reference types="@webgpu/types" />
/**
 * WebGPUClusteredLightingBGL — Slice 5d Batch 152.
 *
 * Centralized factory for the clustered-lighting bind group layout
 * + bind group that the per-frame dispatcher
 * (WebGPUClusteredLightingDispatcher) lazy-builds for consumer
 * pipelines (Model PBR + the 21 Lit Mat shaders, wired in Batch 153+).
 *
 * Layout matches the ClusteredLighting.wgsl chunk (Batch 149):
 *   binding 0 — clusterLights        : read-only storage
 *   binding 1 — clusterAABBs         : read-only storage
 *   binding 2 — perClusterLightCount : read-only storage
 *   binding 3 — perClusterLightIndices: read-only storage
 *   binding 4 — clusterParams        : uniform (viewport + planes + activeLightCount)
 *
 * Visibility = FRAGMENT only. None of these resources are needed
 * in the vertex stage — cluster lookup happens at fragment time
 * using fragCoord + viewZ.
 *
 * # Group number is NOT FINAL
 *
 * Batch 152 originally targeted @group(4) — adding a fifth bind
 * group to Model PBR. That approach was reverted after
 * `Tools/visual-regression/probe-device-limits.mjs` confirmed
 * Chromium-on-Windows caps `maxBindGroups` at 4 (both D3D12 + Vulkan
 * backends in the current dev environment). Batch 153 will fold
 * these 5 bindings into the existing group 3 (effects) BGL rather
 * than allocate a 5th group; consumers will then resolve the
 * cluster bindings at group 3, bindings N..N+4 instead of
 * @group(4), bindings 0..4. The labels + the "@group(4)" mention
 * inside the BGL label are stale and will be re-labeled when the
 * merge lands.
 *
 * # Per-device cache
 *
 * The BGL is stateless (depends only on the WebGPU device's
 * limits) — cached per-device via a WeakMap. Multiple consumer
 * pipeline caches (Model PBR + each Lit Mat variant) share the
 * same BGL instance.
 *
 * @module WebGPUClusteredLightingBGL
 */

const _perDeviceCache = new WeakMap<GPUDevice, GPUBindGroupLayout>();

export function getClusteredLightingBGL(device: GPUDevice): GPUBindGroupLayout {
  const cached = _perDeviceCache.get(device);
  if (cached) return cached;

  const bgl = device.createBindGroupLayout({
    label: "ClusteredLighting BGL (@group(4))",
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
  _perDeviceCache.set(device, bgl);
  return bgl;
}

/**
 * Build a bind group binding the dispatcher's GPU buffers (or
 * placeholders) at @group(4) for consumer pipelines. Pass the buffer
 * handles returned by `WebGPUSceneRenderer._getClusteredLightingBuffers()`
 * — they include device-zero placeholders for the first-frame /
 * disabled cases, so this function is always safe to call.
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
    label: "ClusteredLighting BG",
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
