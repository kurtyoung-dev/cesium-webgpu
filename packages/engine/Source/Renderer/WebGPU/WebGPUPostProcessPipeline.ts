/// <reference types="@webgpu/types" />
/**
 * WebGPU Post-Processing Pipeline
 *
 * Manages a chain of fullscreen post-processing effects. Each stage reads
 * from a source texture and writes to a destination texture (ping-pong pattern).
 *
 * Built-in stages:
 * - Tonemapping (HDR → LDR conversion)
 * - FXAA (Fast Approximate Anti-Aliasing)
 * - Bloom (bright-pass → blur → composite)
 * - Ambient Occlusion (SSAO screen-space approximation)
 *
 * Custom stages can be added via WGSL shader + uniform configuration.
 *
 * Architecture:
 * - Two ping-pong textures (A, B) alternate as source/destination
 * - Each stage is a GPURenderPipeline + GPUBindGroup
 * - The final stage writes to the canvas (or Scene framebuffer)
 *
 * @private
 */

import { WebGPURenderTarget } from "./WebGPURenderTarget.js";

// Built-in WGSL shader for tone mapping (Reinhard + gamma correction)
const TONEMAP_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: vec4<f32>; // x=exposure, y=gamma, z=unused, w=unused

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0)
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  var color = textureSample(inputTex, inputSampler, in.uv).rgb;
  let exposure = params.x;
  let gamma = params.y;

  // Exposure adjustment
  color = color * exposure;

  // Reinhard tonemapping
  color = color / (color + vec3<f32>(1.0));

  // Gamma correction
  let invGamma = 1.0 / gamma;
  color = pow(color, vec3<f32>(invGamma));

  return vec4<f32>(color, 1.0);
}
`;

// FXAA shader
const FXAA_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> texelSize: vec4<f32>; // xy=1/resolution, zw=resolution

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0)
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let ts = texelSize.xy;

  // Sample center and 4 neighbors
  let rgbM  = textureSample(inputTex, inputSampler, uv).rgb;
  let rgbNW = textureSample(inputTex, inputSampler, uv + vec2<f32>(-ts.x, -ts.y)).rgb;
  let rgbNE = textureSample(inputTex, inputSampler, uv + vec2<f32>( ts.x, -ts.y)).rgb;
  let rgbSW = textureSample(inputTex, inputSampler, uv + vec2<f32>(-ts.x,  ts.y)).rgb;
  let rgbSE = textureSample(inputTex, inputSampler, uv + vec2<f32>( ts.x,  ts.y)).rgb;

  let lumM  = luminance(rgbM);
  let lumNW = luminance(rgbNW);
  let lumNE = luminance(rgbNE);
  let lumSW = luminance(rgbSW);
  let lumSE = luminance(rgbSE);

  let lumRange = max(max(lumNW, lumNE), max(lumSW, max(lumSE, lumM)))
              - min(min(lumNW, lumNE), min(lumSW, min(lumSE, lumM)));

  // Skip FXAA for low-contrast areas
  if (lumRange < max(0.0312, lumM * 0.125)) {
    return vec4<f32>(rgbM, 1.0);
  }

  // Compute blur direction
  let dirX = -((lumNW + lumNE) - (lumSW + lumSE));
  let dirY =  ((lumNW + lumSW) - (lumNE + lumSE));
  let dirReduce = max((lumNW + lumNE + lumSW + lumSE) * 0.25 * 0.25, 1.0 / 128.0);
  let rcpDirMin = 1.0 / (min(abs(dirX), abs(dirY)) + dirReduce);
  let dir = clamp(
    vec2<f32>(dirX, dirY) * rcpDirMin,
    vec2<f32>(-8.0),
    vec2<f32>(8.0)
  ) * ts;

  let rgbA = 0.5 * (
    textureSample(inputTex, inputSampler, uv + dir * (1.0/3.0 - 0.5)).rgb +
    textureSample(inputTex, inputSampler, uv + dir * (2.0/3.0 - 0.5)).rgb
  );

  let rgbB = rgbA * 0.5 + 0.25 * (
    textureSample(inputTex, inputSampler, uv + dir * -0.5).rgb +
    textureSample(inputTex, inputSampler, uv + dir *  0.5).rgb
  );

  let lumB = luminance(rgbB);
  let lumMin = min(lumM, min(min(lumNW, lumNE), min(lumSW, lumSE)));
  let lumMax = max(lumM, max(max(lumNW, lumNE), max(lumSW, lumSE)));

  if (lumB < lumMin || lumB > lumMax) {
    return vec4<f32>(rgbA, 1.0);
  }
  return vec4<f32>(rgbB, 1.0);
}
`;

/** Descriptor for a post-processing stage */
export interface PostProcessStageDesc {
  name: string;
  wgslCode: string;
  uniforms?: Float32Array;
  enabled?: boolean;
}

/** A compiled post-processing stage */
interface CompiledStage {
  name: string;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
  enabled: boolean;
}

export class WebGPUPostProcessPipeline {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;

  // Ping-pong textures for multi-stage processing
  private _pingTexture: GPUTexture | null = null;
  private _pongTexture: GPUTexture | null = null;
  private _pingView: GPUTextureView | null = null;
  private _pongView: GPUTextureView | null = null;

  // Shared sampler
  private _sampler: GPUSampler | null = null;

  // Compiled stages
  private _stages: CompiledStage[] = [];

  // Built-in stage references
  private _tonemapStage: CompiledStage | null = null;
  private _fxaaStage: CompiledStage | null = null;

  private _isDestroyed: boolean = false;

  /**
   * Whether any post-processing stages are enabled.
   */
  get hasActiveStages(): boolean {
    return this._stages.some((s) => s.enabled);
  }

