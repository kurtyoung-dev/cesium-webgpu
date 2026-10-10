/// <reference types="@webgpu/types" />
/**
 * The post-process pipelines whose colour-target format is baked in: the
 * single-pass stages and the identity blit to the canvas.
 *
 * A single-pass stage (Tonemap, ColorGrading, FXAA and every custom stage)
 * bakes its colour-target format into its `GPURenderPipeline`, while the pass
 * that runs it attaches a ping-pong view whose format is the pipeline's
 * current intermediate format. The two must agree or the pass fails
 * validation and the stage renders nothing. The intermediate format follows
 * `highDynamicRange` (rgba16float) and, in SDR, the canvas format, so it can
 * change for the life of a stage that is created only once. The identity blit
 * writes the canvas itself, so it must match the presentation format, which
 * `useHDRCanvasOutput` switches between the preferred format and rgba16float.
 *
 * Rebuilding a stage in place, rather than dropping it and re-adding it, keeps
 * everything it carries that is independent of the target format: its
 * uniform buffer and therefore every value written into it at runtime (the
 * tonemap mode, exposure and dither, the colour grade, the FXAA texel size and
 * `hdrMode`), its enabled flag, its shader module and its bind-group layout.
 * Only the render pipeline, which is the one format-bound object, is replaced.
 *
 * @module WebGPUPostProcessFormatPipelines
 */

import {
  makeBindGroupLayout,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * The fields of a compiled single-pass stage that a retarget reads and
 * replaces. The pipeline's own stage record satisfies it structurally.
 */
export interface RetargetableStage {
  name: string;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  shaderModule: GPUShaderModule;
  targetFormat: GPUTextureFormat;
  cachedBindGroup?: GPUBindGroup;
  cachedSourceView?: GPUTextureView;
}

/**
 * Builds the fullscreen-triangle render pipeline a single-pass stage runs
 * with. The one descriptor serves both the first compile and every retarget,
 * so the two cannot drift apart.
 */
export function createSinglePassStagePipeline(
  device: GPUDevice,
  name: string,
  shaderModule: GPUShaderModule,
  bindGroupLayout: GPUBindGroupLayout,
  targetFormat: GPUTextureFormat,
): GPURenderPipeline {
  const pipelineLayout = device.createPipelineLayout({
    label: `PostProcess-${name}-PipelineLayout`,
    bindGroupLayouts: [bindGroupLayout],
  });
  return device.createRenderPipeline({
    label: `PostProcess-${name}-Pipeline`,
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format: targetFormat }],
    },
    primitive: { topology: "triangle-list" },
  });
}

/**
 * Rebuilds, on the device that compiled them, the render pipeline of every
 * stage whose baked target format differs from `targetFormat`. Stages already
 * at that format, and null slots, are left untouched, so calling this on a
 * plain resize compiles nothing.
 *
 * The device must be the one each stage's module and layout were created on:
 * GPU objects cannot cross devices, and a device change is served by the
 * pipeline's owner dropping the whole pipeline.
 *
 * @returns The number of stages rebuilt.
 */
export function retargetSinglePassStages(
  device: GPUDevice,
  stages: ReadonlyArray<RetargetableStage | null>,
  targetFormat: GPUTextureFormat,
): number {
  let rebuilt = 0;
  for (const stage of stages) {
    if (!stage || stage.targetFormat === targetFormat) {
      continue;
    }
    stage.pipeline = createSinglePassStagePipeline(
      device,
      stage.name,
      stage.shaderModule,
      stage.bindGroupLayout,
      targetFormat,
    );
    stage.targetFormat = targetFormat;
    // The layout is unchanged, but the cached group was built against the
    // ping-pong view the format change has just replaced.
    stage.cachedBindGroup = undefined;
    stage.cachedSourceView = undefined;
    rebuilt++;
  }
  return rebuilt;
}

/**
 * Builds a minimal fullscreen-triangle pipeline that samples a source
 * texture and writes it unmodified to the target. This is cheaper than
 * the tonemapping stage because it has no uniforms and a trivial
 * fragment shader. It exists as a fallback so the scene framebuffer
 * always reaches the canvas, even when every post-process effect is
 * disabled.
 */
export function createIdentityBlitPipeline(
  device: GPUDevice,
  targetFormat: GPUTextureFormat,
): { pipeline: GPURenderPipeline; bindGroupLayout: GPUBindGroupLayout } {
  const code = `
// Identity blit — fullscreen triangle, texture sample, NO color
// transform.
//
// The blit's inline pow(1/2.2) encode was reverted because it caused
// double-gamma encoding for the FOG /
// SkyAtmosphere / SkyBox / ground-atmosphere paths, which ALREADY
// apply pow(c, 1/2.2) inside the per-pixel shader (see e.g.
// GlobeTerrain.wgsl FOG branch line 2619, SkyAtmosphere.wgsl line 492,
// ModelPBRComplete.wgsl line 928). Fragments rendered through those
// paths got encoded twice → pow(c, 1/4.84) → washed-out / desaturated
// appearance characteristic of double-gamma encoding.
//
// Fragments rendered through paths that DON'T pre-encode (raw imagery
// at orbit altitudes outside the fog/atmosphere drape) stayed dark
// without the blit-side encode, producing the gamma-2.4-darker
// signature expected when the final encode is missing.
//
// The proper architectural fix is one of:
//   A. Make the canvas format bgra8unorm-srgb so the GPU ROP applies
//      the encode in hardware on every write. Requires bumping every
//      pipeline whose final target is the canvas (identity blit,
//      tonemap, color grading, FXAA, custom user stages) — multi-file
//      change.
//   B. Audit every render path and ensure EXACTLY ONE inline encode
//      between the imagery sampler and the canvas. Today fog/sky/PBR
//      have encodes; imagery/atmosphere-drape do not. Pick the
//      canonical layer (probably the final stage) and consolidate.
//
// Either option requires a coordinated color-space change across every
// canvas-writing pipeline; this identity blit therefore remains a no-op.
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle covering clip space (CCW winding):
  //   vertex 0 → (-1, -1)   vertex 1 → (3, -1)   vertex 2 → (-1, 3)
  var out: VsOut;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv  = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, uv);
}
`;

  const module = device.createShaderModule({
    label: "PostProcess-IdentityBlit-Shader",
    code,
  });

  const bindGroupLayout = makeBindGroupLayout(
    device,
    "PostProcess-IdentityBlit-BGL",
    [texture(0, Stage.FRAGMENT), sampler(1, Stage.FRAGMENT)],
  );

  const pipeline = device.createRenderPipeline({
    label: "PostProcess-IdentityBlit-Pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: { module, entryPoint: "vertexMain" },
    fragment: {
      module,
      entryPoint: "fragmentMain",
      targets: [{ format: targetFormat }],
    },
    primitive: { topology: "triangle-list" },
  });
  return { pipeline, bindGroupLayout };
}
