/**
 * @module WebGPUPrimitiveIndexUtils
 *
 * WGF-6 helper — `@builtin(primitive_index)` capability detection and
 * pipeline-augmentation utilities.
 *
 * `@builtin(primitive_index)` is a WGSL fragment-shader builtin that gives the
 * triangle index (0..N-1) of the rasterized primitive within the current draw
 * call. It enables wireframe overlays, per-face debug coloring, and per-
 * triangle picking *without* a geometry shader and without a separate pick
 * framebuffer pass.
 *
 * WebGL has no equivalent — `gl_PrimitiveID` exists only in geometry shaders,
 * which WebGL doesn't expose. So this is a WebGPU-only capability.
 *
 * Companion WGSL chunk: `Shaders/WebGPU/chunks/functions/csm_primitiveIndex.wgsl`
 * provides `csm_debugFaceColor`, `csm_encodePrimitiveIndex`, and
 * `csm_isWireframeEdge` helpers.
 *
 * @example
 * if (WebGPUPrimitiveIndexUtils.isSupported(device)) {
 *   const wireframeFS = WebGPUPrimitiveIndexUtils.generateWireframeOverlayWGSL();
 *   // Plug into a debug post-process or as a fragment variant on terrain.
 * }
 */

/// <reference types="@webgpu/types" />

/**
 * Utilities for the WebGPU `@builtin(primitive_index)` fragment input.
 */
export class WebGPUPrimitiveIndexUtils {
  /**
   * `primitive_index` is a core WGSL builtin in the current spec — no feature
   * flag is needed on a compliant WebGPU implementation. This getter exists
   * so callers can centralize feature gating in case a driver fails to
   * compile shaders that use it (older Intel/Mali drivers have been flaky).
   *
   * Performs a tiny one-shot test compile and caches the result per device.
   */
  static isSupported(device: GPUDevice): boolean {
    const cached = WebGPUPrimitiveIndexUtils._supportCache.get(device);
    if (cached !== undefined) {
      return cached;
    }
    let supported = true;
    try {
      const probe = `
        @vertex fn vs() -> @builtin(position) vec4<f32> {
          return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
        @fragment fn fs(@builtin(primitive_index) p: u32)
            -> @location(0) vec4<f32> {
          return vec4<f32>(f32(p & 1u), 0.0, 0.0, 1.0);
        }
      `;
      device.pushErrorScope("validation");
      device.createShaderModule({
        label: "PrimitiveIndex support probe",
        code: probe,
      });
      // Drain the error scope synchronously (best-effort — if it queues, the
      // failure will surface in console; we still cache true here).
      device.popErrorScope().then((err) => {
        if (err) {
          WebGPUPrimitiveIndexUtils._supportCache.set(device, false);
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[WebGPUPrimitiveIndexUtils] @builtin(primitive_index) probe failed: ${err.message}`,
          );
          //>>includeEnd('debug');
        }
      });
    } catch (e) {
      supported = false;
    }
    WebGPUPrimitiveIndexUtils._supportCache.set(device, supported);
    return supported;
  }

  /**
   * Generates a fragment shader that draws each triangle in a deterministic
   * distinct color, useful for visually inspecting tile triangulation,
   * polygon earcut output, or model mesh structure.
   *
   * The shader expects `@builtin(position)` to be the only other vertex-stage
   * varying — combine with any vertex shader that emits clip-space positions.
   */
  static generateFaceColorWGSL(): string {
    return `
@fragment
fn fragmentMain(@builtin(primitive_index) primIndex: u32)
    -> @location(0) vec4<f32> {
  let r = f32((primIndex * 73u) & 255u) / 255.0;
  let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;
  let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
`.trim();
  }

  /**
   * Generates a fragment shader that encodes the triangle index as a 32-bit
   * RGBA8 color, suitable for readback through a pick framebuffer to perform
   * per-triangle picking without a separate pick render pass.
   */
  static generatePrimitivePickWGSL(): string {
    return `
@fragment
fn fragmentMain(@builtin(primitive_index) primIndex: u32)
    -> @location(0) vec4<f32> {
  let r = f32((primIndex >>  0u) & 255u) / 255.0;
  let g = f32((primIndex >>  8u) & 255u) / 255.0;
  let b = f32((primIndex >> 16u) & 255u) / 255.0;
  let a = f32((primIndex >> 24u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, a);
}
`.trim();
  }

  /**
   * Decodes the RGBA8 color produced by `generatePrimitivePickWGSL()` back
   * into a triangle index. Use after `device.queue.copyTextureToBuffer` +
   * mapAsync.
   */
  static decodePrimitivePick(rgba: Uint8Array, offset: number = 0): number {
    return (
      rgba[offset] |
      (rgba[offset + 1] << 8) |
      (rgba[offset + 2] << 16) |
      (rgba[offset + 3] << 24)
    );
  }

  private static _supportCache = new WeakMap<GPUDevice, boolean>();
}

export default WebGPUPrimitiveIndexUtils;
