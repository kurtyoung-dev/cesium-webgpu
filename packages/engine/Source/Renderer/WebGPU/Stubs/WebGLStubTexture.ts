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

import type {
  StubGPUTexture,
  StubTextureDiagnostics,
  StubTextureRegistry,
  StubTextureWrapper,
  WebGLStubState,
  LogUsageFn,
} from "./WebGLStubTypes.js";
import {
  webglToWebGPUTextureFormat,
  webglFilterToWebGPU,
  webglMipmapFilterToWebGPU,
  webglWrapToWebGPU,
  bytesPerTexel,
} from "../WebGLStateConverters.js";

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

function getCompressedTextureFormat(
  internalformat: number,
): GPUTextureFormat | null {
  switch (internalformat) {
    case 0x83f0: // COMPRESSED_RGB_S3TC_DXT1_EXT
    case 0x83f1: // COMPRESSED_RGBA_S3TC_DXT1_EXT
      return "bc1-rgba-unorm";
    case 0x83f2: // COMPRESSED_RGBA_S3TC_DXT3_EXT
      return "bc2-rgba-unorm";
    case 0x83f3: // COMPRESSED_RGBA_S3TC_DXT5_EXT
      return "bc3-rgba-unorm";
    case 0x8e8c: // COMPRESSED_RGBA_BPTC_UNORM
      return "bc7-rgba-unorm";
    case 0x8e8d: // COMPRESSED_SRGB_ALPHA_BPTC_UNORM
      return "bc7-rgba-unorm-srgb";
    case 0x93b0: // COMPRESSED_RGBA_ASTC_4x4_WEBGL
      return "astc-4x4-unorm";
    case 0x9274: // COMPRESSED_RGB8_ETC2
      return "etc2-rgb8unorm";
    case 0x9278: // COMPRESSED_RGBA8_ETC2_EAC
      return "etc2-rgba8unorm";
    default:
      return null;
  }
}

function compressedBlockBytes(format: GPUTextureFormat): number {
  return format === "bc1-rgba-unorm" || format === "etc2-rgb8unorm" ? 8 : 16;
}

function compressedCopyLayout(
  width: number,
  height: number,
  format: GPUTextureFormat,
) {
  const blockColumns = Math.ceil(width / 4);
  const blockRows = Math.ceil(height / 4);
  return {
    bytesPerRow: blockColumns * compressedBlockBytes(format),
    // WebGPU expresses rowsPerImage for compressed copies in block rows.
    rowsPerImage: blockRows,
    // Tail mips still occupy one physical compression block. The copy extent
    // addresses that padded storage, not only the 1x1/2x2 logical texels.
    copyWidth: blockColumns * 4,
    copyHeight: blockRows * 4,
  };
}

function isCompressedTextureFormat(format: GPUTextureFormat): boolean {
  return (
    format.startsWith("bc") ||
    format.startsWith("astc-") ||
    format.startsWith("etc2-")
  );
}

function compressedTextureFeature(
  format: GPUTextureFormat,
): GPUFeatureName | null {
  if (format.startsWith("bc")) return "texture-compression-bc";
  if (format.startsWith("astc-")) return "texture-compression-astc";
  if (format.startsWith("etc2-")) return "texture-compression-etc2";
  return null;
}

/**
 * Internal wrapper for a stub-managed texture. Holds both the pending
 * sampler/filter state set via `texParameteri` and (once allocated) the
 * real GPU resources.
 */
interface TextureAllocation {
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipLevelCount: number;
  depthOrArrayLayers: number;
}

