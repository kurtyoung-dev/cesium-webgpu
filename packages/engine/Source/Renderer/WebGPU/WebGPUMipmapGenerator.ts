/**
 * Generates mipmaps for WebGPU textures using a blit-based render pass approach.
 * WebGPU has no equivalent to WebGL's gl.generateMipmap(), so mipmaps must be
 * generated manually by rendering a fullscreen triangle from each mip level to the next.
 *
 * The generator caches its shader module, sampler, and pipelines per texture format
 * so repeated mipmap generation is efficient.
 *
 * @example
 * const generator = new WebGPUMipmapGenerator(device);
 * generator.generateMipmaps(texture); // texture must have mipLevelCount > 1
 * generator.destroy(); // when done
 * @module WebGPUMipmapGenerator
 */

import {
  makeBindGroupLayout,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/// <reference types="@webgpu/types" />

// Inline the blit shader WGSL — avoids async fetch dependency for core infrastructure.
const MIPMAP_BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  output.texCoord = uv[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSample(srcTexture, srcSampler, texCoord);
}
`;

/**
 * Generates mipmaps for WebGPU textures via blit render passes.
 */
export class WebGPUMipmapGenerator {
  private _device: GPUDevice;
  private _shaderModule: GPUShaderModule | null = null;
  private _sampler: GPUSampler | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _pipelineCache: Map<GPUTextureFormat, GPURenderPipeline> = new Map();
  /**
   * Per-(texture, sourceMipLevel) bind-group cache. WeakMap entries auto-
   * release when the wrapped GPUTexture is garbage-collected, so callers
   * who repeatedly regenerate mipmaps for the same texture stop paying
   * the bind-group allocation cost on subsequent calls. Each call used to
   * create ~mipLevelCount-1 bind groups (11 for a 2048² texture); under
   * continuous KTX2 streaming this leaked tens of bind groups per upload.
   */
  private _bindGroupCache: WeakMap<GPUTexture, GPUBindGroup[]> = new WeakMap();
  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Lazily initializes shared GPU resources (shader, sampler, bind group layout).
   */
  private _ensureInitialized(): void {
    if (this._shaderModule) {
      return;
    }

    this._shaderModule = this._device.createShaderModule({
      code: MIPMAP_BLIT_WGSL,
      label: "MipmapBlit_ShaderModule",
    });

    this._sampler = this._device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      label: "MipmapBlit_Sampler",
    });

    this._bindGroupLayout = makeBindGroupLayout(
      this._device,
      "MipmapBlit_BindGroupLayout",
      [sampler(0, Stage.FRAGMENT), texture(1, Stage.FRAGMENT)],
    );
  }

  /**
   * Gets or creates a render pipeline for the given texture format.
   */
  private _getPipeline(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this._pipelineCache.get(format);
    if (pipeline) {
      return pipeline;
    }

    this._ensureInitialized();

    const pipelineLayout = this._device.createPipelineLayout({
      label: `MipmapBlit_PipelineLayout_${format}`,
      bindGroupLayouts: [this._bindGroupLayout!],
    });

    pipeline = this._device.createRenderPipeline({
      label: `MipmapBlit_Pipeline_${format}`,
      layout: pipelineLayout,
      vertex: {
        module: this._shaderModule!,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: this._shaderModule!,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    this._pipelineCache.set(format, pipeline);
    return pipeline;
  }

  /**
   * Generates mipmaps for a GPUTexture.
   *
   * The texture must have been created with:
   * - `mipLevelCount > 1`
   * - `TEXTURE_BINDING` usage (to read from mip levels)
   * - `RENDER_ATTACHMENT` usage (to write to mip levels)
   *
   * Mip level 0 must already contain the source image data.
   *
   * @param texture - The GPUTexture to generate mipmaps for
   * @param format - The texture format (e.g. 'rgba8unorm')
   * @param mipLevelCount - Total number of mip levels
   * @param commandEncoder - Optional existing command encoder to use
   * @returns The command encoder used (caller should submit if they provided one)
   */
  generateMipmaps(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    commandEncoder?: GPUCommandEncoder,
  ): GPUCommandEncoder {
    if (mipLevelCount <= 1) {
      const encoder =
        commandEncoder ??
        this._device.createCommandEncoder({
          label: "MipmapGeneration_NoOp",
        });
      return encoder;
    }

    this._ensureInitialized();

    const pipeline = this._getPipeline(format);
    const encoder =
      commandEncoder ??
      this._device.createCommandEncoder({
        label: "MipmapGeneration",
      });

    let cachedBindGroups = this._bindGroupCache.get(texture);
    if (!cachedBindGroups) {
      cachedBindGroups = new Array(mipLevelCount);
      this._bindGroupCache.set(texture, cachedBindGroups);
    }

    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
      // Reuse the bind group for this (texture, srcMip) pair when available.
      let bindGroup = cachedBindGroups[mipLevel];
      if (!bindGroup) {
        const srcView = texture.createView({
          baseMipLevel: mipLevel - 1,
          mipLevelCount: 1,
          label: `Mipmap_Src_Level${mipLevel - 1}`,
        });

        bindGroup = this._device.createBindGroup({
          layout: this._bindGroupLayout!,
          entries: [
            { binding: 0, resource: this._sampler! },
            { binding: 1, resource: srcView },
          ],
          label: `Mipmap_BindGroup_Level${mipLevel}`,
        });
        cachedBindGroups[mipLevel] = bindGroup;
      }

      // Destination view changes contents per call but is cheap; not worth
      // caching since it's the write target and only used once per pass.
      const dstView = texture.createView({
        baseMipLevel: mipLevel,
        mipLevelCount: 1,
        label: `Mipmap_Dst_Level${mipLevel}`,
      });

      // Render pass targeting the destination mip level
      const passEncoder = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: "clear" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        label: `Mipmap_RenderPass_Level${mipLevel}`,
      });

      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(3); // Fullscreen triangle
      passEncoder.end();
    }

    return encoder;
  }

  /**
   * Generates mipmaps and immediately submits the commands.
   * Convenience method for one-shot mipmap generation.
   */
  generateMipmapsAndSubmit(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
  ): void {
    const encoder = this.generateMipmaps(texture, format, mipLevelCount);
    this._device.queue.submit([encoder.finish()]);
  }

  /**
   * Calculates the number of mip levels for a given texture size.
   *
   * @param width - Texture width
   * @param height - Texture height
   * @returns Number of mip levels (minimum 1)
   */
  static calculateMipLevelCount(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
  }

  /**
   * Returns true if the generator has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroys cached GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }
    this._pipelineCache.clear();
    this._shaderModule = null;
    this._sampler = null;
    this._bindGroupLayout = null;
    this._isDestroyed = true;
  }
}

export default WebGPUMipmapGenerator;
