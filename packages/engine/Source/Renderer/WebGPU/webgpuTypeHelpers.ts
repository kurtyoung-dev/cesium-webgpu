/**
 * Type helpers for WebGPU renderer TypeScript files.
 *
 * CesiumJS core modules (Matrix4, ComponentDatatype, Resource, etc.) are
 * written in JavaScript with prototype-based patterns that TypeScript cannot
 * fully infer. This module provides type-safe wrappers and casts to bridge
 * the gap without using `as any`.
 *
 * Adoption rule of thumb:
 * - **DO** route legitimate JS-interop casts through these helpers — they
 *   centralize the cast in one place that's auditable, documents the WHY,
 *   and gives us a single point of attack when CesiumJS adds proper types.
 * - **DO NOT** route renderer-internal `(this as any)._debugLogged = true`
 *   debug-state stashing through here. Those casts are intentional and
 *   local; centralizing them buys nothing.
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
 * // RTE-correct pattern: zero the translation column of MV *before*
 * // multiplying by projection. Zeroing after `proj * mv` wipes out
 * // projection's P23 depth-mapping term (which lands in the same
 * // column-3 slot during the multiply), producing incorrect NDC depth.
 * const mv = Matrix4.multiply(view, model, scratchMV);
 * mv[12] = 0; mv[13] = 0; mv[14] = 0;
 * const mvp = m4Values(Matrix4.multiply(proj, mv, scratchMVP));
 * for (let i = 0; i < 16; i++) data[i] = mvp[i];
 */
export function m4Values(
  matrix: CesiumMatrix4 | Float64Array | ArrayLike<number> | object,
): IndexableMatrix {
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

/**
 * Type-erased view of a CesiumJS JS module/class.
 *
 * Some CesiumJS core modules are written in JavaScript with no complete
 * accompanying `.d.ts`. Static methods (`createTypedArray`, `encode`,
 * `fromCache`, etc.) are not visible to TypeScript, so call sites
 * normally need a `(Foo as any).bar()` cast.
 *
 * Use `jsModule(Foo).bar(...)` instead — it's the same cast but
 * centralizes it here so future cleanup (e.g., adding real type
 * declarations) can find every site by greping for `jsModule(`.
 *
 * @example
 * import IndexDatatype from "../../Core/IndexDatatype.js";
 * const indices = jsModule<{
 *   createTypedArray: (max: number, count: number) => Uint16Array | Uint32Array;
 * }>(IndexDatatype).createTypedArray(vertexCountMax, indexCount);
 */
export function jsModule<T>(mod: object): T {
  return mod as T;
}

/**
 * Casts a TypedArray-like buffer to `number[]` for CesiumJS APIs that
 * declare `number[]` parameters but accept any indexable numeric source
 * at runtime (e.g., `Cartesian3.fromArray`, `Cartesian2.fromArray`).
 *
 * The cast is safe because the underlying JS implementations only call
 * `array[i]` on the parameter — they never invoke `Array.prototype`
 * methods like `push`, `slice`, or `forEach`. Float32Array satisfies
 * the index-access shape just fine.
 *
 * Use this instead of inline `as any` so reviewers can spot the
 * "TypedArray fed into a number[] API" pattern at a glance.
 *
 * @example
 * Cartesian3.fromArray(numericArray(positions), j * 3, scratchCart);
 */
export function numericArray(
  source: ArrayLike<number> | Float32Array | Float64Array,
): number[] {
  return source as unknown as number[];
}
