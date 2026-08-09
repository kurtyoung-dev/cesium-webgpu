/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  uniformBuffer as uniformBufferEntry,
  texture as textureEntry,
  sampler as samplerEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
// The shader's single source is
// `packages/engine/Source/Shaders/WebGPU/ReprojectWebMercator.wgsl`; the gulp
// build emits a `.js` wrapper exporting it as a default string. Importing that
// wrapper keeps this file from carrying a second copy of the WGSL, which can
// drift from the `.wgsl` the GLSL pair is kept in lockstep with.
import ReprojectWebMercatorWGSL from "../../Shaders/WebGPU/ReprojectWebMercator.js";

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
    code: ReprojectWebMercatorWGSL,
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

  // Allocate the output with a full mipmap chain. The reprojected texture
  // feeds the globe-tile sampler at orbital altitudes where one fragment can
  // cover many texels; with only level 0 present the sampler point-samples it
  // and produces severe aliasing plus a brightness drop, because the alias
  // pattern under-samples bright pixels. `uploadImageSource` in
  // WebGPUGlobeSurfaceTextures.ts allocates its chain for the same reason.
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

  // Alpha clears to 1.0 rather than 0.0 so an unwritten texel cannot collapse
  // the downstream composite to zero through `tex.a * effectiveAlpha`. The
  // full-screen triangle covers every texel, so this only becomes load-bearing
  // if a `discard` path is ever added to the fragment shader.
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

  // Fill mip levels 1..N from the freshly-rendered level 0. The generator is
  // instantiated lazily per device and caches per-format pipelines, so
  // repeated reprojection calls reuse the same shader.
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
    ImageBitmap | HTMLCanvasElement | HTMLImageElement | OffscreenCanvas,
  width: number,
  height: number,
  southLatitude: number,
  northLatitude: number,
): GPUTexture {
  // HTMLImageElement sources must be fully decoded before WebGPU can copy
  // them. Without this guard, `copyExternalImageToTexture` throws "source is
  // not in a valid state" mid-reproject and the fresh `srcTexture` leaks.
  // Callers that pass a potentially-decoding image should catch the error and
  // retry on the next frame.
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
 * Dual-texture upload for Mercator imagery providers.
 *
 * Uploads the source image to a Mercator-projection GPUTexture with a full
 * mipmap chain, so it is directly bindable by the globe-tile pipeline for
 * tiles whose `useWebMercatorT === true`, then reprojects from that texture
 * to a Geographic-projection GPUTexture that also carries a full mip chain.
 *
 * The returned pair lets the renderer pick the projection that matches each
 * tile's `tileImagery.useWebMercatorT` flag, mirroring WebGL's
 * `imagery.textureWebMercator` / `imagery.texture` dual-texture architecture.
 *
 * Both textures are owned by the caller; both must be destroyed when the
 * imagery is evicted (or when the renderer is torn down).
 *
 * @returns `{ mercator, reprojected }` — both GPUTextures, with full mip
 *          chains. `mercator` is sampleable at Mercator-V coordinates; the
 *          reproject pass runs against it and then immediately consumes it
 *          as input — destruction is the caller's responsibility.
 */
export function uploadAndReprojectMercatorImage(
  device: GPUDevice,
  imageSource:
    ImageBitmap | HTMLCanvasElement | HTMLImageElement | OffscreenCanvas,
  width: number,
  height: number,
  southLatitude: number,
  northLatitude: number,
): { mercator: GPUTexture; reprojected: GPUTexture } {
  if (
    typeof HTMLImageElement !== "undefined" &&
    imageSource instanceof HTMLImageElement
  ) {
    if (!imageSource.complete || imageSource.naturalWidth === 0) {
      throw new Error(
        "[CesiumJS:webgpu] uploadAndReprojectMercatorImage: HTMLImageElement " +
          "is not fully decoded. Await img.decode() or img.complete === true " +
          "before handing the image off to the reproject pipeline.",
      );
    }
  }

  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;

  // Mercator source — retained as the bindable texture for any tile whose
  // skeleton was created with `useWebMercatorT === true` (the common case
  // for mid-latitude tiles served by Bing / Esri / other Mercator
  // providers). Full mip chain so orbital-altitude sampling doesn't
  // alias level 0.
  const mercator = device.createTexture({
    label: "ImageryMercatorSource",
    size: { width, height },
    format: getOutputFormat(),
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT |
      // COPY_SRC for diagnostic readback (probe-source-mercator-compare).
      // No runtime cost when not exercised; adds the spec-required flag
      // for `copyTextureToBuffer` so the source pixels can be inspected.
      GPUTextureUsage.COPY_SRC,
  });

  device.queue.copyExternalImageToTexture(
    { source: imageSource as ImageBitmap },
    { texture: mercator, colorSpace: "srgb" },
    { width, height },
  );

  if (mipLevelCount > 1) {
    ensureReprojectionMipmapGenerator(device).generateMipmapsAndSubmit(
      mercator,
      getOutputFormat(),
      mipLevelCount,
    );
  }

  // Reproject from the Mercator texture into a Geographic-projection
  // output. `reprojectWebMercatorWebGPU` allocates the destination
  // texture with its own mip chain.
  const reprojected = reprojectWebMercatorWebGPU(
    device,
    mercator,
    width,
    height,
    southLatitude,
    northLatitude,
  );

  return { mercator, reprojected };
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
