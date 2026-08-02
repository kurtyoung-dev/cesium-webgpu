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

/**
 * Describes the renderable 2D slices that belong to one logical texture.
 *
 * WebGPU render attachments target exactly one array layer. Cube and 2D-array
 * mip chains therefore use one 2D source/destination view per layer while a
 * normal 2D texture uses the default single layer.
 */
export interface WebGPUTextureMipGenerationOptions {
  dimension?: "2d" | "2d-array" | "cube";
  baseArrayLayer?: number;
  arrayLayerCount?: number;
}

// The blit shader samples through a filtering sampler and writes the next mip
// as a color attachment. Keep this list to formats that provide BOTH
// capabilities. Integer/depth/compressed formats, rgb9e5ufloat, and the other
// non-renderable formats must retain authored mip chains (or a single level)
// rather than entering this generator.
const CORE_FILTERABLE_COLOR_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "r8unorm",
  "rg8unorm",
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bgra8unorm",
  "bgra8unorm-srgb",
  "r16float",
  "rg16float",
  "rgba16float",
  "rgb10a2unorm",
]);

const TIER1_FILTERABLE_COLOR_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "r8snorm",
  "rg8snorm",
  "rgba8snorm",
  "r16unorm",
  "r16snorm",
  "rg16unorm",
  "rg16snorm",
  "rgba16unorm",
  "rgba16snorm",
]);

const CORE_COLOR_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "r8unorm",
  "r8uint",
  "r8sint",
  "r16uint",
  "r16sint",
  "r16float",
  "rg8unorm",
  "rg8uint",
  "rg8sint",
  "r32uint",
  "r32sint",
  "r32float",
  "rg16uint",
  "rg16sint",
  "rg16float",
  "rgba8unorm",
  "rgba8unorm-srgb",
  "rgba8uint",
  "rgba8sint",
  "bgra8unorm",
  "bgra8unorm-srgb",
  "rgb10a2uint",
  "rgb10a2unorm",
  "rg32uint",
  "rg32sint",
  "rg32float",
  "rgba16uint",
  "rgba16sint",
  "rgba16float",
  "rgba32uint",
  "rgba32sint",
  "rgba32float",
]);

const CORE_DEPTH_STENCIL_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "depth16unorm",
  "depth24plus",
  "depth24plus-stencil8",
  "depth32float",
  "stencil8",
]);

/** Whether a format can be used as a color render attachment on this device. */
export function supportsWebGPUColorRendering(
  device: GPUDevice,
  format: GPUTextureFormat,
): boolean {
  if (CORE_COLOR_RENDERABLE_FORMATS.has(format)) {
    return true;
  }
  if (
    TIER1_FILTERABLE_COLOR_RENDERABLE_FORMATS.has(format) &&
    device.features.has("texture-formats-tier1")
  ) {
    return true;
  }
  return (
    format === "rg11b10ufloat" &&
    device.features.has("rg11b10ufloat-renderable")
  );
}

/** Whether a format can be attached to a render pass on this device. */
export function supportsWebGPURenderAttachment(
  device: GPUDevice,
  format: GPUTextureFormat,
): boolean {
  if (
    supportsWebGPUColorRendering(device, format) ||
    CORE_DEPTH_STENCIL_RENDERABLE_FORMATS.has(format)
  ) {
    return true;
  }
  return (
    format === "depth32float-stencil8" &&
    device.features.has("depth32float-stencil8")
  );
}

/**
 * Compatibility adapters restrict texture-binding views to the full layer
 * range/fixed dimension. The current layered generator intentionally binds
 * one 2D slice per cube/array layer, so it requires core view semantics.
 */
export function supportsWebGPULayeredMipmapGeneration(
  device: GPUDevice,
): boolean {
  return device.features.has("core-features-and-limits" as GPUFeatureName);
}

/**
 * Whether this device can run the filtering color-blit mip generator for a
 * format. Float32 filtering and rg11b10 renderability are optional WebGPU
 * features, so their formats join the core set only on devices that expose the
 * corresponding capability.
 */
