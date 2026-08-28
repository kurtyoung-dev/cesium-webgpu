/// <reference types="@webgpu/types" />
/**
 * Provides the fallback G-buffer compute pass. It reconstructs eye-space
 * normals and a depth-gradient roughness proxy from resolved scene depth and
 * writes them to `view.gBufferFramebuffer.normalRoughnessTexture`.
 *
 * The current scene framebuffer uses its multiple-render-target topology on
 * every non-pick frame, independently of consumer demand. While that topology
 * is active, fragment pipelines with normal-roughness outputs populate the
 * attachment and this fallback is skipped; other pipelines leave its clear
 * sentinel.
 *
 * Single-sample and multisample depth require separate shader modules,
 * bind-group layouts, bind groups, and pipelines because WGSL fixes the depth
 * texture type in the module.
 *
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

// Pipelines use explicit layouts because the automatic layouts created by
// `host.dispatchCompute` are pipeline-specific and cannot accept the custom
// bind groups required by the multisampled-depth variant.
import GBufferNormalsFromDepthSource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepth.js";
import GBufferNormalsFromDepthMSAASource from "../../Shaders/WebGPU/Compute/GBufferNormalsFromDepthMSAA.js";

const WORKGROUP_SIZE = 8;

function tryDestroyGpuBuffer(buffer: GPUBuffer): void {
  try {
    buffer.destroy();
  } catch {
    // A lost device can reject native teardown; replacement still proceeds.
  }
}

export interface GBufferComputeResources {
  device: GPUDevice;
  uniformsBuffer: GPUBuffer;
  uniformsData: Float32Array;
  // Single-sample and multisample depth use separate resource sets because
  // WGSL fixes the texture sample type at module scope. The pipelines are
  // created from the same explicit layouts used by their bind groups; an
  // automatic pipeline layout has a distinct identity.
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
  const cached = host._gbufferComputeResources;
  if (cached?.device === device) {
    return cached;
  }
  if (cached) {
    host._gbufferComputeResources = null;
    tryDestroyGpuBuffer(cached.uniformsBuffer);
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
    device,
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
  // Column-major 4x4 inverse projection matrix (16 values). The producer
  // reconstructs eye-space positions, so this is
  // `uniformState.inverseProjection`, not `inverseViewProjection`.
  inverseProjection: Float32Array | number[];
  viewportWidth: number;
  viewportHeight: number;
  depthView: GPUTextureView;
  outputView: GPUTextureView;
  // Sample count of `depthView`. Values greater than 1 select the
  // `texture_depth_multisampled_2d` shader and layout; 1 or `undefined` selects
  // the `texture_depth_2d` path.
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

  // Select the bind-group layout matching the depth texture type. Both layouts
  // share binding slots, so the shader variants differ only in their
  // texture-load operation.
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
    // A view change invalidates the bind group for the alternate sample-count
    // path so it is rebuilt before that path runs again.
    if (isMSAA) {
      res.cachedBindGroup = null;
    } else {
      res.cachedBindGroupMSAA = null;
    }
  }

  // The pipeline uses the same explicit layout object as its bind group.
  // Pipeline-specific automatic layouts have a different identity and are not
  // compatible with these custom bindings.
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

  // The explicit pipeline path retains the shared compute-host surface but does
  // not use its dispatcher or task type.
  void ComputeTaskType;
  void host;

  return true;
}