interface StubTexture extends StubTextureWrapper {
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
  readonly _webgpuTexture: StubGPUTexture | null;
  _getWebGPUTextureForDevice(
    device: GPUDevice,
    resourceGeneration: number,
  ): StubGPUTexture | null;
  _commitWebGPUTexture(
    device: GPUDevice,
    resourceGeneration: number,
    realization: StubGPUTexture,
  ): void;
  _setAllocation(allocation: TextureAllocation): void;
  _getAllocation(): TextureAllocation | null;
  _invalidateNative(): void;
  _destroyLogical(): void;
  _destroyed: boolean;
  _getDiagnostics(): {
    liveTexture: boolean;
  };
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

function createNativeTexture(
  device: GPUDevice,
  wrapper: StubTexture,
  allocation: TextureAllocation,
): StubGPUTexture {
  const { width, height, format, mipLevelCount, depthOrArrayLayers } =
    allocation;
  const texture = device.createTexture({
    label: wrapper._isCubeMap ? "GLStub_CubeMap" : "GLStub_Texture",
    size: { width, height, depthOrArrayLayers },
    format,
    mipLevelCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST |
      (isCompressedTextureFormat(format)
        ? 0
        : GPUTextureUsage.RENDER_ATTACHMENT),
    textureBindingViewDimension: wrapper._isCubeMap ? "cube" : "2d",
  } as GPUTextureDescriptor);

  try {
    const view = texture.createView({
      label: wrapper._isCubeMap ? "GLStub_CubeMapView" : "GLStub_TextureView",
      dimension: wrapper._isCubeMap ? "cube" : "2d",
    });
    const sampler = buildSampler(device, wrapper._samplerDesc);
    return {
      texture,
      view,
      sampler,
      width,
      height,
      format,
      mipLevelCount,
      depthOrArrayLayers,
      destroy() {
        texture.destroy();
      },
    };
  } catch (error) {
    // Texture creation is transactional: a failed view/sampler must not leak
    // the candidate or evict the previous generation's still-owned resource.
    try {
      texture.destroy();
    } catch {
      // Preserve the construction failure; the candidate was never published.
    }
    throw error;
  }
}

function runMipmapGeneration(
  state: WebGLStubState,
  realization: StubGPUTexture,
): boolean {
  if (realization.mipLevelCount <= 1) {
    return true;
  }
  // Texture uploads can finish while model commands are being prepared. Route
  // work through the context's frame-owned preparation queue so mip passes are
  // encoded once and submitted before the scene command buffer; never issue a
  // private queue.submit from the compatibility layer.
  return state.enqueueMipGeneration(
    realization.texture,
    realization.format,
    realization.mipLevelCount,
    mipGenerationOptionsFor(realization),
  );
}

function mipGenerationOptionsFor(realization: StubGPUTexture) {
  return {
    dimension: ((realization.depthOrArrayLayers ?? 1) === 6 ? "cube" : "2d") as
      "cube" | "2d",
    baseArrayLayer: 0,
    arrayLayerCount: realization.depthOrArrayLayers ?? 1,
  };
}

/**
 * A stable WebGL-shaped handle whose native realization is valid for exactly
 * one `(GPUDevice, resourceGeneration)` tuple. The compatibility layer never
 * retains decoded upload sources; recovery drops the stale native and leaves
 * re-creation to the higher-level resource owner.
 */

class GenerationSafeStubTexture implements StubTexture {
  _isPlaceholder = true;
  _samplerDesc = createPendingSamplerDesc();
  _isCubeMap = false;
  _destroyed = false;

  private _native: StubGPUTexture | null = null;
  private _nativeDevice: GPUDevice | null = null;
  private _nativeGeneration = -1;
  private _allocation: TextureAllocation | null = null;

  constructor(private readonly _state: WebGLStubState) {}

  get _webgpuTexture(): StubGPUTexture | null {
    const device = this._state.device;
    return device
      ? this._getWebGPUTextureForDevice(device, this._state.resourceGeneration)
      : null;
  }

  get _texture(): GPUTexture | null {
    return this._webgpuTexture?.texture ?? null;
  }

  _getWebGPUTextureForDevice(
    device: GPUDevice,
    resourceGeneration: number,
  ): StubGPUTexture | null {
    if (
      this._destroyed ||
      device !== this._state.device ||
      resourceGeneration !== this._state.resourceGeneration
    ) {
      return null;
    }
    if (
      this._native &&
      this._nativeDevice === device &&
      this._nativeGeneration === resourceGeneration
    ) {
      return this._native;
    }
    return null;
  }

