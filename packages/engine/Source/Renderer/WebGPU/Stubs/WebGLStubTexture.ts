/**
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
 * @module WebGLStubTexture
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
 * Union of pixel source types that can be passed to `texImage2D` /
 * `texSubImage2D`.  Covers raw byte views, image elements, canvas,
 * video, and ImageBitmap.
 */
type TexImagePixelSource =
  | ArrayBufferView
  | ArrayBuffer
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas
  | ImageData;

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
  // uploaded. Optional because StubTextureWrapper (from which StubTexture
  // is assigned) declares it as optional.
  _samplerDesc?: {
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
  // Cubemap flag — set the first time `bindTexture` sees `TEXTURE_CUBE_MAP`
  // (or `texImage2D` sees a `TEXTURE_CUBE_MAP_POSITIVE_*` / NEGATIVE_*
  // face target). Drives `ensureTextureAllocated` to allocate a 6-layer
  // texture with a cube view and routes face uploads into the matching
  // layer index. Session 65 Batch 6 (2026-05-12) — added to fix the
  // `SpecularEnvironmentCubeMap` path (KTX2 PBR environment loading);
  // pre-fix every cube-face upload overwrote a single 2D layer, leaving
  // `model._imageBasedLighting._webgpuSpecularView` either undefined or
  // wrong, which made every PBR demo with explicit IBL render very dim
  // on WebGPU.
  _isCubeMap?: boolean;
  // Allocated GPU resources — null until first texImage2D.
  _webgpuTexture: {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
    format: GPUTextureFormat;
    mipLevelCount: number;
    // Optional — only present on cubemap allocations (set to 6) or
    // future array-texture allocations. Defaults to 1 (2D) when absent
    // so the existing 2D-texture call sites stay source-compatible.
    depthOrArrayLayers?: number;
    destroy(): void;
  } | null;
  destroy?(): void;
}

// WebGL cube-face target enums, mapping to WebGPU array layer index.
const GL_TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
// Each subsequent face is +1: NEGATIVE_X = 0x8516, POSITIVE_Y = 0x8517,
// NEGATIVE_Y = 0x8518, POSITIVE_Z = 0x8519, NEGATIVE_Z = 0x851a.
const GL_TEXTURE_CUBE_MAP_NEGATIVE_Z = 0x851a;

