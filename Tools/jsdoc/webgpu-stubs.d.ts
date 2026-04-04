/**
 * Type stubs for WebGPU-specific types referenced in the generated Cesium.d.ts.
 * These types are defined in TypeScript files under Renderer/WebGPU/ and Scene/
 * but are not part of the public JSDoc-generated API surface. This stub file
 * satisfies the tsc validation in buildTs without requiring the full TS sources.
 */

// Renderer/WebGPU types
declare class WebGPUBuffer {
  readonly buffer: GPUBuffer;
  readonly size: number;
  destroy(): void;
}

declare class WebGPUDrawCommand {
  execute(passEncoder: any): void;
}

// Renderer abstract types
declare class GraphicsContext {
  readonly id: string;
  readonly isWebGPU: boolean;
  readonly rendererType: string;
}

declare class ContextRegistry {
  readonly count: number;
}

// Scene types
declare class LightCollection {
  add(light: any): void;
  remove(light: any): boolean;
  readonly length: number;
}

declare class RenderScheduler {
  beginFrame(): void;
}

// Upstream missing member stub — ImageryLayer is inside the "cesium" module
// in the generated Cesium.d.ts, so we augment the module declaration.
declare module "cesium" {
  namespace ImageryLayer {
    interface WorldImageryConstructorOptions {}
  }
}