  _commitWebGPUTexture(
    device: GPUDevice,
    resourceGeneration: number,
    realization: StubGPUTexture,
  ): void {
    const previous = this._native;
    this._native = realization;
    this._nativeDevice = device;
    this._nativeGeneration = resourceGeneration;
    if (previous && previous !== realization) {
      try {
        this._state.cancelMipGeneration(previous.texture);
      } catch {
        // Cancellation is bookkeeping-only. Still retire the old native below.
      }
      try {
        previous.destroy();
      } catch {
        // The replacement tuple is already authoritative. A synthetic/lost
        // old-native destroy failure must not prevent the caller from uploading
        // the new contents into that replacement.
      }
    }
  }

  _setAllocation(allocation: TextureAllocation): void {
    this._allocation = allocation;
  }

  _getAllocation(): TextureAllocation | null {
    return this._allocation;
  }

  _invalidateNative(): void {
    const native = this._native;
    this._native = null;
    this._nativeDevice = null;
    this._nativeGeneration = -1;
    if (native) {
      let cancellationError: unknown;
      try {
        this._state.cancelMipGeneration(native.texture);
      } catch (error) {
        cancellationError = error;
      }
      try {
        native.destroy();
      } catch (error) {
        throw cancellationError ?? error;
      }
      if (cancellationError !== undefined) {
        throw cancellationError;
      }
    }
  }

  _destroyLogical(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._allocation = null;
    this._invalidateNative();
  }

  _getDiagnostics() {
    return {
      liveTexture: this._native !== null,
    };
  }
}

type GenerationSafeTextureHandle = StubTextureWrapper & {
  _invalidateNative(): void;
  _destroyLogical(): void;
  _getDiagnostics(): {
    liveTexture: boolean;
  };
};

/** Context-local registry used by recovery and final context teardown. */
export class WebGLStubTextureRegistry implements StubTextureRegistry {
  private readonly _handles = new Set<StubTextureWrapper>();

  register(handle: StubTextureWrapper): void {
    this._handles.add(handle);
  }

  unregister(handle: StubTextureWrapper): void {
    this._handles.delete(handle);
  }