function cubeFaceLayerForTarget(target: number): number | null {
  if (
    target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X &&
    target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z
  ) {
    return target - GL_TEXTURE_CUBE_MAP_POSITIVE_X;
  }
  return null;
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
function isExternalImageSource(
  pixels: TexImagePixelSource | null | undefined,
): boolean {
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
  const layers = wrapper._isCubeMap ? 6 : 1;
  if (
    wrapper._webgpuTexture &&
    wrapper._webgpuTexture.width === width &&
    wrapper._webgpuTexture.height === height &&
    wrapper._webgpuTexture.format === format &&
    (wrapper._webgpuTexture.depthOrArrayLayers ?? 1) === layers
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
    label: wrapper._isCubeMap ? "GLStub_CubeMap" : "GLStub_Texture",
    size: { width, height, depthOrArrayLayers: layers },
    format,
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Cube-view binding requires `dimension: "cube"` so the shader's
  // `texture_cube<f32>` declarations work. The downstream IBL pipeline
  // also reads this view for irradiance/radiance prefilter sourcing.
  const view = texture.createView({
    label: wrapper._isCubeMap ? "GLStub_CubeMapView" : "GLStub_TextureView",
    dimension: wrapper._isCubeMap ? "cube" : "2d",
  });
  const sampler = buildSampler(device, wrapper._samplerDesc);

  wrapper._webgpuTexture = {
    texture,
    view,
    sampler,
    width,
    height,
    format,
    mipLevelCount,
    depthOrArrayLayers: layers,
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
) {
  return {
    activeTexture: (unit: number) => {
      state.activeTextureUnit = unit - 0x84c0;
    },

    bindTexture: (target: number, texture: StubTexture | null) => {
      state.textureBindings.set(state.activeTextureUnit, { target, texture });
      // Latch cubemap flag on the wrapper the first time we see the
      // texture bound as `TEXTURE_CUBE_MAP`. This lets
      // `ensureTextureAllocated` pick a 6-layer texture + cube view
      // BEFORE the first face upload arrives (face uploads use
      // `TEXTURE_CUBE_MAP_POSITIVE_X` etc. as the target, not the
      // cube-map enum). Without this latch, the first face upload
      // races the layer-count decision and creates a 1-layer 2D
      // texture, then subsequent face uploads silently overwrite it.
      if (texture && target === 0x8513 /* TEXTURE_CUBE_MAP */) {
        texture._isCubeMap = true;
      }
    },

    createTexture: (): StubTexture => {
      return {
        _isPlaceholder: true,
        _samplerDesc: createPendingSamplerDesc(),
        _webgpuTexture: null,
      };
    },

    deleteTexture: (texture: StubTexture | null) => {
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
            param !== GL_LINEAR && param >= 0x2700; /* NEAREST_MIPMAP_NEAREST */
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
      borderOrSource: number | TexImagePixelSource,
      formatArg?: number,
      typeArg?: number,
      pixelsArg?: TexImagePixelSource | null,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper || !state.device) return;

      // Disambiguate the two overloads based on argc.
      let width: number;
      let height: number;
      let format: number;
      let type: number;
      let pixels: TexImagePixelSource | null;
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
        pixels = borderOrSource as TexImagePixelSource;
        if (!pixels) return;
        const imgSrc = pixels as {
          width?: number;
          height?: number;
          videoWidth?: number;
          videoHeight?: number;
        };
        width = imgSrc.width ?? imgSrc.videoWidth ?? 0;
        height = imgSrc.height ?? imgSrc.videoHeight ?? 0;
      }

      if (width <= 0 || height <= 0) return;

      const gpuFormat = webglToWebGPUTextureFormat(
        internalformat,
        format,
        type,
      );

      // Cube face target detection. CubeMap.js binds the underlying
      // texture as `TEXTURE_CUBE_MAP` then issues per-face uploads
      // with the face-specific target enum (POSITIVE_X = 0x8515, etc).
      // The face index becomes the WebGPU `origin.z` for the upload.
      const faceLayer = cubeFaceLayerForTarget(_target);
      if (faceLayer !== null) {
        // Per-face upload — promote wrapper to cubemap so
        // `ensureTextureAllocated` picks a 6-layer texture even when
        // `bindTexture(TEXTURE_CUBE_MAP, …)` was missed (some
        // resource-cache paths bind the face target directly).
        wrapper._isCubeMap = true;
      }

      // Only resize the underlying GPU texture from the BASE level upload.
      // Higher-level uploads (mip > 0) target an existing allocation; if we
      // re-ran ensureTextureAllocated for mip=N with the level-N dimensions,
      // we'd shrink the texture (mipLevelCount = log2(N) + 1) and destroy
      // every other mip uploaded so far. The Cesium OSM Buildings demo hits
      // this — its imagery layer uploads level 0 (256x256 → mipLevelCount 9)
      // then walks levels 1..8 with their downscaled sizes. Without the
      // guard, the level-7 upload destroys + recreates a 2x2/2-level
      // texture, then level-8 fails with "MipLevel (8) > number of mip
      // levels (1)".
      if (level === 0 || !wrapper._webgpuTexture) {
        ensureTextureAllocated(state.device, wrapper, width, height, gpuFormat);
      }
      const tex = wrapper._webgpuTexture!;
      // Skip uploads that target a level beyond what we allocated. WebGL
      // would silently no-op too; without this guard the warning channel
      // gets spammed every frame on imagery-tile-heavy scenes.
      if (level >= tex.mipLevelCount) return;

      if (!pixels) {
        // Empty texImage2D (caller will upload via texSubImage2D later).
        return;
      }

      // For cube-face uploads, the target layer index drives `origin.z`.
      // For 2D uploads the origin defaults to 0.
      const originZ = faceLayer ?? 0;

      if (isExternalImageSource(pixels)) {
        // HTMLImageElement / Canvas / ImageBitmap / Video / OffscreenCanvas:
        // route through copyExternalImageToTexture which handles colorspace
        // and the WebGPU equivalent of UNPACK_FLIP_Y via flipY.
        try {
          state.device.queue.copyExternalImageToTexture(
            {
              source: pixels as ImageBitmap,
              flipY: state.pixelStore.unpackFlipY,
            },
            {
              texture: tex.texture,
              mipLevel: level,
              origin: { x: 0, y: 0, z: originZ },
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

      // WebGPU validates that the copy extent fits the destination MIP
      // level's dimensions. Some legacy WebGL callers (notably the I3S
      // 1×N color-ramp uploads + OSM-buildings imagery layers) pass the
      // BASE-level dimensions even when uploading mip > 0, on the
      // assumption the GL driver will silently clamp. Doing the same
      // in the stub would surface as "Texture copy range touches outside
      // of [Texture GLStub_Texture] mip level N size" warnings every
      // frame and the upload silently no-ops. Clamp the copy extent to
      // the actual mip-level size so the upload still lands (truncating
      // the source data is safer than failing the whole frame).
      let copyW = width;
      let copyH = height;
      if (level > 0) {
        const mipW = Math.max(1, tex.width >> level);
        const mipH = Math.max(1, tex.height >> level);
        if (copyW > mipW) copyW = mipW;
        if (copyH > mipH) copyH = mipH;
      }

      state.device.queue.writeTexture(
        {
          texture: tex.texture,
          mipLevel: level,
          origin: { x: 0, y: 0, z: originZ },
        },
        data,
        { bytesPerRow, rowsPerImage: height },
        { width: copyW, height: copyH, depthOrArrayLayers: 1 },
      );
    },

    texSubImage2D: (
      _target: number,
      level: number,
      xoffset: number,
      yoffset: number,
      widthOrFormat: number,
      heightOrType: number,
      formatOrSource: number | TexImagePixelSource,
      typeArg?: number,
      pixelsArg?: ArrayBufferView | null,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper: StubTexture | undefined = binding?.texture;
      if (!wrapper?._webgpuTexture || !state.device) return;
      const tex = wrapper._webgpuTexture;

      // Cube face index for the upload's `origin.z`. Matches the
      // mapping in `texImage2D` above — POSITIVE_X (0x8515) is layer 0,
      // NEGATIVE_X is 1, POSITIVE_Y is 2, etc. For non-cube uploads
      // this stays at 0. Session 65 Batch 6 (2026-05-12) — fixes
      // mip-level uploads on prefiltered specular cubemaps, which
      // arrive via `texSubImage2D(POSITIVE_X, mipLevel, …)`.
      const faceLayer = cubeFaceLayerForTarget(_target);
      const originZ = faceLayer ?? 0;

      // WebGL has TWO calling forms:
      //   9-arg: (target, level, xoffset, yoffset, width, height, format, type, pixels)
      //          where pixels is ArrayBufferView | null
      //   7-arg: (target, level, xoffset, yoffset, format, type, source)
      //          where source is HTMLImageElement / Canvas / ImageBitmap / Video
      // The previous stub only handled the 9-arg form, so glTF model
      // texture uploads (which use the 7-arg form with ImageBitmap)
      // silently no-op'd. Symptom: every glTF / 3D Tiles texture
      // rendered with the white-fallback default — the entire
      // "Mars/Moon white sphere" + "BIM building white walls" cluster
      // (Session 65 NEW-VR2-2). Detect the form by checking whether
      // typeArg is a number (9-arg) or undefined (7-arg).
      const isNineArg = typeof typeArg === "number";
      let width: number;
      let height: number;
      let pixels: TexImagePixelSource | ArrayBufferView | null;
      if (isNineArg) {
        width = widthOrFormat;
        height = heightOrType;
        pixels = pixelsArg ?? null;
      } else {
        // 7-arg form — formatOrSource IS the source
        const src = formatOrSource as TexImagePixelSource;
        if (!src) return;
        const sized = src as {
          width?: number;
          height?: number;
          videoWidth?: number;
          videoHeight?: number;
        };
        width = sized.width ?? sized.videoWidth ?? 0;
        height = sized.height ?? sized.videoHeight ?? 0;
        pixels = src;
      }
      if (!pixels || width <= 0 || height <= 0) return;

      // Clamp to mip-level extent (see paired comment in texImage2D above —
      // legacy GL callers pass base-level dimensions even at level > 0).
      let copyW = width;
      let copyH = height;
      if (level > 0) {
        const mipW = Math.max(1, tex.width >> level);
        const mipH = Math.max(1, tex.height >> level);
        if (xoffset + copyW > mipW) copyW = Math.max(0, mipW - xoffset);
        if (yoffset + copyH > mipH) copyH = Math.max(0, mipH - yoffset);
        if (copyW <= 0 || copyH <= 0) return;
      }

      // External image source (HTMLImageElement, ImageBitmap, etc.)
      // → route through copyExternalImageToTexture, which handles
      // colorspace + flipY semantics natively.
      if (isExternalImageSource(pixels)) {
        try {
          state.device.queue.copyExternalImageToTexture(
            {
              source: pixels as ImageBitmap,
              flipY: state.pixelStore.unpackFlipY,
            },
            {
              texture: tex.texture,
              mipLevel: level,
              origin: { x: xoffset, y: yoffset, z: originZ },
              premultipliedAlpha: state.pixelStore.unpackPremultiplyAlpha,
            },
            { width: copyW, height: copyH, depthOrArrayLayers: 1 },
          );
        } catch (err) {
          logUsage(
            "texSubImage2D",
            `copyExternalImageToTexture failed: ${(err as Error).message}`,
          );
        }
        return;
      }

      // Raw byte source — use queue.writeTexture (the original code path).
      const view = pixels as ArrayBufferView;
      const bpt = bytesPerTexel(tex.format);
      const bytesPerRow = width * bpt;
      const rawBuffer =
        view.buffer instanceof ArrayBuffer
          ? view.buffer
          : new Uint8Array(view.buffer).buffer;
      let data = new Uint8Array(
        rawBuffer,
        view.byteOffset ?? 0,
        view.byteLength ?? 0,
      );
      if (state.pixelStore.unpackFlipY) {
        data = flipYBuffer(height, bytesPerRow, data);
      }
      state.device.queue.writeTexture(
        {
          texture: tex.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: originZ },
        },
        data,
        { bytesPerRow, rowsPerImage: height },
        { width: copyW, height: copyH, depthOrArrayLayers: 1 },
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
      // Cube-face layer for KTX2-compressed cubemaps (kiara HDR
      // environment map in `glTF PBR Extensions.html` and other IBL-
      // sourced demos).
      const cubeFace = cubeFaceLayerForTarget(_target);
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
          origin: { x: 0, y: 0, z: cubeFace ?? 0 },
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
      const cubeFace = cubeFaceLayerForTarget(_target);
      state.device.queue.writeTexture(
        {
          texture: binding.texture._webgpuTexture.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: cubeFace ?? 0 },
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
      // WebGPUMipmapGenerator structurally satisfies StubMipmapGenerator
      // (same `generateMipmaps` signature) so no cast is required.
      if (!state.mipmapGenerator) {
        state.mipmapGenerator = new WebGPUMipmapGenerator(state.device);
      }
      const gen = state.mipmapGenerator;

      // Batch 144 — ALWAYS use a standalone encoder. The pre-Batch-144
      // path tried to reuse `state.currentCommandEncoder` "to batch the
      // mipmap blits into the current frame", but generateMipmaps calls
      // `encoder.beginRenderPass(...)` per mip level. When the
      // SceneRenderer's canvas render pass is already open on the same
      // encoder (which is true for the entire body of `scene.render()`),
      // beginning a new render pass on that encoder is invalid and
      // triggers:
      //   "Recording in [CommandEncoder ...] which is locked while
      //    [RenderPassEncoder "Scene Main Render Pass"] is open."
      //
      // Surfaced as the CesiumMan startup race in Batch 141 — texture
      // loads happening mid-frame via JobScheduler trigger
      // `gltfTextureLoader.process → Texture.generateMipmap → this
      // stub`. The race was masked in steady state because most frames
      // have no pending texture loads to process.
      //
      // The "batching" optimization saved one queue.submit per
      // generateMipmap call, but mipmap generation is dozens of
      // draws — the submit cost is negligible by comparison.
      const encoder = gen.generateMipmaps(
        tex.texture,
        tex.format,
        tex.mipLevelCount,
      );
      state.device.queue.submit([encoder.finish()]);
    },

    hint: () => logUsage("hint", "Not applicable in WebGPU"),
  };
}
