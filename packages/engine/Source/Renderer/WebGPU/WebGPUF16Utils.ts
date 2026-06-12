/**
 * Half-precision (f16) shader and data utilities.
 * Requires the 'shader-f16' device feature to be enabled.
 *
 * Benefits for CesiumJS:
 * - Normal vectors: f16 normals use 6 bytes vs 12 bytes (f32) — 50% savings
 * - Texture coordinates: f16 UVs use 4 bytes vs 8 bytes — 50% savings
 * - Colors: f16 RGBA uses 8 bytes vs 16 bytes — 50% savings
 * - Terrain vertices with millions of normals benefit enormously
 *
 * CPU-side f16 encoding/decoding uses IEEE 754 half-precision format.
 * GPU-side uses WGSL `enable f16;` + `f16` / `vec3<f16>` types.
 *
 * @example
 * if (context.hasFeature('shader-f16')) {
 *   const normals = WebGPUF16Utils.encodeNormalsF16(normalArray);
 *   // Upload normals as uint16 vertex buffer
 *   // In WGSL: enable f16; @location(N) normal: vec3<f16>
 * }
 * @module WebGPUF16Utils
 */

/// <reference types="@webgpu/types" />

// Precomputed lookup tables for fast f16 conversion
const F16_EXPONENT_BIAS = 15;
const F32_EXPONENT_BIAS = 127;

/**
 * F16 format capabilities and conversion utilities.
 */
export class WebGPUF16Utils {
  /**
   * Check if the device supports shader-f16.
   */
  static isSupported(device: GPUDevice): boolean {
    return device.features.has("shader-f16");
  }

  /**
   * Encode a single float32 value to float16 (stored as uint16).
   *
   * IEEE 754 half-precision: 1 sign + 5 exponent + 10 mantissa bits.
   *
   * @param value - The float32 value
   * @returns The float16 value as a uint16
   */
  static encodeF16(value: number): number {
    const floatView = new Float32Array(1);
    const intView = new Uint32Array(floatView.buffer);
    floatView[0] = value;
    const f32 = intView[0];

    const sign = (f32 >> 16) & 0x8000;
    let exponent = ((f32 >> 23) & 0xff) - F32_EXPONENT_BIAS + F16_EXPONENT_BIAS;
    let mantissa = (f32 >> 13) & 0x3ff;

    if (exponent <= 0) {
      // Denormalized or zero
      if (exponent < -10) return sign; // Too small, flush to zero
      mantissa = (mantissa | 0x400) >> (1 - exponent);
      return sign | mantissa;
    } else if (exponent === 0xff - F32_EXPONENT_BIAS + F16_EXPONENT_BIAS) {
      // Inf or NaN
      if (mantissa) return sign | 0x7c00 | mantissa; // NaN
      return sign | 0x7c00; // Inf
    } else if (exponent > 30) {
      // Overflow → Inf
      return sign | 0x7c00;
    }

    return sign | (exponent << 10) | mantissa;
  }

  /**
   * Decode a float16 (uint16) value back to float32.
   *
   * @param h - The float16 value as uint16
   * @returns The float32 value
   */
  static decodeF16(h: number): number {
    const sign = (h & 0x8000) >> 15;
    const exponent = (h & 0x7c00) >> 10;
    const mantissa = h & 0x03ff;

    if (exponent === 0) {
      if (mantissa === 0) return sign ? -0 : 0;
      // Denormalized
      let e = -1;
      let m = mantissa;
      while (!(m & 0x400)) {
        m <<= 1;
        e--;
      }
      m &= 0x3ff;
      const f32Exp = e + F32_EXPONENT_BIAS - F16_EXPONENT_BIAS + 1;
      const f32 = ((sign << 31) | (f32Exp << 23) | (m << 13)) >>> 0;
      const buf = new ArrayBuffer(4);
      new Uint32Array(buf)[0] = f32;
      return new Float32Array(buf)[0];
    } else if (exponent === 31) {
      if (mantissa === 0) return sign ? -Infinity : Infinity;
      return NaN;
    }

    const f32Exp = exponent - F16_EXPONENT_BIAS + F32_EXPONENT_BIAS;
    const f32 = ((sign << 31) | (f32Exp << 23) | (mantissa << 13)) >>> 0;
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = f32;
    return new Float32Array(buf)[0];
  }

