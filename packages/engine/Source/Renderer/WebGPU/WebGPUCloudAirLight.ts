import type { WebGPUPerformanceManager } from "./WebGPUPerformanceManager.js";

export const CLOUD_AIR_LIGHT_OFFSET = 180;
export const CLOUD_AIR_LIGHT_FLOATS = 16;

interface Color {
  x?: number;
  y?: number;
  z?: number;
}

export interface CloudAirLightConditions {
  scattering?: {
    rayleighCoefficient?: Color;
    mieCoefficient?: Color;
    rayleighScaleHeight?: number;
    mieScaleHeight?: number;
    mieAnisotropy?: number;
  };
  skyAtmosphere?: { lightIntensity?: number };
  lighting?: { enableSunLight?: boolean };
}

const coefficientIndices = [8, 9, 10, 12, 13, 14, 20, 21, 22];

/**
 * The sun LUT parameters a context's performance manager publishes through its
 * public `getAtmosphereLUTParams()` accessor, or `undefined` when the context
 * has no such manager, the accessor is absent, or nothing is published yet. It
 * never reads the manager's private LUT resource record.
 */
export function readPublishedAtmosphereParams(
  context: object,
): Float32Array | undefined {
  const manager =
    "performanceManager" in context ? context.performanceManager : undefined;
  if (!isAtmosphereParamsSource(manager)) {
    return undefined;
  }
  const params = manager.getAtmosphereLUTParams();
  return params instanceof Float32Array ? params : undefined;
}

// The ambient context type does not declare the WebGPU performance manager,
// so a manager is admitted by the shape of the manager's own accessor.
function isAtmosphereParamsSource(
  value: unknown,
): value is Pick<WebGPUPerformanceManager, "getAtmosphereLUTParams"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getAtmosphereLUTParams" in value &&
    typeof value.getAtmosphereLUTParams === "function"
  );
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function writeCloudAirLightUniforms(
  data: Float32Array,
  offset: number,
  conditions: CloudAirLightConditions | undefined,
  published: Float32Array | undefined,
  eclipseFactor: number,
): number {
  let baked =
    published instanceof Float32Array &&
    published.length >= 24 &&
    published[0] > 1 &&
    published[1] > published[0] &&
    published[2] > 0 &&
    published[3] > 0 &&
    Number.isFinite(published[0]) &&
    Number.isFinite(published[1]) &&
    Number.isFinite(published[2]) &&
    Number.isFinite(published[3]) &&
    Number.isFinite(published[4]) &&
    Number.isFinite(published[5]);
  if (baked) {
    for (const index of coefficientIndices) {
      if (!Number.isFinite(published![index]) || published![index] < 0) {
        baked = false;
        break;
      }
    }
  }
  const scattering = conditions?.scattering;
  const rayleigh = scattering?.rayleighCoefficient;
  const mie = scattering?.mieCoefficient;
  data[offset] = Math.max(
    baked ? published![8] : finite(rayleigh?.x, 5.5e-6),
    0,
  );
  data[offset + 1] = Math.max(
    baked ? published![9] : finite(rayleigh?.y, 13e-6),
    0,
  );
  data[offset + 2] = Math.max(
    baked ? published![10] : finite(rayleigh?.z, 22.4e-6),
    0,
  );
  data[offset + 3] = Math.max(
    baked ? published![2] : finite(scattering?.rayleighScaleHeight, 8500),
    1,
  );
  data[offset + 4] = Math.max(
    baked ? published![12] : finite(mie?.x, 21e-6),
    0,
  );
  data[offset + 5] = Math.max(
    baked ? published![13] : finite(mie?.y, 21e-6),
    0,
  );
  data[offset + 6] = Math.max(
    baked ? published![14] : finite(mie?.z, 21e-6),
    0,
  );
  data[offset + 7] = Math.max(
    baked ? published![3] : finite(scattering?.mieScaleHeight, 1200),
    1,
  );
  data[offset + 8] = baked ? published![20] : 0;
  data[offset + 9] = baked ? published![21] : 0;
  data[offset + 10] = baked ? published![22] : 0;
  data[offset + 11] = Math.min(
    Math.max(
      baked ? published![4] : finite(scattering?.mieAnisotropy, 0.758),
      -0.95,
    ),
    0.95,
  );
  const lightIntensity = baked
    ? published![5]
    : finite(conditions?.skyAtmosphere?.lightIntensity, 50);
  data[offset + 12] =
    conditions?.lighting?.enableSunLight === false
      ? 0
      : Math.max(lightIntensity, 0) *
        Math.min(Math.max(finite(eclipseFactor, 1), 0), 1);
  // The table's altitude domain comes from its producer, not a cloud-shell constant.
  data[offset + 13] = baked ? 1 : 0;
  data[offset + 14] = baked ? published![1] - published![0] : 111000;
  data[offset + 15] = 0;
  return offset + CLOUD_AIR_LIGHT_FLOATS;
}
