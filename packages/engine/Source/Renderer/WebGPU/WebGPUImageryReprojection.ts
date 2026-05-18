/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  uniformBuffer as uniformBufferEntry,
  texture as textureEntry,
  sampler as samplerEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";

// Lazily-allocated mipmap generator, shared across reprojection calls
// on the same device. Allocated on first use so contexts that never
// reproject don't pay for it. The generator caches per-format pipelines
// internally.
let _reprojMipmapGenerator: WebGPUMipmapGenerator | null = null;
let _reprojMipmapGeneratorDevice: GPUDevice | null = null;
function ensureReprojectionMipmapGenerator(
  device: GPUDevice,
): WebGPUMipmapGenerator {
  if (
    _reprojMipmapGenerator !== null &&
    _reprojMipmapGeneratorDevice === device
  ) {
    return _reprojMipmapGenerator;
  }
  _reprojMipmapGenerator = new WebGPUMipmapGenerator(device);
  _reprojMipmapGeneratorDevice = device;
  return _reprojMipmapGenerator;
}

/**
 * WebGPU imagery reprojection — converts Web Mercator imagery tiles to
 * Geographic (equirectangular) projection via a render-to-texture pass.
 *
 * The WebGL path uses a 64-row vertex grid with pre-computed Mercator T values
 * and a GPGPU ComputeCommand. This WebGPU implementation uses a simpler
 * full-screen triangle with the Mercator math done in the fragment shader.
 *
 * Registered as a feature renderer (IMAGERY_REPROJECTION) so scene code
 * accesses it via `context.getFeatureRenderer(FeatureRendererKey.IMAGERY_REPROJECTION)`.
 *
 * @module WebGPUImageryReprojection
 * @private
 */

// Inline WGSL — avoids async shader loading for this critical-path utility.
// Must stay in sync with ReprojectWebMercator.wgsl.
const REPROJECT_WGSL = /* wgsl */ `
struct ReprojectUniforms {
  southLatitude: f32,
  northLatitude: f32,
  southMercatorY: f32,
  oneOverMercHeight: f32,
};

@group(0) @binding(0) var<uniform> u: ReprojectUniforms;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.texCoord = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let s = in.texCoord.x;
  let geographicFraction = 1.0 - in.texCoord.y;
  let latitude = u.southLatitude + geographicFraction * (u.northLatitude - u.southLatitude);
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
  let mercatorFraction = (mercatorY - u.southMercatorY) * u.oneOverMercHeight;
  let srcV = 1.0 - mercatorFraction;
  // Batch 56 — force alpha=1.0. The source imagery texture coming from
  // copyExternalImageToTexture on an opaque JPEG often arrives with
  // alpha=0 in WebGPU (the alpha channel isnt populated from non-alpha
  // source formats). Downstream globe-surface fragment shader multiplies
  // by tex.a in its effectiveAlpha chain, so alpha=0 made every
  // reprojected-imagery composite produce zero contribution -> black
  // tiles. Source imagery from the Mercator providers is always opaque
  // (Bing aerial JPEG, Esri WorldImagery JPEG, etc.), so forcing alpha=1
  // is safe here. If/when transparent imagery providers need support,
  // this needs to be conditional on the source format/provider.
  let sampled = textureSample(srcTexture, srcSampler, vec2<f32>(s, srcV));
  return vec4<f32>(sampled.rgb, 1.0);
}
`;

/** Cached pipeline + bind group layout — shared across all reprojection calls */
interface ReprojectCache {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
}

let _cache: ReprojectCache | null = null;
let _cacheDevice: GPUDevice | null = null;

/**
 * Returns the format string for the output texture. WebGPU imagery textures
 * are typically rgba8unorm.
 */
function getOutputFormat(): GPUTextureFormat {
  return "rgba8unorm";
}