  /**
   * Batch encode Float32Array → Uint16Array of f16 values.
   *
   * @param input - Float32 values
   * @returns Uint16 array of f16 values
   */
  static encodeArrayF16(input: Float32Array): Uint16Array {
    const output = new Uint16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = WebGPUF16Utils.encodeF16(input[i]);
    }
    return output;
  }

  /**
   * Encode normal vectors from Float32Array (xyz×N) to Uint16Array (f16 xyz×N).
   * Normals are assumed to be in [-1, 1] range — perfect for f16.
   *
   * @param normals - Float32Array of [nx, ny, nz, nx, ny, nz, ...]
   * @returns Uint16Array of f16-encoded normals
   */
  static encodeNormalsF16(normals: Float32Array): Uint16Array {
    return WebGPUF16Utils.encodeArrayF16(normals);
  }

  /**
   * Encode texture coordinates from Float32Array (uv×N) to Uint16Array (f16 uv×N).
   * UVs are typically in [0, 1] range — well within f16 precision.
   *
   * @param uvs - Float32Array of [u, v, u, v, ...]
   * @returns Uint16Array of f16-encoded UVs
   */
  static encodeTexCoordsF16(uvs: Float32Array): Uint16Array {
    return WebGPUF16Utils.encodeArrayF16(uvs);
  }

  /**
   * Encode RGBA colors from Float32Array (rgba×N) to Uint16Array (f16 rgba×N).
   *
   * @param colors - Float32Array of [r, g, b, a, r, g, b, a, ...]
   * @returns Uint16Array of f16-encoded colors
   */
  static encodeColorsF16(colors: Float32Array): Uint16Array {
    return WebGPUF16Utils.encodeArrayF16(colors);
  }

  /**
   * Generate WGSL code that enables f16 and defines f16 vertex inputs.
   *
   * @param hasNormals - Whether to include f16 normals
   * @param hasTexCoords - Whether to include f16 texture coordinates
   * @param hasColors - Whether to include f16 colors
   * @param startLocation - Starting @location index (default: 2, after posHigh/Low)
   * @returns WGSL code snippet for vertex input struct
   */
  static generateF16VertexInputWGSL(
    hasNormals: boolean = true,
    hasTexCoords: boolean = false,
    hasColors: boolean = false,
    startLocation: number = 2,
  ): string {
    let loc = startLocation;
    let code = "enable f16;\n\n";
    code += "struct F16VertexInput {\n";

    if (hasNormals) {
      code += `  @location(${loc++}) normal: vec3<f16>,\n`;
    }
    if (hasTexCoords) {
      code += `  @location(${loc++}) texCoord: vec2<f16>,\n`;
    }
    if (hasColors) {
      code += `  @location(${loc++}) color: vec4<f16>,\n`;
    }

    code += "};\n";
    return code;
  }

  /**
   * Get the WebGPU vertex buffer layout for f16 attributes.
   *
   * @param components - Number of f16 components (e.g., 3 for normals)
   * @param shaderLocation - The @location index
   * @returns GPUVertexBufferLayout entry
   */
  static getF16VertexBufferLayout(
    components: number,
    shaderLocation: number,
  ): GPUVertexBufferLayout {
    // Map component count to WebGPU vertex format
    const formatMap: Record<number, GPUVertexFormat> = {
      1: "float16x2", // f16x1 doesn't exist, use x2 with padding
      2: "float16x2",
      3: "float16x4", // f16x3 doesn't exist, use x4 with padding
      4: "float16x4",
    };

    const format = formatMap[components] ?? "float16x4";
    const strideBytes = components <= 2 ? 4 : 8; // 2 or 4 bytes per f16

    return {
      arrayStride: strideBytes,
      attributes: [
        {
          format,
          offset: 0,
          shaderLocation,
        },
      ],
    };
  }

  /**
   * Estimate memory savings from using f16 for the given attribute data.
   *
   * @param vertexCount - Number of vertices
   * @param componentsPerVertex - Components per vertex (e.g., 3 for normals)
   * @returns Object with f32 and f16 sizes in bytes
   */
  static estimateMemorySavings(
    vertexCount: number,
    componentsPerVertex: number,
  ): {
    f32Bytes: number;
    f16Bytes: number;
    savingsBytes: number;
    savingsPercent: number;
  } {
    const f32Bytes = vertexCount * componentsPerVertex * 4;
    const f16Bytes = vertexCount * componentsPerVertex * 2;
    return {
      f32Bytes,
      f16Bytes,
      savingsBytes: f32Bytes - f16Bytes,
      savingsPercent: 50, // Always 50% for f16 vs f32
    };
  }
}

export default WebGPUF16Utils;
