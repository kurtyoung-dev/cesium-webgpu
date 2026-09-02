const gpuBufferUsage = Object.freeze({
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
});

const gpuShaderStage = Object.freeze({
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
});

const gpuTextureUsage = Object.freeze({
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
  TRANSIENT_ATTACHMENT: 0x20,
});

const gpuMapMode = Object.freeze({
  READ: 0x0001,
  WRITE: 0x0002,
});

export const webGPUTestConstants = Object.freeze({
  GPUBufferUsage: gpuBufferUsage,
  GPUShaderStage: gpuShaderStage,
  GPUTextureUsage: gpuTextureUsage,
  GPUMapMode: gpuMapMode,
});

export function installWebGPUTestConstants(target = globalThis) {
  for (const [name, constants] of Object.entries(webGPUTestConstants)) {
    if (typeof target[name] === "undefined") {
      target[name] = constants;
    }
  }
}

// Import this module before WebGPU subjects so their module-evaluation reads
// see the same constants as their later call-time reads.
installWebGPUTestConstants();

export default installWebGPUTestConstants;
