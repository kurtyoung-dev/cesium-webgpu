/**
 * WebGPU Ground Atmosphere Renderer
 *
 * Provides atmosphere parameters to the globe terrain shader for ground-level
 * atmospheric scattering (Nishita-style Rayleigh + Mie).
 *
 * In the GLSL path, ground atmosphere is integrated into Globe.js via shader
 * defines (GROUND_ATMOSPHERE, PER_FRAGMENT_GROUND_ATMOSPHERE). In the WebGPU
 * path, the atmosphere parameters are passed as a uniform buffer that the
 * GlobeTerrain.wgsl shader reads from.
 *
 * The renderer packs parameters from Globe.js properties:
 * - showGroundAtmosphere → enables/disables
 * - atmosphereLightIntensity → light.lightIntensity
 * - atmosphereRayleighCoefficient → rayleighCoefficient
 * - atmosphereMieCoefficient → mieCoefficient
 * - atmosphereRayleighScaleHeight → rayleighScaleHeight
 * - atmosphereMieScaleHeight → mieScaleHeight
 * - atmosphereMieAnisotropy → mieAnisotropy
 *
 * @module WebGPUGroundAtmosphereRenderer
 */

// Default atmosphere values matching CesiumJS defaults and Earth's atmosphere
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 10000.0; // meters
const DEFAULT_MIE_SCALE_HEIGHT = 3200.0; // meters
const DEFAULT_MIE_ANISOTROPY = 0.9;
const DEFAULT_LIGHT_INTENSITY = 10.0;
const ATMOSPHERE_THICKNESS = 111000.0; // meters
const EARTH_RADIUS = 6378137.0; // meters (WGS84 semi-major axis)

// Default Rayleigh scattering coefficients (sea-level, per-meter)
const DEFAULT_RAYLEIGH_R = 5.5e-6;
const DEFAULT_RAYLEIGH_G = 13.0e-6;
const DEFAULT_RAYLEIGH_B = 22.4e-6;

// Default Mie scattering coefficient
const DEFAULT_MIE = 21e-6;

// Uniform buffer size: AtmosphereParams struct = 64 bytes (16 floats)
const ATMOSPHERE_UNIFORM_SIZE = 64;

interface AtmosphereCache {
  uniformBuffer: GPUBuffer | null;
  data: Float32Array;
  enabled: boolean;
  dirty: boolean;
}

/**
 * Packs atmosphere parameters into a Float32Array matching the
 * AtmosphereParams struct in GroundAtmosphere.wgsl.
 */
function packAtmosphereParams(
  globe: CesiumGlobe,
  ellipsoid: { maximumRadius?: number } | null | undefined,
): Float32Array {
  const data = new Float32Array(16);

  // Determine inner/outer radius from ellipsoid
  const innerRadius = ellipsoid?.maximumRadius ?? EARTH_RADIUS;
  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;

  data[0] = innerRadius;
  data[1] = outerRadius;
  data[2] =
    globe.atmosphereRayleighScaleHeight ?? DEFAULT_RAYLEIGH_SCALE_HEIGHT;
  data[3] = globe.atmosphereMieScaleHeight ?? DEFAULT_MIE_SCALE_HEIGHT;

  // Rayleigh coefficient (vec3 + pad)
  const rc = globe.atmosphereRayleighCoefficient;
  data[4] = rc?.x ?? DEFAULT_RAYLEIGH_R;
  data[5] = rc?.y ?? DEFAULT_RAYLEIGH_G;
  data[6] = rc?.z ?? DEFAULT_RAYLEIGH_B;
  data[7] = 0.0; // padding

  // Mie coefficient (vec3 + anisotropy)
  const mc = globe.atmosphereMieCoefficient;
  data[8] = mc?.x ?? DEFAULT_MIE;
  data[9] = mc?.y ?? DEFAULT_MIE;
  data[10] = mc?.z ?? DEFAULT_MIE;
  data[11] = globe.atmosphereMieAnisotropy ?? DEFAULT_MIE_ANISOTROPY;

  // Light intensity and dynamic lighting mode
  data[12] = globe.atmosphereLightIntensity ?? DEFAULT_LIGHT_INTENSITY;
  data[13] = globe.dynamicAtmosphereLighting ? 1.0 : 0.0;
  data[14] = 0.0; // padding
  data[15] = 0.0; // padding

  return data;
}

/**
 * Update ground atmosphere uniforms.
 * Called each frame from the globe surface renderer when showGroundAtmosphere is true.
 */
function updateWebGPUGroundAtmosphere(
  globe: CesiumGlobe,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (!globe._webgpuAtmosphereCache) {
    globe._webgpuAtmosphereCache = {
      uniformBuffer: null,
      data: new Float32Array(16),
      enabled: false,
      dirty: true,
    } as AtmosphereCache;
  }

  const cache = globe._webgpuAtmosphereCache as AtmosphereCache;
  cache.enabled = globe.showGroundAtmosphere === true;

  if (!cache.enabled) {
    return;
  }

  // Create uniform buffer if needed
  if (!cache.uniformBuffer) {
    cache.uniformBuffer = device.createBuffer({
      size: ATMOSPHERE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.dirty = true;
  }

  // Pack and upload atmosphere parameters
  const ellipsoid = globe.ellipsoid;
  const newData = packAtmosphereParams(globe, ellipsoid);

  // Dirty check: compare with previous data
  let changed = cache.dirty;
  if (!changed) {
    for (let i = 0; i < 16; i++) {
      if (Math.abs(cache.data[i] - newData[i]) > 1e-7) {
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    cache.data.set(newData);
    device.queue.writeBuffer(cache.uniformBuffer!, 0, cache.data);
    cache.dirty = false;
  }

  // Expose for globe terrain shader
  globe._webgpuAtmosphereBuffer = cache.uniformBuffer;
  globe._webgpuAtmosphereEnabled = cache.enabled;
}

/**
 * Destroy ground atmosphere GPU resources.
 */
function destroyWebGPUGroundAtmosphereResources(globe: CesiumGlobe): void {
  const cache = globe._webgpuAtmosphereCache as AtmosphereCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.uniformBuffer) {
    cache.uniformBuffer.destroy();
  }

  globe._webgpuAtmosphereCache = undefined;
  globe._webgpuAtmosphereBuffer = undefined;
  globe._webgpuAtmosphereEnabled = undefined;
}

export { updateWebGPUGroundAtmosphere, destroyWebGPUGroundAtmosphereResources };
export default {
  updateWebGPUGroundAtmosphere,
  destroyWebGPUGroundAtmosphereResources,
};
