/**
 * Type declarations for ShaderCache.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * ShaderCache is the renderer's shared shader program cache, owned by
 * GraphicsContext and consumed by both WebGL and WebGPU pipelines.
 *
 * The `Cesium*` types come from the ambient declarations in
 * `WebGPU/cesium-js-types.d.ts`.
 */

interface ShaderProgramOptions {
  vertexShaderSource: string | CesiumOpaqueShaderSource;
  fragmentShaderSource: string | CesiumOpaqueShaderSource;
  attributeLocations?: Record<string, number> | object;
}

interface ShaderCacheOptions {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
  maximumPendingShaderPreparations?: number;
  minimumShaderPreparationTimeRemaining?: number;
  shaderCompileIdleTimeout?: number;
  getTimestamp?: () => number;
}

declare class ShaderCache {
  constructor(context: CesiumGraphicsContext, options?: ShaderCacheOptions);

  readonly _context: CesiumGraphicsContext;
  readonly numberOfShaders: number;

  getShaderProgram(options: ShaderProgramOptions): CesiumOpaqueShaderProgram;
  replaceShaderProgram(
    options: ShaderProgramOptions & {
      shaderProgram?: CesiumOpaqueShaderProgram;
    },
  ): CesiumOpaqueShaderProgram;
  getDerivedShaderProgram(
    shaderProgram: CesiumOpaqueShaderProgram,
    keyword: string,
  ): CesiumOpaqueShaderProgram | undefined;
  createDerivedShaderProgram(
    shaderProgram: CesiumOpaqueShaderProgram,
    keyword: string,
    options: ShaderProgramOptions,
  ): CesiumOpaqueShaderProgram;
  scheduleShaderProgramCompilation(
    shaderProgram: CesiumOpaqueShaderProgram,
  ): boolean;
  scheduleShaderProgramPreparation(
    prepareShaderProgram: () => CesiumOpaqueShaderProgram | undefined,
    owner?: object,
  ): boolean;
  cancelShaderProgramPreparations(owner: object): number;
  replaceDerivedShaderProgram(
    shaderProgram: CesiumOpaqueShaderProgram,
    keyword: string,
    options: ShaderProgramOptions,
  ): CesiumOpaqueShaderProgram;
  destroyReleasedShaderPrograms(): void;
  releaseShaderProgram(program: CesiumOpaqueShaderProgram): void;
  isDestroyed(): boolean;
  destroy(): undefined;
}

export default ShaderCache;