function ensureCache(device: GPUDevice): ReprojectCache {
  // Invalidate cache if device changed (e.g., split-screen with separate contexts)
  if (_cache !== null && _cacheDevice === device) {
    return _cache;
  }
  if (_cache !== null) {
    _cache.uniformBuffer.destroy();
    _cache = null;
  }

  const shaderModule = device.createShaderModule({
    label: "ReprojectWebMercator",
    code: REPROJECT_WGSL,
  });

  const bindGroupLayout = makeBindGroupLayout(
    device,
    "ReprojectWebMercator BGL",
    [
      uniformBufferEntry(0, Stage.FRAGMENT),
      textureEntry(1, Stage.FRAGMENT),
      samplerEntry(2, Stage.FRAGMENT),
    ],
  );

  const pipelineLayout = device.createPipelineLayout({
    label: "ReprojectWebMercator PipelineLayout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    label: "ReprojectWebMercator Pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format: getOutputFormat() }],
    },
    primitive: {
      topology: "triangle-list",
    },
  });

  const sampler = device.createSampler({
    label: "ReprojectWebMercator Sampler",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // 16 bytes: 4 × f32
  const uniformBuffer = device.createBuffer({
    label: "ReprojectWebMercator Uniforms",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  _cache = { pipeline, bindGroupLayout, sampler, uniformBuffer };
  _cacheDevice = device;
  return _cache;
}

/**
 * Reprojects a Web Mercator GPUTexture to Geographic projection.
 *
 * @param device - The GPU device
 * @param sourceTexture - The Web Mercator source texture (GPUTexture)
 * @param width - Output texture width
 * @param height - Output texture height
 * @param southLatitude - South edge latitude in radians
 * @param northLatitude - North edge latitude in radians
 * @returns The reprojected GPUTexture in Geographic projection
 */
export function reprojectWebMercatorWebGPU(
  device: GPUDevice,
  sourceTexture: GPUTexture,
  width: number,
  height: number,
  southLatitude: number,
  northLatitude: number,
): GPUTexture {
  const cache = ensureCache(device);

  // Compute Mercator Y bounds
  const sinSouth = Math.sin(southLatitude);
  const southMercatorY = 0.5 * Math.log((1.0 + sinSouth) / (1.0 - sinSouth));
  const sinNorth = Math.sin(northLatitude);
  const northMercatorY = 0.5 * Math.log((1.0 + sinNorth) / (1.0 - sinNorth));
  const oneOverMercHeight = 1.0 / (northMercatorY - southMercatorY);

  // Write uniforms
  const uniformData = new Float32Array([
    southLatitude,
    northLatitude,
    southMercatorY,
    oneOverMercHeight,
  ]);
  device.queue.writeBuffer(cache.uniformBuffer, 0, uniformData);

  // Batch 57 — allocate output texture with full mipmap chain. The
  // reprojected texture feeds the globe-tile sampler at orbital altitudes
  // where one fragment can cover many texels; without mipmaps the
  // sampler point-samples Level-0 and produces severe aliasing + a
  // brightness drop (the alias pattern under-samples bright pixels).
  // Mirrors the equivalent fix in WebGPUGlobeSurfaceTextures.ts
  // (uploadImageSource). See `migration_doc/WEBGPU_DEBUGGING_LOG.md`
  // Batch 57.
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const outputTexture = device.createTexture({
    label: "ReprojectWebMercator Output",
    size: { width, height },
    format: getOutputFormat(),
    mipLevelCount,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });

  // Create source texture view
  const sourceView = sourceTexture.createView({
    label: "ReprojectWebMercator SourceView",
  });

  // Create bind group for this reprojection
  const bindGroup = device.createBindGroup({
    label: "ReprojectWebMercator BindGroup",
    layout: cache.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cache.uniformBuffer } },
      { binding: 1, resource: sourceView },
      { binding: 2, resource: cache.sampler },
    ],
  });

  // Execute render pass — target ONLY mip level 0; the rest of the chain
  // is filled in by `WebGPUMipmapGenerator.generateMipmapsAndSubmit`
  // below. Without `baseMipLevel: 0, mipLevelCount: 1` the view would
  // cover the whole chain, which the render attachment rejects.
  const outputView = outputTexture.createView({
    label: "ReprojectWebMercator OutputView",
    baseMipLevel: 0,
    mipLevelCount: 1,
  });

  const encoder = device.createCommandEncoder({
    label: "ReprojectWebMercator Encoder",
  });

  // BUG-11 hypothesis A defense: clear alpha to 1.0 (instead of 0.0) so
  // any unwritten texel — present today only via a future `discard` path,
  // but a footgun waiting to happen — does NOT collapse the downstream
  // composite to zero via `tex.a * effectiveAlpha`. The full-screen
  // triangle currently overwrites every texel, so this is a defensive
  // change with no behavior impact today.
  const pass = encoder.beginRenderPass({
    label: "ReprojectWebMercator RenderPass",
    colorAttachments: [
      {
        view: outputView,
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });

  pass.setPipeline(cache.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3); // Full-screen triangle
  pass.end();

  device.queue.submit([encoder.finish()]);

  // Batch 57 — fill mip levels 1..N from the freshly-rendered level 0.
  // Lazily instantiate the generator per device; it caches per-format
  // pipelines so repeated reprojection calls reuse the same shader.
  if (mipLevelCount > 1) {
    ensureReprojectionMipmapGenerator(device).generateMipmapsAndSubmit(
      outputTexture,
      getOutputFormat(),
      mipLevelCount,
    );
  }

  return outputTexture;
}

/**
 * Reprojects a Web Mercator image source (ImageBitmap, HTMLCanvasElement, etc.)
 * to Geographic projection. Handles the full pipeline: upload → reproject → return.
 *
 * The temporary source GPUTexture is destroyed after reprojection.
 *
 * @param device - The GPU device
 * @param imageSource - Source image (ImageBitmap, HTMLCanvasElement, HTMLImageElement)
 * @param width - Image width
 * @param height - Image height
 * @param southLatitude - South edge latitude in radians
 * @param northLatitude - North edge latitude in radians
 * @returns The reprojected GPUTexture in Geographic projection
 */
export function reprojectImageSourceWebGPU(
  device: GPUDevice,
  imageSource:
    | ImageBitmap
    | HTMLCanvasElement
    | HTMLImageElement
    | OffscreenCanvas,
  width: number,
  height: number,
  southLatitude: number,
  northLatitude: number,
): GPUTexture {
  // C-P18: HTMLImageElement sources must be fully decoded before WebGPU
  // can copy them. Without this guard, `copyExternalImageToTexture`
  // throws "source is not in a valid state" mid-reproject and the
  // fresh `srcTexture` leaks. Callers that pass a potentially-decoding
  // image should catch the error and retry on the next frame.
  if (
    typeof HTMLImageElement !== "undefined" &&
    imageSource instanceof HTMLImageElement
  ) {
    if (!imageSource.complete || imageSource.naturalWidth === 0) {
      throw new Error(
        "[CesiumJS:webgpu] reprojectImageSourceWebGPU: HTMLImageElement " +
          "is not fully decoded. Await img.decode() or img.complete === true " +
          "before handing the image off to the reproject pipeline.",
      );
    }
  }

  // Upload source image to a temporary GPUTexture
  const srcTexture = device.createTexture({
    label: "ReprojectWebMercator SrcUpload",
    size: { width, height },
    format: getOutputFormat(),
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: imageSource as ImageBitmap },
    { texture: srcTexture },
    { width, height },
  );

  // Run the reprojection render pass
  const result = reprojectWebMercatorWebGPU(
    device,
    srcTexture,
    width,
    height,
    southLatitude,
    northLatitude,
  );

  // Destroy the temporary source texture
  srcTexture.destroy();

  return result;
}

/**
 * Initialize the reprojection feature renderer.
 * Called from WebGPUFeatureRenderers registration.
 */
export function initWebGPUImageryReprojection(
  _context: CesiumGraphicsContext,
): void {
  // Cache is lazily initialized on first use — nothing to do here
}

/**
 * Destroy cached reprojection resources.
 */
export function destroyWebGPUImageryReprojectionResources(): void {
  if (_cache !== null) {
    _cache.uniformBuffer.destroy();
    _cache = null;
    _cacheDevice = null;
  }
}
