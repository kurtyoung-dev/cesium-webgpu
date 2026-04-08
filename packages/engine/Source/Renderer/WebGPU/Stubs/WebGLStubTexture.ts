/**
 * @module WebGLStubTexture
 *
 * **Proton-style WebGL→WebGPU texture translation.** Implements the full
 * `gl.createTexture / bindTexture / texImage2D / texParameteri /
 *  pixelStorei / generateMipmap` upload pipeline as real WebGPU operations
 * rather than no-ops, so legacy code paths that allocate textures via the
 * compatibility stub actually get a working `GPUTexture` + sampler pair.
 *
 * Lifecycle:
 *   1. `createTexture()` returns a wrapper holding pending state (no GPU
 *      resource yet — width/height/format are unknown until first upload).
 *   2. `texParameteri()` and `pixelStorei()` mutate the wrapper's pending
 *      sampler descriptor and pixel-store flags.
 *   3. `texImage2D()` is what actually creates the `GPUTexture`. It picks
 *      the format from the WebGL `internalformat`/`type` triple, allocates
 *      with `mipLevelCount = floor(log2(max(w,h)))+1` so a later
 *      `generateMipmap()` call has somewhere to write, and uploads the
 *      data via `device.queue.writeTexture()` or `copyExternalImageToTexture()`.
 *   4. `generateMipmap()` lazily instantiates `WebGPUMipmapGenerator` and
 *      dispatches a real blit-down render pass on the active command encoder.
 *   5. The wrapper exposes `_webgpuTexture` (with `.texture`, `.view`,
 *      `.sampler`) so any caller that pokes at the WebGPU side directly
 *      sees the real resource.
 *
 * @see WebGLCompatibilityStub
 * @see WebGPUMipmapGenerator
 */

/// <reference types="@webgpu/types" />

import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";
import {
  webglToWebGPUTextureFormat,
  webglFilterToWebGPU,
  webglMipmapFilterToWebGPU,
  webglWrapToWebGPU,
  bytesPerTexel,
} from "../WebGLStateConverters.js";
import { WebGPUMipmapGenerator } from "../WebGPUMipmapGenerator.js";

/**
 * WebGL texture-related constants.
 */
export const TEXTURE_CONSTANTS = Object.freeze({
  TEXTURE_2D: 0x0de1,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE0: 0x84c0,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  NONE: 0,
  BROWSER_DEFAULT_WEBGL: 0x9244,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_WRAP_R: 0x8072,
  GENERATE_MIPMAP_HINT: 0x8192,
});

const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_TEXTURE_WRAP_R = 0x8072;
const GL_UNPACK_FLIP_Y_WEBGL = 0x9240;
const GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
const GL_UNPACK_ALIGNMENT = 0x0cf5;

const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_LINEAR = 0x2601;

/**
 * Internal wrapper for a stub-managed texture. Holds both the pending
 * sampler/filter state set via `texParameteri` and (once allocated) the
 * real GPU resources.
 */
interface StubTexture {
  _isPlaceholder: boolean;
  // Pending sampler descriptor — fields are populated as texParameteri
  // calls come in. Used to build the GPUSampler when the texture is first
  // uploaded.
  _samplerDesc: {
    magFilter: GPUFilterMode;
    minFilter: GPUFilterMode;
    mipmapFilter: GPUMipmapFilterMode;
    addressModeU: GPUAddressMode;
    addressModeV: GPUAddressMode;
    addressModeW: GPUAddressMode;
    // Tracks whether the caller asked for mipmap-aware min filter. Used to
    // decide whether to allocate a full mip chain on first upload.
    wantsMipmaps: boolean;
  };
  // Allocated GPU resources — null until first texImage2D.
  _webgpuTexture: {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
    format: GPUTextureFormat;
    mipLevelCount: number;
    destroy(): void;
  } | null;
}

