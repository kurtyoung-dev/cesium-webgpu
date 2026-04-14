/**
 * Type declarations for PassState.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * PassState is a plain data container set by the renderer per pass — most
 * fields default to `undefined` and are filled in by the scene layer.
 *
 * The `Cesium*` types come from the ambient declarations in
 * `WebGPU/cesium-js-types.d.ts` (loaded as part of the engine tsconfig).
 */

declare class PassState {
  constructor(context: CesiumGraphicsContext);

  context: CesiumGraphicsContext;
  framebuffer: CesiumOpaqueFramebuffer | undefined;
  blendingEnabled: boolean | undefined;
  scissorTest:
    | { enabled: boolean; rectangle: CesiumBoundingRectangle }
    | undefined;
  viewport: CesiumBoundingRectangle | undefined;
}

export default PassState;