  invalidateDeviceGeneration(): void {
    let firstDestroyError: unknown;
    let hasDestroyError = false;
    for (const handle of this._handles) {
      try {
        (handle as GenerationSafeTextureHandle)._invalidateNative();
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    }
    if (hasDestroyError) {
      throw firstDestroyError;
    }
  }

  destroy(): void {
    const handles = Array.from(this._handles);
    this._handles.clear();
    let firstDestroyError: unknown;
    let hasDestroyError = false;
    for (const handle of handles) {
      try {
        (handle as GenerationSafeTextureHandle)._destroyLogical();
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    }
    if (hasDestroyError) {
      throw firstDestroyError;
    }
  }

  getDiagnostics(): StubTextureDiagnostics {
    let liveTextureCount = 0;
    for (const value of this._handles) {
      const diagnostics = (
        value as GenerationSafeTextureHandle
      )._getDiagnostics();
      if (diagnostics.liveTexture) liveTextureCount++;
    }
    return Object.freeze({
      registeredHandleCount: this._handles.size,
      liveTextureCount,
    });
  }
}

/**
 * Resolve a compatibility-stub texture for one exact ownership tuple.
 * Wrappers without generation-aware ownership metadata are rejected. Falling
 * back to a direct property could reuse a native from another device/epoch.
 */
export function getWebGPUTextureForDevice(
  wrapper: StubTextureWrapper | null | undefined,
  device: GPUDevice,
  resourceGeneration: number,
): StubGPUTexture | null {
  if (typeof wrapper?._getWebGPUTextureForDevice !== "function") return null;
  return wrapper._getWebGPUTextureForDevice(device, resourceGeneration);
}

/** Allocate or reuse the current tuple's native storage for texImage2D. */
function ensureTextureAllocated(
  state: WebGLStubState,
  wrapper: GenerationSafeStubTexture,
  width: number,
  height: number,
  format: GPUTextureFormat,
): StubGPUTexture {
  const device = state.device!;
  const layers = wrapper._isCubeMap ? 6 : 1;
  const allocation: TextureAllocation = {
    width,
    height,
    format,
    // Compatibility uploads may provide an authored chain one level at a
    // time (especially KTX2/block-compressed textures). Reserve that immutable
    // storage whenever the sampler requests mips even when the automatic
    // filtering blit cannot generate this format.
    mipLevelCount: wrapper._samplerDesc.wantsMipmaps
      ? mipLevelsFor(width, height)
      : 1,
    depthOrArrayLayers: layers,
  };
  const logical = wrapper._getAllocation();
  if (
    logical &&
    logical.width === width &&
    logical.height === height &&
    logical.format === format &&
    logical.depthOrArrayLayers === layers &&
    logical.mipLevelCount === allocation.mipLevelCount
  ) {
    const current = wrapper._getWebGPUTextureForDevice(
      device,
      state.resourceGeneration,
    );
    if (current) return current;
  }

  // Candidate construction completes before publication; the old native
  // owner remains intact if createTexture/createView/createSampler throws.
  const candidate = createNativeTexture(device, wrapper, allocation);
  wrapper._setAllocation(allocation);
  wrapper._commitWebGPUTexture(device, state.resourceGeneration, candidate);
  return candidate;
}

/**
 * Creates texture-related stub methods that perform real WebGL→WebGPU
 * translation rather than logging no-ops.
 */
export function createTextureStubs(
  state: WebGLStubState,
  logUsage: LogUsageFn,
) {
  // A framebuffer copy is a command-encoder operation, unlike queue.writeTexture
  // and copyExternalImageToTexture. Remember the exact encoder that recorded a
  // level-0 copy so a following generateMipmap can append its passes after the
  // copy in that encoder instead of incorrectly placing them in the earlier
  // frame-preparation submit. A later queue.writeTexture/external upload does
  // NOT clear this marker: queue operations execute before the eventual frame
  // command buffer regardless of JS call order, so the coherent realizable
  // order is queue upload -> recorded copy -> same-encoder mips. Exact WebGL
  // copy-then-upload ordering requires a future encoder-recorded upload path
  // or frame segmentation; moving mips back to prep would make base/tails
  // disagree in the current architecture.
  const commandEncodedBaseCopies = new WeakMap<GPUTexture, GPUCommandEncoder>();

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
      const texture = new GenerationSafeStubTexture(state);
      state.textureRegistry.register(texture);
      return texture;
    },

    deleteTexture: (texture: StubTexture | null) => {
      if (!texture) return;
      state.textureRegistry.unregister(texture);
      texture._destroyLogical();
    },

    /** Release every native handle from the invalid device generation. */
    invalidateCompatibilityTextureHandles: () => {
      const mipmapGenerator = state.mipmapGenerator;
      state.mipmapGenerator = null;
      let firstDestroyError: unknown;
      try {
        state.textureRegistry.invalidateDeviceGeneration();
      } catch (error) {
        firstDestroyError = error;
      }
      try {
        mipmapGenerator?.destroy?.();
      } catch (error) {
        firstDestroyError ??= error;
      }
      if (firstDestroyError !== undefined) {
        throw firstDestroyError;
      }
    },

    /** Final context teardown: release native handles and registry entries. */
    destroyCompatibilityTextureHandles: () => {
      state.textureBindings.clear();
      const mipmapGenerator = state.mipmapGenerator;
      state.mipmapGenerator = null;
      let firstDestroyError: unknown;
      try {
        state.textureRegistry.destroy();
      } catch (error) {
        firstDestroyError = error;
      }
      try {
        mipmapGenerator?.destroy?.();
      } catch (error) {
        firstDestroyError ??= error;
      }
      if (firstDestroyError !== undefined) {
        throw firstDestroyError;
      }
    },

    getCompatibilityTextureDiagnostics: (): StubTextureDiagnostics =>
      state.textureRegistry.getDiagnostics(),

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
      const wrapper = binding?.texture as StubTexture | undefined;
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
      const wrapper = binding?.texture as StubTexture | undefined;
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
        ensureTextureAllocated(
          state,
          wrapper as GenerationSafeStubTexture,
          width,
          height,
          gpuFormat,
        );
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
      const wrapper = binding?.texture as StubTexture | undefined;
      if (!wrapper || !state.device) return;
      const tex = wrapper._webgpuTexture;
      if (!tex) return;

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
      internalformat: number,
      width: number,
      height: number,
      _border: number,
      data: ArrayBufferView,
    ) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper = binding?.texture as StubTexture | undefined;
      if (!wrapper || !state.device) return;
      const gpuFormat = getCompressedTextureFormat(internalformat);
      if (!gpuFormat) {
        logUsage(
          "compressedTexImage2D",
          `unsupported compressed internal format 0x${internalformat.toString(16)}`,
        );
        return;
      }
      const requiredFeature = compressedTextureFeature(gpuFormat);
      if (!requiredFeature || !state.device.features.has(requiredFeature)) {
        logUsage(
          "compressedTexImage2D",
          `compressed format ${gpuFormat} requires ${requiredFeature ?? "an unsupported feature"}`,
        );
        return;
      }
      if (
        width <= 0 ||
        height <= 0 ||
        (level === 0 && (width % 4 !== 0 || height % 4 !== 0))
      ) {
        logUsage(
          "compressedTexImage2D",
          level === 0
            ? `compressed base dimensions ${width}x${height} must be positive 4x4-block multiples`
            : `compressed mip dimensions ${width}x${height} must be positive`,
        );
        return;
      }
      const requestedLayout = compressedCopyLayout(width, height, gpuFormat);
      if (
        data.byteLength <
        requestedLayout.bytesPerRow * requestedLayout.rowsPerImage
      ) {
        logUsage(
          "compressedTexImage2D",
          `compressed source is ${data.byteLength} bytes; ${requestedLayout.bytesPerRow * requestedLayout.rowsPerImage} required`,
        );
        return;
      }
      const cubeFace = cubeFaceLayerForTarget(_target);
      if (cubeFace !== null) wrapper._isCubeMap = true;
      if (level === 0) {
        ensureTextureAllocated(
          state,
          wrapper as GenerationSafeStubTexture,
          width,
          height,
          gpuFormat,
        );
      }
      const tex = wrapper._webgpuTexture;
      if (!tex || level < 0 || level >= tex.mipLevelCount) return;
      if (tex.format !== gpuFormat) {
        logUsage(
          "compressedTexImage2D",
          `compressed format ${gpuFormat} does not match allocated ${tex.format}`,
        );
        return;
      }
      // Cube-face layer for KTX2-compressed cubemaps (kiara HDR
      // environment map in `glTF PBR Extensions.html` and other IBL-
      // sourced demos).
      const mipWidth = Math.max(1, tex.width >> level);
      const mipHeight = Math.max(1, tex.height >> level);
      if (width !== mipWidth || height !== mipHeight) {
        logUsage(
          "compressedTexImage2D",
          `compressed mip ${level} must be ${mipWidth}x${mipHeight}, received ${width}x${height}`,
        );
        return;
      }
      const { bytesPerRow, rowsPerImage, copyWidth, copyHeight } =
        compressedCopyLayout(width, height, gpuFormat);
      state.device.queue.writeTexture(
        {
          texture: tex.texture,
          mipLevel: level,
          origin: { x: 0, y: 0, z: cubeFace ?? 0 },
        },
        data as BufferSource,
        { bytesPerRow, rowsPerImage },
        { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
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
      const wrapper = binding?.texture as StubTexture | undefined;
      if (!wrapper || !state.device) return;
      const tex = wrapper._webgpuTexture;
      if (!tex || level < 0 || level >= tex.mipLevelCount) return;
      const gpuFormat = getCompressedTextureFormat(_format);
      if (!gpuFormat || gpuFormat !== tex.format) {
        logUsage(
          "compressedTexSubImage2D",
          `compressed subimage format does not match allocated ${tex.format}`,
        );
        return;
      }
      const mipWidth = Math.max(1, tex.width >> level);
      const mipHeight = Math.max(1, tex.height >> level);
      if (
        xoffset < 0 ||
        yoffset < 0 ||
        xoffset % 4 !== 0 ||
        yoffset % 4 !== 0
      ) {
        logUsage(
          "compressedTexSubImage2D",
          `compressed origin (${xoffset}, ${yoffset}) must be non-negative and 4x4-block aligned`,
        );
        return;
      }
      if (
        width <= 0 ||
        height <= 0 ||
        xoffset + width > mipWidth ||
        yoffset + height > mipHeight ||
        (width % 4 !== 0 && xoffset + width !== mipWidth) ||
        (height % 4 !== 0 && yoffset + height !== mipHeight)
      ) {
        logUsage(
          "compressedTexSubImage2D",
          `compressed region ${width}x${height} at (${xoffset}, ${yoffset}) is outside or not block-complete for mip ${mipWidth}x${mipHeight}`,
        );
        return;
      }
      const cubeFace = cubeFaceLayerForTarget(_target);
      const { bytesPerRow, rowsPerImage, copyWidth, copyHeight } =
        compressedCopyLayout(width, height, tex.format);
      if (data.byteLength < bytesPerRow * rowsPerImage) {
        logUsage(
          "compressedTexSubImage2D",
          `compressed source is ${data.byteLength} bytes; ${bytesPerRow * rowsPerImage} required`,
        );
        return;
      }
      state.device.queue.writeTexture(
        {
          texture: tex.texture,
          mipLevel: level,
          origin: { x: xoffset, y: yoffset, z: cubeFace ?? 0 },
        },
        data as BufferSource,
        { bytesPerRow, rowsPerImage },
        { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 },
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
      const destinationTexture = binding.texture._webgpuTexture.texture;
      const encoder = state.currentCommandEncoder;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        const copied = state.copyTextureRegion(
          sourceTexture,
          destinationTexture,
          x,
          y,
          0,
          0,
          width,
          height,
        );
        if (copied && _level === 0) {
          commandEncodedBaseCopies.set(destinationTexture, encoder);
        } else if (!copied) {
          logUsage(
            "copyTexImage2D",
            "source/destination usages or formats are not copy-compatible",
          );
        }
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
      const destinationTexture = binding.texture._webgpuTexture.texture;
      const encoder = state.currentCommandEncoder;
      const sourceTexture =
        state.boundFramebuffer?.colorAttachment?._texture ||
        state.context?.getCurrentTexture();
      if (sourceTexture) {
        const copied = state.copyTextureRegion(
          sourceTexture,
          destinationTexture,
          x,
          y,
          xoffset,
          yoffset,
          width,
          height,
        );
        if (copied && _level === 0) {
          commandEncodedBaseCopies.set(destinationTexture, encoder);
        } else if (!copied) {
          logUsage(
            "copyTexSubImage2D",
            "source/destination usages or formats are not copy-compatible",
          );
        }
      }
    },

    /** Frame-owned `gl.generateMipmap()` preparation. */
    generateMipmap: (_target: number) => {
      const binding = state.textureBindings.get(state.activeTextureUnit);
      const wrapper = binding?.texture as StubTexture | undefined;
      if (!wrapper || !state.device) {
        logUsage(
          "generateMipmap",
          "no bound texture with allocated GPU resource",
        );
        return;
      }
      const tex = wrapper._webgpuTexture;
      if (!tex) {
        logUsage(
          "generateMipmap",
          "no bound texture with allocated GPU resource",
        );
        return;
      }
      if (isCompressedTextureFormat(tex.format)) {
        logUsage(
          "generateMipmap",
          "compressed textures require an authored mip chain",
        );
        return;
      }
      if (tex.mipLevelCount <= 1) {
        return;
      }
      const dependencyEncoder = commandEncodedBaseCopies.get(tex.texture);
      if (dependencyEncoder === state.currentCommandEncoder) {
        const accepted = state.encodeMipGenerationInCurrentEncoder(
          tex.texture,
          tex.format,
          tex.mipLevelCount,
          mipGenerationOptionsFor(tex),
        );
        if (accepted) {
          commandEncodedBaseCopies.delete(tex.texture);
        } else {
          logUsage(
            "generateMipmap",
            "could not encode mips after the current-encoder base-level copy",
          );
        }
        return;
      }
      if (dependencyEncoder) {
        // The encoder that carried the copy has already rotated/submitted (or
        // was abandoned). A later frame can safely use the normal preparation
        // queue; do not let the old encoder identity pin this texture there.
        commandEncodedBaseCopies.delete(tex.texture);
      }
      if (!runMipmapGeneration(state, tex)) {
        logUsage(
          "generateMipmap",
          `frame-owned mip generation rejected format ${tex.format}`,
        );
      }
    },

    hint: () => logUsage("hint", "Not applicable in WebGPU"),
  };
}