function createPendingSamplerDesc() {
  return {
    magFilter: "linear" as GPUFilterMode,
    minFilter: "linear" as GPUFilterMode,
    mipmapFilter: "linear" as GPUMipmapFilterMode,
    addressModeU: "clamp-to-edge" as GPUAddressMode,
    addressModeV: "clamp-to-edge" as GPUAddressMode,
    addressModeW: "clamp-to-edge" as GPUAddressMode,
    // Default to wantsMipmaps = true so the WebGL convention of "always
    // allocate a mip chain" is preserved on textures that never call
    // texParameteri (CesiumJS does this).
    wantsMipmaps: true,
  };
}

/** Returns the maximum mip level count for a (width, height) texture. */
function mipLevelsFor(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Build a `GPUSampler` from a wrapper's pending descriptor. Called once
 * per texture, the first time `texImage2D` allocates the GPU texture.
 */
function buildSampler(
  device: GPUDevice,
  desc: StubTexture["_samplerDesc"],
): GPUSampler {
  return device.createSampler({
    label: "GLStub_Sampler",
    magFilter: desc.magFilter,
    minFilter: desc.minFilter,
    mipmapFilter: desc.mipmapFilter,
    addressModeU: desc.addressModeU,
    addressModeV: desc.addressModeV,
    addressModeW: desc.addressModeW,
  });
}

/**
 * Flip a row-major RGBA byte array vertically in-place. Called when
 * `UNPACK_FLIP_Y_WEBGL` is set on the stub state — WebGPU has no
 * equivalent unpack flag, so the stub does the row reversal manually
 * before forwarding the data to `queue.writeTexture()`.
 *
 * @param rows  Number of rows
 * @param bytesPerRow  Stride in bytes
 * @param src  Source data (will NOT be mutated)
 * @returns  A new ArrayBuffer with rows reversed
 */
function flipYBuffer(
  rows: number,
  bytesPerRow: number,
  src: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < rows; y++) {
    const srcStart = y * bytesPerRow;
    const dstStart = (rows - 1 - y) * bytesPerRow;
    out.set(src.subarray(srcStart, srcStart + bytesPerRow), dstStart);
  }
  return out;
}

/**
 * Decide whether `pixels` is an HTMLImage/HTMLCanvas/HTMLVideo/ImageBitmap-like
 * object — these go through `copyExternalImageToTexture` rather than
 * `writeTexture`, which expects raw bytes.
 */
function isExternalImageSource(pixels: any): boolean {
  if (!pixels) return false;
  if (typeof ImageBitmap !== "undefined" && pixels instanceof ImageBitmap) {
    return true;
  }
  if (
    typeof HTMLImageElement !== "undefined" &&
    pixels instanceof HTMLImageElement
  ) {
    return true;
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    pixels instanceof HTMLCanvasElement
  ) {
    return true;
  }
  if (
    typeof HTMLVideoElement !== "undefined" &&
    pixels instanceof HTMLVideoElement
  ) {
    return true;
  }
  if (
    typeof OffscreenCanvas !== "undefined" &&
    pixels instanceof OffscreenCanvas
  ) {
    return true;
  }
  return false;
}

/**
 * Allocate a `GPUTexture` (+ view + sampler) and stash it on the wrapper.
 * Called the first time `texImage2D` sees a wrapper with `_webgpuTexture
 * === null`. Subsequent uploads with the same dimensions reuse the
 * existing texture; uploads with different dimensions destroy and
 * recreate it (mirroring WebGL's destructive `texImage2D` semantics).
 */
