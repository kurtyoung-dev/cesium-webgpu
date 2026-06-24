/**
 * WebGPU producer for authored KTX2 specular environment cube maps.
 *
 * NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU (item 375).
 *
 * STATUS (Batch 369): SCAFFOLDING — intentionally uncalled. This producer is
 * verified-correct (builds clean, the rgba16float 8-bpp face upload is right),
 * but the FR wiring that calls it was REVERTED because authored KTX2 IBL on
 * WebGPU is blocked one level deeper: `loadKTX2()` throws "supportedTargetFormats
 * is required" on a WebGPUContext (the KTX2 transcoder's GPU-format registration,
 * done during WebGL Context init, is never set up for WebGPU). Re-wire this from
 * `WebGPUImageBasedLighting.ensureWebGPUSpecularSource` once
 * NEW-WEBGPU-KTX2-TRANSCODER-FORMATS lands. See DEFERRED_WORK.md. Do NOT delete
 * as "dead code" — it is the ready-to-wire half of a documented two-part fix.
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

  // Datatype is defined when KTX2 carried a normalized float type; otherwise
  // default to half-float (matches SpecularEnvironmentCubeMap.js convention).
  let pixelDatatype = baseFace.pixelDatatype;
  if (pixelDatatype !== PD_FLOAT && pixelDatatype !== PD_HALF_FLOAT_OES) {
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