export function supportsWebGPUMipmapGeneration(
  device: GPUDevice,
  format: GPUTextureFormat,
): boolean {
  if (CORE_FILTERABLE_COLOR_RENDERABLE_FORMATS.has(format)) {
    return true;
  }
  if (
    TIER1_FILTERABLE_COLOR_RENDERABLE_FORMATS.has(format) &&
    device.features.has("texture-formats-tier1")
  ) {
    return true;
  }
  if (
    (format === "r32float" ||
      format === "rg32float" ||
      format === "rgba32float") &&
    device.features.has("float32-filterable")
  ) {
    return true;
  }
  return (
    format === "rg11b10ufloat" &&
    device.features.has("rg11b10ufloat-renderable")
  );
}

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
    options?: WebGPUTextureMipGenerationOptions,
  ): GPUCommandEncoder {
    if (this._isDestroyed) {
      throw new Error("WebGPUMipmapGenerator has been destroyed.");
    }
    if (mipLevelCount <= 1) {
      const encoder =
        commandEncoder ??
        this._device.createCommandEncoder({
          label: "MipmapGeneration_NoOp",
        });
      return encoder;
    }

    if (!supportsWebGPUMipmapGeneration(this._device, format)) {
      throw new Error(
        `WebGPU mip generation requires a filterable color-renderable format; received ${format}`,
      );
    }

    this._ensureInitialized();

    const pipeline = this._getPipeline(format);
    const encoder =
      commandEncoder ??
      this._device.createCommandEncoder({
        label: "MipmapGeneration",
      });

    const dimension = options?.dimension ?? "2d";
    const baseArrayLayer = Math.max(0, options?.baseArrayLayer ?? 0);
    const defaultLayerCount = dimension === "cube" ? 6 : 1;
    const arrayLayerCount = Math.max(
      1,
      options?.arrayLayerCount ?? defaultLayerCount,
    );

    for (let layerOffset = 0; layerOffset < arrayLayerCount; ++layerOffset) {
      const arrayLayer = baseArrayLayer + layerOffset;
      for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        // Cube-map faces deliberately bind as 2D slices because the blit
        // shader samples `texture_2d<f32>` and render attachments cannot target
        // a multi-layer cube view. These views/bind groups are intentionally
        // transient: streamed textures normally generate once, so retaining a
        // per-texture chain would turn one-shot encode objects into long-lived
        // residency with no cache hit.
        const srcView = texture.createView({
          dimension: "2d",
          baseMipLevel: mipLevel - 1,
          mipLevelCount: 1,
          baseArrayLayer: arrayLayer,
          arrayLayerCount: 1,
          label: `Mipmap_Src_Layer${arrayLayer}_Level${mipLevel - 1}`,
        });

        const bindGroup = this._device.createBindGroup({
          layout: this._bindGroupLayout!,
          entries: [
            { binding: 0, resource: this._sampler! },
            { binding: 1, resource: srcView },
          ],
          label: `Mipmap_BindGroup_Layer${arrayLayer}_Level${mipLevel}`,
        });

        // Destination views are transient write targets. Each view selects one
        // exact array layer even when the logical texture is a cube/array.
        const dstView = texture.createView({
          dimension: "2d",
          baseMipLevel: mipLevel,
          mipLevelCount: 1,
          baseArrayLayer: arrayLayer,
          arrayLayerCount: 1,
          label: `Mipmap_Dst_Layer${arrayLayer}_Level${mipLevel}`,
        });

        const passEncoder = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: dstView,
              loadOp: "clear" as GPULoadOp,
              storeOp: "store" as GPUStoreOp,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
          label: `Mipmap_RenderPass_Layer${arrayLayer}_Level${mipLevel}`,
        });

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(3); // Fullscreen triangle
        passEncoder.end();
      }
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
    options?: WebGPUTextureMipGenerationOptions,
  ): void {
    const encoder = this.generateMipmaps(
      texture,
      format,
      mipLevelCount,
      undefined,
      options,
    );
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
