import type { WeatherField } from "./WeatherTypes.js";
import type { PackedWeatherVertical } from "./WeatherVerticalField.js";
import { polarLowPassWidth } from "./WeatherMapSeam.js";

export interface WeatherCloudLayer {
  coverage: Float32Array;
  type?: Float32Array;
  baseMeters: Float32Array;
  topMeters: Float32Array;
  densityBias?: Float32Array;
}

export interface PackedWeatherCloudLayers {
  // Each population occupies control, physical-height and observation-support
  // planes. Control uses the same genus/10 encoding as ordinary weather.
  readonly bytes: Uint8Array;
  readonly bounds: readonly (
    { readonly minimumBase: number; readonly maximumTop: number } | undefined
  )[];
}

export function createWeatherCloudLayer(count: number): WeatherCloudLayer {
  return {
    coverage: new Float32Array(count),
    type: new Float32Array(count),
    baseMeters: new Float32Array(count),
    topMeters: new Float32Array(count),
    densityBias: new Float32Array(count),
  };
}

export function validateWeatherCloudLayers(field: WeatherField): void {
  if (field.layers === undefined) {
    return;
  }
  const count = field.gridWidth * field.gridHeight;
  if (
    !Array.isArray(field.layers) ||
    field.layers.length !== 3 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    Array.from(field.layers).some(
      (layer) =>
        !layer ||
        ![layer.coverage, layer.baseMeters, layer.topMeters].every(
          (v) => v instanceof Float32Array && v.length === count,
        ) ||
        [layer.type, layer.densityBias].some(
          (v) =>
            v !== undefined &&
            (!(v instanceof Float32Array) || v.length !== count),
        ),
    )
  ) {
    throw new RangeError(
      "Three cloud populations must match the weather grid.",
    );
  }
  // Per-cell no-data is resolved by the ordinary packer, including NaN and
  // declared sentinels. Validating shape does not turn gaps into clear sky.
}

export function cloneWeatherCloudLayers(
  layers: readonly WeatherCloudLayer[] | undefined,
): WeatherCloudLayer[] | undefined {
  return layers?.map((layer) => ({
    coverage: layer.coverage.slice(),
    baseMeters: layer.baseMeters.slice(),
    topMeters: layer.topMeters.slice(),
    ...(layer.type ? { type: layer.type.slice() } : {}),
    ...(layer.densityBias ? { densityBias: layer.densityBias.slice() } : {}),
  }));
}

export function packedWeatherCloudLayerFrame(
  value: PackedWeatherCloudLayers,
  layer: number,
  width: number,
  height: number,
):
  | { bytes: Uint8Array; support: Uint8Array; vertical?: PackedWeatherVertical }
  | undefined {
  if (
    !validPackedWeatherCloudLayers(value, width, height) ||
    !Number.isInteger(layer) ||
    layer < 0 ||
    layer > 2
  ) {
    return undefined;
  }
  const plane = width * height * 4,
    start = layer * 3 * plane,
    bounds = value.bounds[layer];
  return {
    bytes: value.bytes.subarray(start, start + plane),
    support: value.bytes.subarray(start + plane * 2, start + plane * 3),
    ...(bounds
      ? {
          vertical: {
            ...bounds,
            bytes: value.bytes.subarray(start + plane, start + plane * 2),
          },
        }
      : {}),
  };
}

export function validPackedWeatherCloudLayers(
  value: PackedWeatherCloudLayers | undefined,
  width: number,
  height: number,
): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    value !== undefined &&
    value !== null &&
    value.bytes instanceof Uint8Array &&
    value.bytes.length === width * height * 36 &&
    Array.isArray(value.bounds) &&
    value.bounds.length === 3 &&
    value.bounds.every(
      (bounds) =>
        bounds === undefined ||
        (bounds !== null &&
          Number.isFinite(bounds.minimumBase) &&
          Number.isFinite(bounds.maximumTop) &&
          bounds.minimumBase >= 0 &&
          bounds.maximumTop >= bounds.minimumBase + 1 &&
          bounds.maximumTop <= 32767.5),
    )
  );
}

export function filterWeatherCloudLayer(
  bytes: Uint8Array,
  support: Uint8Array,
  width: number,
  height: number,
): void {
  const mass = new Float64Array(width + 1),
    sums = new Float64Array(width + 1);
  for (let y = 0; y < height; y++) {
    const kernel = polarLowPassWidth(y, height, width);
    if (kernel <= 1) {
      continue;
    }
    const radius = (kernel - 1) / 2,
      row = y * width * 4;
    mass[0] = 0;
    for (let x = 0; x < width; x++) {
      mass[x + 1] = mass[x] + support[row + x * 4];
    }
    const windowSum = (values: Float64Array, x: number): number => {
      const lo = x - radius,
        hi = x + radius;
      return kernel >= width
        ? values[width]
        : lo < 0
          ? values[width] - values[lo + width] + values[hi + 1]
          : hi >= width
            ? values[width] - values[lo] + values[hi + 1 - width]
            : values[hi + 1] - values[lo];
    };
    for (let channel = 0; channel < 4; channel++) {
      sums[0] = 0;
      for (let x = 0; x < width; x++) {
        sums[x + 1] =
          sums[x] + bytes[row + x * 4 + channel] * support[row + x * 4];
      }
      for (let x = 0; x < width; x++) {
        // Restrict filtering to observed support; regional fallback must not
        // change an observed clear layer into cloud or extend its footprint.
        if (support[row + x * 4] === 0) {
          continue;
        }
        const weight = windowSum(mass, x);
        if (weight > 0) {
          bytes[row + x * 4 + channel] = Math.round(
            windowSum(sums, x) / weight,
          );
        }
      }
    }
  }
}
