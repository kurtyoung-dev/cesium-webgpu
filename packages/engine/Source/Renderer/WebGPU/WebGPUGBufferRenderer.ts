/// <reference types="@webgpu/types" />
/**
 * G-buffer renderer — Phase 8a Slice 2 (Batch 85).
 *
 * Owns the screen-space normal-from-depth compute pass. Reads the
 * resolved scene depth and writes packed `(normalEye, roughness=1)` into
 * the color attachment of `view.gBufferFramebuffer` (Phase 8a Slice 1,
 * Batch 80).
 *
 * Lifecycle:
 *   - `ensureGBufferComputeResources(host, device)` — allocates the
 *     uniforms UBO + the persistent bind-group layout. Idempotent;
 *     cached on the host.
 *   - `dispatchGBufferNormalsFromDepth(host, encoder, device, params)`
 *     — packs the inverse-projection matrix + viewport size into the
 *     UBO, rebuilds the per-frame bind group (depth view + G-buffer
 *     storage view can both change per resize), then dispatches the
 *     `computeNormalFromDepth` entry point via `host.dispatchCompute`.
 *
 * Patterned after `WebGPUAtmosphereLUT.ts` — same host-interface
 * shape, same cache model, same compute-task-type routing through
 * `WebGPUPerformanceManager.dispatchCompute`.
 *
 * @see migration_doc/WEBGPU_DEBUGGING_LOG.md Batch 85
 * @module WebGPUGBufferRenderer
 */

import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  storageTexture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ComputeTaskType } from "./WebGPUPerformanceManager.js";
import type { ComputeTaskTypeValue } from "./WebGPUPerformanceManager.js";

// Phase 8a Slice 2d (Batch 90) — pull the shader sources directly so
// the dispatcher can create its own pipelines with explicit BGLs (the
// `host.dispatchCompute` path uses pipeline-specific auto-layouts that
// can't be paired with custom-built bind groups for the MSAA depth
// binding).
import GBufferNormalsFromDepthSource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepth.js";
import GBufferNormalsFromDepthMSAASource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepthMSAA.js";

const WORKGROUP_SIZE = 8;

export interface GBufferComputeResources {
  uniformsBuffer: GPUBuffer;
  uniformsData: Float32Array;
  // Phase 8a Slice 2d (Batch 90) — two bind group layouts, two bind
  // groups, two pipelines: one set each for single-sample and
  // multisampled depth. WGSL declares texture sample type at module
  // scope, so two shaders + two pipelines are required.
  //
  // We CREATE THE PIPELINES DIRECTLY with our custom BGLs (instead of
  // routing through `host.dispatchCompute` which uses auto-layout)
  // because WebGPU requires reference-identity match between the bind
  // group's layout and the pipeline's expected layout. Auto-layouts
  // are pipeline-specific objects and cannot be shared with custom-
  // built BGLs. The atmosphere LUT works around this by relying on
  // browser leniency for storage-texture-only layouts; the MSAA depth
  // binding type is stricter and requires explicit BGL plumbing.
  bindGroupLayout: GPUBindGroupLayout | null;
  bindGroupLayoutMSAA: GPUBindGroupLayout | null;
  pipeline: GPUComputePipeline | null;
  pipelineMSAA: GPUComputePipeline | null;
  cachedBindGroup: GPUBindGroup | null;
  cachedBindGroupMSAA: GPUBindGroup | null;
  cachedDepthView: GPUTextureView | null;
  cachedOutputView: GPUTextureView | null;
}

export interface GBufferComputeHost {
  _gbufferComputeResources: GBufferComputeResources | null;
  readonly _context: { supportsComputeShaders: boolean };
  dispatchCompute(
    encoder: GPUCommandEncoder,
    taskType: ComputeTaskTypeValue,
    bindGroups: { index: number; bindGroup: GPUBindGroup }[],
    workgroupCountX: number,
    workgroupCountY: number,
    workgroupCountZ: number,
    entryPoint?: string,
  ): void;
}

