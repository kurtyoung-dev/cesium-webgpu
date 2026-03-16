/**
 * Type helpers for WebGPU renderer TypeScript files.
 *
 * CesiumJS core modules (Matrix4, ComponentDatatype, Resource, etc.) are
 * written in JavaScript with prototype-based patterns that TypeScript cannot
 * fully infer. This module provides type-safe wrappers and casts to bridge
 * the gap without using `as any`.
 *
 * @private
 */

/**
 * CesiumJS Matrix4 is backed by a Float64Array and supports numeric indexing
 * at runtime (e.g., `matrix[0]` through `matrix[15]`). TypeScript cannot infer
 * an index signature from the JS source.
 *
 * Use `m4Values()` to get a numerically-indexable view of a Matrix4 result.
 */
export type IndexableMatrix = Record<number, number>;

/**
 * Casts a CesiumJS Matrix4 result to a numerically-indexable object.
 * Call after Matrix4.multiply(), Matrix4.clone(), etc. when you need
 * bracket access like `matrix[i]` or `matrix[12] = 0`.
 *
 * @param matrix - The Matrix4 result (from Matrix4.multiply etc.)
 * @returns The same object, typed to allow numeric indexing
 *
 * @example
 * const mvp = m4Values(Matrix4.multiply(proj, view, scratch));
 * mvp[12] = 0; // zero translation for RTE
 * for (let i = 0; i < 16; i++) data[i] = mvp[i];
 */
export function m4Values(matrix: unknown): IndexableMatrix {
  return matrix as IndexableMatrix;
}

/**
 * Casts a typed array to a type compatible with WebGPU's writeBuffer / writeTexture.
 *
 * In TypeScript 5.x, typed arrays became generic (`Float32Array<ArrayBufferLike>`),
 * which is not assignable to `GPUAllowSharedBufferSource`. This helper strips the
 * generic parameter via a safe cast.
 *
 * @param data - A typed array (Float32Array, Uint8Array, Uint16Array, Uint32Array, etc.)
 * @returns The same data, typed as AllowSharedBufferSource
 *
 * @example
 * device.queue.writeBuffer(buffer, 0, gpuData(myFloat32Array));
 * device.queue.writeTexture({...}, gpuData(myUint8Array), ...);
 */
export function gpuData(
  data: ArrayBufferView | ArrayBuffer,
): GPUAllowSharedBufferSource {
  return data as unknown as GPUAllowSharedBufferSource;
}