function ensureTextureAllocated(
  device: GPUDevice,
  wrapper: StubTexture,
  width: number,
  height: number,
  format: GPUTextureFormat,
): void {
  if (
    wrapper._webgpuTexture &&
    wrapper._webgpuTexture.width === width &&
    wrapper._webgpuTexture.height === height &&
    wrapper._webgpuTexture.format === format
  ) {
    return; // Reuse
  }
  if (wrapper._webgpuTexture) {
    wrapper._webgpuTexture.destroy();
  }

  // Allocate a full mip chain so generateMipmap can write into it later.
  // The blit-down generator needs RENDER_ATTACHMENT usage on every level.
  const mipLevelCount = wrapper._samplerDesc.wantsMipmaps
    ? mipLevelsFor(width, height)
    : 1;

  const texture = device.createTexture({
    label: "GLStub_Texture",
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const view = texture.createView({ label: "GLStub_TextureView" });
  const sampler = buildSampler(device, wrapper._samplerDesc);

  wrapper._webgpuTexture = {
    texture,
    view,
    sampler,
    width,
    height,
    format,
    mipLevelCount,
    destroy() {
      texture.destroy();
    },
  };
}

/**
 * Creates texture-related stub methods that perform real WebGL→WebGPU
 * translation rather than logging no-ops.
 */
export function createTextureStubs(
  state: WebGLStubState,
  logUsage: LogUsageFn,
): Record<string, any> {
  return {
    activeTexture: (unit: number) => {
      state.activeTextureUnit = unit - 0x84c0;
    },

    bindTexture: (target: number, texture: any) => {
      state.textureBindings.set(state.activeTextureUnit, { target, texture });
    },

    createTexture: (): StubTexture => {
      return {
        _isPlaceholder: true,
        _samplerDesc: createPendingSamplerDesc(),
        _webgpuTexture: null,
      };
    },

    deleteTexture: (texture: any) => {
      if (texture?._webgpuTexture?.destroy) {
        texture._webgpuTexture.destroy();
        texture._webgpuTexture = null;
      } else if (texture?.destroy) {
        texture.destroy();
      }
    },

    /**
     * `pixelStorei(pname, value)` — records the pixel-store flags so
     * `texImage2D` can correctly orient incoming row-major data. Only
     * the WebGL flags WebGPU has no native equivalent for are tracked;
     * UNPACK_ALIGNMENT is recorded but rarely matters because
     * `queue.writeTexture` takes its own `bytesPerRow`.
     */
    pixelStorei: (pname: number, value: number | boolean) => {
      switch (pname) {
        case GL_UNPACK_FLIP_Y_WEBGL:
          state.pixelStore.unpackFlipY = !!value;
          break;
        case GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL:
          state.pixelStore.unpackPremultiplyAlpha = !!value;
          break;
        case GL_UNPACK_ALIGNMENT:
          state.pixelStore.unpackAlignment =
            typeof value === "number" ? value : 4;
          break;
      }
    },

    /**
     * `texParameteri(target, pname, param)` — records sampler state on
     * the currently-bound texture wrapper so the GPUSampler built at
     * upload time matches the WebGL configuration.
     */
    texParameteri: (_target: number, pname: number, param: number) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper?._samplerDesc) return;
      const desc = wrapper._samplerDesc;
      switch (pname) {
        case GL_TEXTURE_MAG_FILTER:
          desc.magFilter = webglFilterToWebGPU(param);
          break;
        case GL_TEXTURE_MIN_FILTER:
          desc.minFilter = webglFilterToWebGPU(param);
          desc.mipmapFilter = webglMipmapFilterToWebGPU(param);
          // The WebGL convention "min filter mentions MIPMAP" → caller
          // wants a mip chain. Single-level filters (LINEAR / NEAREST)
          // imply they don't.
          desc.wantsMipmaps =
            param !== GL_LINEAR && param >= 0x2700 /* NEAREST_MIPMAP_NEAREST */;
          break;
        case GL_TEXTURE_WRAP_S:
          desc.addressModeU = webglWrapToWebGPU(param);
          break;
        case GL_TEXTURE_WRAP_T:
          desc.addressModeV = webglWrapToWebGPU(param);
          break;
        case GL_TEXTURE_WRAP_R:
          desc.addressModeW = webglWrapToWebGPU(param);
          break;
      }
    },

    /**
     * Translates `gl.texImage2D()` to a real WebGPU texture allocation +
     * upload. Supports the WebGL2 9-arg form `(target, level,
     * internalformat, width, height, border, format, type, pixels)` and
     * the legacy 6-arg form `(target, level, internalformat, format, type,
     * source)` where `source` is an HTMLImageElement / Canvas /
     * ImageBitmap / etc. — the dimensions are read off `source.width` /
     * `source.height` in the latter case.
     *
     * The wrapper's `_samplerDesc` is consulted to decide whether to
     * allocate a full mip chain. The format is selected from the
     * `internalformat` + `type` arguments via `webglToWebGPUTextureFormat`.
     */
    texImage2D: (
      _target: number,
      level: number,
      internalformat: number,
      widthOrFormat: number,
      heightOrType: number,
      borderOrSource: number | any,
      formatArg?: number,
      typeArg?: number,
      pixelsArg?: ArrayBufferView | any,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper || !state.device) return;

      // Disambiguate the two overloads based on argc.
      let width: number;
      let height: number;
      let format: number;
      let type: number;
      let pixels: any;
      if (typeof formatArg === "number" && typeof typeArg === "number") {
        // 9-arg form: (target, level, internalformat, width, height, border, format, type, pixels)
        width = widthOrFormat;
        height = heightOrType;
        format = formatArg;
        type = typeArg;
        pixels = pixelsArg ?? null;
      } else {
        // 6-arg form: (target, level, internalformat, format, type, source)
        format = widthOrFormat;
        type = heightOrType;
        pixels = borderOrSource;
        if (!pixels) return;
        width = pixels.width ?? pixels.videoWidth ?? 0;
        height = pixels.height ?? pixels.videoHeight ?? 0;
      }

      if (width <= 0 || height <= 0) return;

      const gpuFormat = webglToWebGPUTextureFormat(
        internalformat,
        format,
        type,
      );
      ensureTextureAllocated(state.device, wrapper, width, height, gpuFormat);
      const tex = wrapper._webgpuTexture!;

      if (!pixels) {
        // Empty texImage2D (caller will upload via texSubImage2D later).
        return;
      }

      if (isExternalImageSource(pixels)) {
        // HTMLImageElement / Canvas / ImageBitmap / Video / OffscreenCanvas:
        // route through copyExternalImageToTexture which handles colorspace
        // and the WebGPU equivalent of UNPACK_FLIP_Y via flipY.
        try {
          state.device.queue.copyExternalImageToTexture(
            { source: pixels, flipY: state.pixelStore.unpackFlipY },
            {
              texture: tex.texture,
              mipLevel: level,
              premultipliedAlpha: state.pixelStore.unpackPremultiplyAlpha,
            },
            { width, height, depthOrArrayLayers: 1 },
          );
        } catch (err) {
          // Some sources (CORS-tainted images, unloaded videos) cannot be
          // copied — fall back to a one-time warning instead of crashing.
          logUsage(
            "texImage2D",
            `copyExternalImageToTexture failed: ${(err as Error).message}`,
          );
        }
        return;
      }

      // Raw byte source — use queue.writeTexture.
      const bpt = bytesPerTexel(gpuFormat);
      const bytesPerRow = width * bpt;
      let data: Uint8Array;
      if (pixels instanceof Uint8Array) {
        data = pixels;
      } else if (pixels instanceof ArrayBuffer) {
        data = new Uint8Array(pixels);
      } else if (ArrayBuffer.isView(pixels)) {
        data = new Uint8Array(
          pixels.buffer,
          pixels.byteOffset,
          pixels.byteLength,
        );
      } else {
        return;
      }

      // WebGPU has no UNPACK_FLIP_Y for queue.writeTexture, so we flip
      // the rows manually when the flag is set.
      if (state.pixelStore.unpackFlipY) {
        data = flipYBuffer(height, bytesPerRow, data);
      }

      state.device.queue.writeTexture(
        { texture: tex.texture, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
        data,
        { bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    texSubImage2D: (
      _target: number,
      level: number,
      xoffset: number,
      yoffset: number,
      width: number,
      height: number,
      _format: number,
      _type: number,
      pixels: ArrayBufferView | null,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper?._webgpuTexture || !pixels || !state.device) return;
      const tex = wrapper._webgpuTexture;
      const bpt = bytesPerTexel(tex.format);
      const bytesPerRow = width * bpt;
      let data = new Uint8Array(
        (pixels as any).buffer ?? pixels,
        (pixels as any).byteOffset ?? 0,
        (pixels as any).byteLength ?? (pixels as any).length ?? 0,
      );
      if (state.pixelStore.unpackFlipY) {
        data = flipYBuffer(height, bytesPerRow, data);
      }
      state.device.queue.writeTexture(
        {
          texture: tex.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: 0 },
        },
        data,
        { bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    compressedTexImage2D: (
      _target: number,
      level: number,
      _internalformat: number,
      width: number,
      height: number,
      _border: number,
      data: ArrayBufferView,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.device) return;
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
        },
        data as BufferSource,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    compressedTexSubImage2D: (
      _target: number,
      level: number,
      xoffset: number,
      yoffset: number,
      width: number,
      height: number,
      _format: number,
      data: ArrayBufferView,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.device) return;
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: 0 },
        },
        data as BufferSource,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
    },

    copyTexImage2D: (
      _target: number,
      _level: number,
      _internalformat: number,
      x: number,
      y: number,
      width: number,
      height: number,
      _border: number,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.currentCommandEncoder)
        return;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        state.copyTextureRegion(
          sourceTexture,
          binding.texture._webgpuTexture.texture,
          x,
          y,
          0,
          0,
          width,
          height,
        );
      }
    },

    copyTexSubImage2D: (
      _target: number,
      _level: number,
      xoffset: number,
      yoffset: number,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      if (!binding?.texture?._webgpuTexture || !state.currentCommandEncoder)
        return;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        state.copyTextureRegion(
          sourceTexture,
          binding.texture._webgpuTexture.texture,
          x,
          y,
          xoffset,
          yoffset,
          width,
          height,
        );
      }
    },

    /**
     * Real `gl.generateMipmap()` — dispatches `WebGPUMipmapGenerator`
     * against the bound texture using the active command encoder. The
     * generator is lazily instantiated and cached on `state` so the cost
     * (shader module + sampler + bind group layout creation) is paid
     * once per device.
     *
     * Requires the texture to have been allocated with mipLevelCount > 1
     * and RENDER_ATTACHMENT usage — `ensureTextureAllocated` does both
     * automatically when the wrapper's `wantsMipmaps` flag is true.
     */
    generateMipmap: (_target: number) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper?._webgpuTexture || !state.device) {
        logUsage(
          "generateMipmap",
          "no bound texture with allocated GPU resource",
        );
        return;
      }
      const tex = wrapper._webgpuTexture;
      if (tex.mipLevelCount <= 1) {
        // Caller didn't request mipmaps via texParameteri — nothing to do.
        return;
      }

      // Lazy-create the generator on the first call. Stored on `state` so
      // it's reused for the lifetime of the WebGPU device.
      if (!state.mipmapGenerator) {
        state.mipmapGenerator = new WebGPUMipmapGenerator(state.device);
      }
      const gen: WebGPUMipmapGenerator = state.mipmapGenerator;

      // Reuse the active command encoder when one is open so the mipmap
      // blits are batched into the current frame; otherwise create a
      // standalone encoder + submit immediately.
      if (state.currentCommandEncoder) {
        gen.generateMipmaps(
          tex.texture,
          tex.format,
          tex.mipLevelCount,
          state.currentCommandEncoder,
        );
      } else {
        const encoder = gen.generateMipmaps(
          tex.texture,
          tex.format,
          tex.mipLevelCount,
        );
        state.device.queue.submit([encoder.finish()]);
      }
    },

    hint: () => logUsage("hint", "Not applicable in WebGPU"),
  };
}
