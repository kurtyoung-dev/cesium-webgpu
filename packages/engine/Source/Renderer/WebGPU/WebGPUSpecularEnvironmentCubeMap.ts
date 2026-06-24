/**
 * WebGPU producer for authored KTX2 specular environment cube maps.
 *
 * NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU (item 375).
 *
 * STATUS (Batch 371, C2-2): LIVE — wired from
 * `WebGPUImageBasedLighting.ensureWebGPUSpecularSource` now that C2-1
 * (NEW-WEBGPU-KTX2-TRANSCODER-FORMATS) lets `loadKTX2()` resolve on a
 * WebGPUContext. The upload is format-adaptive: it honors the KTX2's actual
 * datatype (UNSIGNED_BYTE → rgba8unorm 4 bpp, HALF_FLOAT → rgba16float 8 bpp,
 * FLOAT → rgba32float 16 bpp) and computes the writeTexture stride as w*bpp.
 *
 * The Scene-side `SpecularEnvironmentCubeMap` builds a WebGL `CubeMap` whose
 * texture never carries a `_webgpuTexture`, so on a WebGPU context the model
 * IBL consumer (`WebGPUImageBasedLighting` -> `generateIBLMaps`) always fell
 * back to the 1x1 black procedural placeholder. This module turns the loaded
 * KTX2 buffers into an on-device `rgba16float` cube `WebGPUTexture` and returns
 * a thin wrapper matching the field shape the consumer already reads:
 *   `specEnvMap._texture._webgpuTexture.view` -> the "cube" dimension view.
 *
 * We only upload the BASE mip (roughness 0) of the 6 faces. `generateIBLMaps`
 * re-prefilters irradiance + a 6-mip radiance chain on-device from that base
 * level, so the KTX2's pre-baked mip chain is not needed on the WebGPU path.
 *
 * Backend-neutral by construction (it only touches a GPUDevice it is handed),
 * but it is NOT consumable from a webgl-only build because it imports
 * WebGPUTexture. It is reached exclusively from the WebGPU IBL feature
 * renderer, so it is never pulled into the webgl-only bundle.
 *
 * @private
 */

import { WebGPUTexture } from "./WebGPUTexture.js";
import { cesiumFormatToWebGPU, bytesPerPixel } from "./WebGPUTexture3D.js";

// CubeMap face order matching CubeMap.FaceName / WebGL:
// 0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z
const FACE_KEYS = [
  "positiveX",
  "negativeX",
  "positiveY",
  "negativeY",
  "positiveZ",
  "negativeZ",
] as const;

// PixelFormat.RGBA / PixelDatatype constants (avoid importing the JS enums).
const PF_RGBA = 0x1908;
const PD_FLOAT = 0x1406;
const PD_HALF_FLOAT_OES = 0x140b;

interface KTX2FaceBuffer {
  width: number;
  height: number;
  arrayBufferView?: ArrayBufferView;
  pixelDatatype?: number;
}

type KTX2MipLevel = Partial<Record<(typeof FACE_KEYS)[number], KTX2FaceBuffer>>;

/**
 * Wrapper returned to the Scene-side SpecularEnvironmentCubeMap as its
 * `_texture`. The `_webgpuTexture.view` getter resolves to the cube view the
 * IBL consumer samples.
 */
export interface WebGPUSpecularCubeWrapper {
  _webgpuTexture: WebGPUTexture;
  maximumMipmapLevel: number;
  isDestroyed(): boolean;
  destroy(): void;
}

/**
 * Builds an rgba16float (or rgba32float) source cube from the loaded KTX2
 * buffers' base mip level. Returns null if the buffers are unusable (no base
 * face / missing arrayBufferView) so the caller keeps the procedural fallback.
 */
export function buildWebGPUSpecularCubeFromKTX2Buffers(
  device: GPUDevice,
  cubeMapBuffers: unknown,
): WebGPUSpecularCubeWrapper | null {
  if (!Array.isArray(cubeMapBuffers) || cubeMapBuffers.length === 0) {
    return null;
  }

  const baseMip = cubeMapBuffers[0] as KTX2MipLevel;
  const baseFace = baseMip?.positiveX;
  if (!baseFace || !baseFace.arrayBufferView) {
    // Either no base face or it's a compressed/GPU-only payload we can't
    // re-upload byte-wise; keep the procedural fallback.
    return null;
  }

  const size = baseFace.width;
  if (!size || size <= 0) {
    return null;
  }

  // Respect the KTX2's ACTUAL pixel datatype — IBL env maps ship as UNSIGNED_BYTE
  // (rgba8unorm, e.g. the kiara sample), HALF_FLOAT, or FLOAT. Only fall back to
  // half-float when the buffer carried no datatype at all (matches
  // SpecularEnvironmentCubeMap.js's undefined-datatype convention). The earlier
  // "force half-float unless float" branch corrupted RGBA8 maps: it built an
  // rgba16float (8 bpp) cube but the face buffer is a 4 bpp Uint8Array, so the
  // writeTexture stride (w*bpp) overran the source rows.
  let pixelDatatype = baseFace.pixelDatatype;
  if (pixelDatatype === undefined || pixelDatatype === null) {
    pixelDatatype = PD_HALF_FLOAT_OES;
  }

  const format = cesiumFormatToWebGPU(PF_RGBA, pixelDatatype);
  const bpp = bytesPerPixel(format);

  // 6-layer 2D cube, single mip (generateIBLMaps regenerates the radiance
  // mip chain on-device).
  const cube = WebGPUTexture.createCubeMap(
    device,
    size,
    format,
    1,
    `SpecularEnvCube-${size}`,
  );
  const gpuTexture = cube.texture;

  for (let face = 0; face < 6; face++) {
    const faceBuf = baseMip[FACE_KEYS[face]];
    const view = faceBuf?.arrayBufferView;
    if (!view) {
      // Missing face -> abandon; partial cube would alias garbage.
      cube.destroy();
      return null;
    }
    const w = faceBuf.width;
    const h = faceBuf.height;

    device.queue.writeTexture(
      {
        texture: gpuTexture,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: face },
      },
      view,
      {
        // CRITICAL: rgba16float is 8 bytes/pixel — WebGPUTexture.write()
        // hardcodes *4 and would corrupt this. Compute the real stride.
        bytesPerRow: w * bpp,
        rowsPerImage: h,
      },
      {
        width: w,
        height: h,
      },
    );
  }

  // The KTX2 max mip level (informational; the consumer overrides
  // _webgpuMaxMipLevel with RADIANCE_MIP_LEVELS-1 after the on-device
  // prefilter runs).
  const maximumMipmapLevel = cubeMapBuffers.length - 1;

  let destroyed = false;
  return {
    _webgpuTexture: cube,
    maximumMipmapLevel,
    isDestroyed(): boolean {
      return destroyed;
    },
    destroy(): void {
      if (!destroyed) {
        cube.destroy();
        destroyed = true;
      }
    },
  };
}

export default buildWebGPUSpecularCubeFromKTX2Buffers;