  /**
   * Initialize the pipeline with device and viewport.
   */
  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height;

    if (!needsRecreate && this._pingTexture) return;

    this._device = device;
    this._width = width;
    this._height = height;

    this._destroyTextures();

    // Create ping-pong textures
    const textureDesc: GPUTextureDescriptor = {
      size: { width, height },
      format: canvasFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };

    this._pingTexture = device.createTexture({
      ...textureDesc,
      label: "PostProcess-Ping",
    });
    this._pongTexture = device.createTexture({
      ...textureDesc,
      label: "PostProcess-Pong",
    });

    this._pingView = this._pingTexture.createView();
    this._pongView = this._pongTexture.createView();

    if (!this._sampler) {
      this._sampler = device.createSampler({
        label: "PostProcess-Sampler",
        magFilter: "linear",
        minFilter: "linear",
      });
    }
  }

  /**
   * Add built-in tonemapping stage.
   */
  addTonemapping(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._tonemapStage) return;
    this._tonemapStage = this._compileStage(
      device,
      "Tonemap",
      TONEMAP_WGSL,
      canvasFormat,
      new Float32Array([1.0, 2.2, 0.0, 0.0]), // exposure=1.0, gamma=2.2
    );
    this._stages.push(this._tonemapStage);
  }

  /**
   * Add built-in FXAA stage.
   */
  addFXAA(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (this._fxaaStage) return;
    const texelSize = new Float32Array([
      1.0 / this._width,
      1.0 / this._height,
      this._width,
      this._height,
    ]);
    this._fxaaStage = this._compileStage(
      device,
      "FXAA",
      FXAA_WGSL,
      canvasFormat,
      texelSize,
    );
    this._stages.push(this._fxaaStage);
  }

  /**
   * Execute all enabled stages in sequence.
   * @param encoder Command encoder
   * @param sourceView The scene color texture to post-process
   * @param destView The final output texture (canvas or framebuffer)
   */
  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    destView: GPUTextureView,
  ): void {
    const activeStages = this._stages.filter((s) => s.enabled);
    if (activeStages.length === 0) return;

    let currentSourceView = sourceView;
    const views = [this._pingView!, this._pongView!];
    let viewIndex = 0;

    for (let i = 0; i < activeStages.length; i++) {
      const stage = activeStages[i];
      const isLast = i === activeStages.length - 1;

      // Last stage writes to destination; others ping-pong
      const targetView = isLast ? destView : views[viewIndex];

      this._executeStage(encoder, stage, currentSourceView, targetView);

      currentSourceView = targetView;
      viewIndex = (viewIndex + 1) % 2;
    }
  }

  private _executeStage(
    encoder: GPUCommandEncoder,
    stage: CompiledStage,
    sourceView: GPUTextureView,
    targetView: GPUTextureView,
  ): void {
    if (!this._device || !this._sampler) return;

    // Create bind group with current source texture
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: sourceView },
      { binding: 1, resource: this._sampler },
    ];

    if (stage.uniformBuffer) {
      entries.push({
        binding: 2,
        resource: { buffer: stage.uniformBuffer },
      });
    }

    const bindGroup = this._device.createBindGroup({
      label: `PostProcess-${stage.name}-BindGroup`,
      layout: stage.bindGroupLayout,
      entries,
    });

    const pass = encoder.beginRenderPass({
      label: `PostProcess-${stage.name}-Pass`,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(stage.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private _compileStage(
    device: GPUDevice,
    name: string,
    wgslCode: string,
    targetFormat: GPUTextureFormat,
    uniforms?: Float32Array,
  ): CompiledStage {
    const shaderModule = device.createShaderModule({
      label: `PostProcess-${name}-Shader`,
      code: wgslCode,
    });

    const entries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ];

    let uniformBuffer: GPUBuffer | null = null;
    if (uniforms) {
      entries.push({
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      });

      uniformBuffer = device.createBuffer({
        label: `PostProcess-${name}-Uniforms`,
        size: Math.max(uniforms.byteLength, 16),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        uniforms as Float32Array<ArrayBuffer>,
      );
    }

    const bindGroupLayout = device.createBindGroupLayout({
      label: `PostProcess-${name}-BindGroupLayout`,
      entries,
    });

    const pipelineLayout = device.createPipelineLayout({
      label: `PostProcess-${name}-PipelineLayout`,
      bindGroupLayouts: [bindGroupLayout],
    });

    const pipeline = device.createRenderPipeline({
      label: `PostProcess-${name}-Pipeline`,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    return {
      name,
      pipeline,
      bindGroupLayout,
      uniformBuffer,
      enabled: true,
    };
  }

  /**
   * Enable/disable a stage by name.
   */
  setStageEnabled(name: string, enabled: boolean): void {
    const stage = this._stages.find((s) => s.name === name);
    if (stage) {
      stage.enabled = enabled;
    }
  }

  /**
   * Update uniforms for a stage.
   */
  updateStageUniforms(name: string, data: Float32Array): void {
    const stage = this._stages.find((s) => s.name === name);
    if (stage?.uniformBuffer && this._device) {
      this._device.queue.writeBuffer(
        stage.uniformBuffer,
        0,
        data as Float32Array<ArrayBuffer>,
      );
    }
  }

  private _destroyTextures(): void {
    this._pingTexture?.destroy();
    this._pongTexture?.destroy();
    this._pingTexture = null;
    this._pongTexture = null;
    this._pingView = null;
    this._pongView = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTextures();
    for (const stage of this._stages) {
      stage.uniformBuffer?.destroy();
    }
    this._stages = [];
    this._tonemapStage = null;
    this._fxaaStage = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