export function ensureGBufferComputeResources(
  host: GBufferComputeHost,
  device: GPUDevice,
): GBufferComputeResources | null {
  if (host._gbufferComputeResources) {
    return host._gbufferComputeResources;
  }
  if (!host._context.supportsComputeShaders) {
    return null;
  }

  // Uniforms layout (16-byte aligned):
  //   inverseProjection (mat4x4)  — 16 floats = 64 bytes
  //   viewportSize     (vec4)     —  4 floats = 16 bytes
  //                              total: 20 floats = 80 bytes
  const uniformsData = new Float32Array(20);
  const uniformsBuffer = device.createBuffer({
    label: "GBufferCompute_Uniforms",
    size: uniformsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  host._gbufferComputeResources = {
    uniformsBuffer,
    uniformsData,
    bindGroupLayout: null,
    bindGroupLayoutMSAA: null,
    pipeline: null,
    pipelineMSAA: null,
    cachedBindGroup: null,
    cachedBindGroupMSAA: null,
    cachedDepthView: null,
    cachedOutputView: null,
  };
  return host._gbufferComputeResources;
}

export interface GBufferDispatchParams {
  // Column-major mat4x4 (length 16). Eye-space output from
  // `inverse(projection)`. CPU packs this from
  // `uniformState.inverseProjection` (NOT inverseViewProjection — we
  // want eye-space positions, not world).
  inverseProjection: Float32Array | number[];
  viewportWidth: number;
  viewportHeight: number;
  depthView: GPUTextureView;
  outputView: GPUTextureView;
  // Phase 8a Slice 2d (Batch 90) — sample count of the depth view.
  // When > 1, the dispatcher selects the multisampled-depth pipeline
  // (`NORMAL_FROM_DEPTH_MSAA`) and binds the depth view as
  // `texture_depth_multisampled_2d`. When 1 (or undefined), the
  // single-sample pipeline runs as before. Cesium's default is 4 —
  // pre-Slice-2d the producer silently bailed on MSAA scenes.
  depthSampleCount?: number;
}

export function dispatchGBufferNormalsFromDepth(
  host: GBufferComputeHost,
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  params: GBufferDispatchParams,
): boolean {
  if (!host._context.supportsComputeShaders) return false;
  const res = ensureGBufferComputeResources(host, device);
  if (!res) return false;

  // Pack uniforms.
  const f = res.uniformsData;
  for (let i = 0; i < 16; i++) {
    f[i] = params.inverseProjection[i];
  }
  f[16] = params.viewportWidth;
  f[17] = params.viewportHeight;
  f[18] = 0.0; // .z reserved
  f[19] = 0.0; // .w reserved
  device.queue.writeBuffer(
    res.uniformsBuffer,
    0,
    f.buffer,
    f.byteOffset,
    f.byteLength,
  );

  const isMSAA = (params.depthSampleCount ?? 1) > 1;

  // Pick the right bind-group layout. The MSAA path binds
  // `texture_depth_multisampled_2d`; the single-sample path binds
  // `texture_depth_2d`. WGSL requires the binding type to match the
  // texture-view's sample count, so we keep separate layouts (and
  // separate bind groups) for the two cases. Both layouts share the
  // same binding slots so the dispatcher's WGSL helper code is
  // identical except for the texture-load call.
  if (isMSAA) {
    if (!res.bindGroupLayoutMSAA) {
      res.bindGroupLayoutMSAA = makeBindGroupLayout(
        device,
        "GBufferCompute_BGL_MSAA",
        [
          uniformBuffer(0, Stage.COMPUTE),
          texture(1, Stage.COMPUTE, {
            sampleType: "depth",
            multisampled: true,
          }),
          storageTexture(2, Stage.COMPUTE, "rgba16float"),
        ],
      );
    }
  } else {
    if (!res.bindGroupLayout) {
      res.bindGroupLayout = makeBindGroupLayout(device, "GBufferCompute_BGL", [
        uniformBuffer(0, Stage.COMPUTE),
        texture(1, Stage.COMPUTE, { sampleType: "depth" }),
        storageTexture(2, Stage.COMPUTE, "rgba16float"),
      ]);
    }
  }

  // Bind group cache. Switching between MSAA and non-MSAA pipelines
  // invalidates the cache (cached views from the other path no longer
  // apply to the new layout). Same-path resize also invalidates.
  const layout = isMSAA ? res.bindGroupLayoutMSAA! : res.bindGroupLayout!;
  const cacheKey = isMSAA ? "cachedBindGroupMSAA" : "cachedBindGroup";
  if (
    !res[cacheKey] ||
    res.cachedDepthView !== params.depthView ||
    res.cachedOutputView !== params.outputView
  ) {
    const bg = device.createBindGroup({
      label: isMSAA ? "GBufferCompute_BG_MSAA" : "GBufferCompute_BG",
      layout,
      entries: [
        { binding: 0, resource: { buffer: res.uniformsBuffer } },
        { binding: 1, resource: params.depthView },
        { binding: 2, resource: params.outputView },
      ],
    });
    res[cacheKey] = bg;
    res.cachedDepthView = params.depthView;
    res.cachedOutputView = params.outputView;
    // Invalidate the OTHER cache when views change — a future
    // dispatch on the other path would re-create it on demand.
    if (isMSAA) {
      res.cachedBindGroup = null;
    } else {
      res.cachedBindGroupMSAA = null;
    }
  }

  // Build the pipeline ourselves with the explicit BGL. The
  // `host.dispatchCompute` path uses auto-layout which is
  // pipeline-specific and can't be paired with custom bind groups —
  // works for atmosphere LUT's storage-only bindings but fails for the
  // MSAA depth binding (browser strict mode rejects the layout
  // mismatch and the dispatch becomes a silent no-op).
  if (isMSAA) {
    if (!res.pipelineMSAA) {
      const module = device.createShaderModule({
        label: "GBufferCompute_Module_MSAA",
        code: GBufferNormalsFromDepthMSAASource,
      });
      const pipelineLayout = device.createPipelineLayout({
        label: "GBufferCompute_PipelineLayout_MSAA",
        bindGroupLayouts: [res.bindGroupLayoutMSAA!],
      });
      res.pipelineMSAA = device.createComputePipeline({
        label: "GBufferCompute_Pipeline_MSAA",
        layout: pipelineLayout,
        compute: { module, entryPoint: "computeNormalFromDepth" },
      });
    }
  } else {
    if (!res.pipeline) {
      const module = device.createShaderModule({
        label: "GBufferCompute_Module",
        code: GBufferNormalsFromDepthSource,
      });
      const pipelineLayout = device.createPipelineLayout({
        label: "GBufferCompute_PipelineLayout",
        bindGroupLayouts: [res.bindGroupLayout!],
      });
      res.pipeline = device.createComputePipeline({
        label: "GBufferCompute_Pipeline",
        layout: pipelineLayout,
        compute: { module, entryPoint: "computeNormalFromDepth" },
      });
    }
  }

  const wgsX = Math.ceil(params.viewportWidth / WORKGROUP_SIZE);
  const wgsY = Math.ceil(params.viewportHeight / WORKGROUP_SIZE);
  const pipeline = isMSAA ? res.pipelineMSAA! : res.pipeline!;
  const bg = res[cacheKey]!;

  const pass = encoder.beginComputePass({
    label: isMSAA ? "GBufferProducer_MSAA" : "GBufferProducer",
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(wgsX, wgsY, 1);
  pass.end();

  // `dispatchCompute` no longer used — taskType / entryPoint args are
  // now redundant. Keep the host interface for forward-compat with
  // any future caller; this dispatcher doesn't need it.
  void ComputeTaskType;
  void host;

  return true;
}
