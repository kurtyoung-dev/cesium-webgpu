import type { WeatherField } from "./WeatherTypes.js";
import { polarLowPassWidth } from "./WeatherMapSeam.js";

export interface PackedWeatherVertical {
  readonly bytes: Uint8Array;
  readonly minimumBase: number;
  readonly maximumTop: number;
}

interface VerticalTaps {
  i00: number;
  i10: number;
  i01: number;
  i11: number;
  tx: number;
  ty: number;
  v00: boolean;
  v10: boolean;
  v01: boolean;
  v11: boolean;
}

export function createWeatherVertical(
  field: WeatherField,
  width: number,
  height: number,
): Uint16Array | undefined {
  if (field.topMeters === undefined) {
    return undefined;
  }
  const count = field.gridWidth * field.gridHeight;
  if (field.topMeters.length !== count || field.baseMeters?.length !== count) {
    throw new RangeError("Cloud vertical bounds must match the weather grid.");
  }
  // Zero base/top pairs are missing metadata, not observations of clear sky.
  return new Uint16Array(width * height * 2);
}

export function sampleWeatherVertical(
  field: WeatherField,
  taps: VerticalTaps,
  heights: Uint16Array,
  coverage: Float32Array,
  index: number,
): number {
  let weight = 0,
    cloudyWeight = 0;
  let baseSum = 0,
    topSum = 0,
    cloudyBase = 0,
    cloudyTop = 0;
  for (let k = 0; k < 4; k++) {
    const valid =
      k === 0 ? taps.v00 : k === 1 ? taps.v10 : k === 2 ? taps.v01 : taps.v11;
    if (!valid) {
      continue;
    }
    const i =
      k === 0 ? taps.i00 : k === 1 ? taps.i10 : k === 2 ? taps.i01 : taps.i11;
    const base = field.baseMeters![i],
      top = field.topMeters![i];
    if (
      !Number.isFinite(base) ||
      !Number.isFinite(top) ||
      base === field.noDataValue ||
      top === field.noDataValue ||
      base < 0 ||
      top < base + 1 ||
      top > 32767.5
    ) {
      continue;
    }
    const w =
      (k % 2 === 0 ? 1 - taps.tx : taps.tx) * (k < 2 ? 1 - taps.ty : taps.ty);
    const mass = w * Math.max(0, Math.min(1, field.coverage[i]));
    weight += w;
    cloudyWeight += mass;
    baseSum += base * w;
    topSum += top * w;
    cloudyBase += base * mass;
    cloudyTop += top * mass;
  }
  if (!(weight > 0)) {
    return 0;
  }
  const base = cloudyWeight > 0 ? cloudyBase / cloudyWeight : baseSum / weight;
  const top = cloudyWeight > 0 ? cloudyTop / cloudyWeight : topSum / weight;
  heights[index * 2] = Math.round(base * 2);
  heights[index * 2 + 1] = Math.max(
    heights[index * 2] + 2,
    Math.round(top * 2),
  );
  coverage[index] = cloudyWeight / weight;
  return weight;
}

export function finishWeatherVertical(
  heights: Uint16Array,
  width: number,
  height: number,
  coverage: Float32Array,
): PackedWeatherVertical | undefined {
  // Filter physical heights before splitting bytes, preserving carries and
  // excluding missing intervals from both cloudy and wholly clear averages.
  const prefix = new Float64Array(width + 1);
  const ordinaryPrefix = new Float64Array(width + 1);
  const massPrefix = new Float64Array(width + 1);
  const validPrefix = new Float64Array(width + 1);
  const valid = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const kernel = polarLowPassWidth(y, height, width);
    if (kernel <= 1) {
      continue;
    }
    const row = y * width * 2,
      radius = (kernel - 1) / 2;
    for (let x = 0; x < width; x++) {
      valid[x] = heights[row + x * 2 + 1] >= heights[row + x * 2] + 2 ? 1 : 0;
    }
    for (let c = 0; c < 2; c++) {
      prefix[0] = ordinaryPrefix[0] = massPrefix[0] = validPrefix[0] = 0;
      for (let x = 0; x < width; x++) {
        const value = heights[row + x * 2 + c];
        const amount = valid[x] ? coverage[y * width + x] : 0;
        prefix[x + 1] = prefix[x] + value * amount;
        ordinaryPrefix[x + 1] = ordinaryPrefix[x] + (valid[x] ? value : 0);
        massPrefix[x + 1] = massPrefix[x] + amount;
        validPrefix[x + 1] = validPrefix[x] + valid[x];
      }
      for (let x = 0; x < width; x++) {
        // A polar filter may smooth observations, but cannot invent regional
        // height observations beyond the source's support.
        if (!valid[x]) {
          continue;
        }
        const lo = x - radius,
          hi = x + radius;
        const windowSum = (values: Float64Array) =>
          kernel >= width
            ? values[width]
            : lo < 0
              ? values[width] - values[lo + width] + values[hi + 1]
              : hi >= width
                ? values[width] - values[lo] + values[hi + 1 - width]
                : values[hi + 1] - values[lo];
        const mass = windowSum(massPrefix);
        heights[row + x * 2 + c] = Math.round(
          mass > 0
            ? windowSum(prefix) / mass
            : windowSum(ordinaryPrefix) / windowSum(validPrefix),
        );
      }
    }
  }
  const bytes = new Uint8Array(width * height * 4);
  let minimumBase = Infinity,
    maximumTop = 0;
  for (let i = 0; i < width * height; i++) {
    const base = heights[i * 2],
      candidate = heights[i * 2 + 1];
    if (candidate === 0) {
      continue;
    }
    const top = Math.max(base + 2, candidate);
    bytes[i * 4] = base & 255;
    bytes[i * 4 + 1] = base >>> 8;
    bytes[i * 4 + 2] = top & 255;
    bytes[i * 4 + 3] = top >>> 8;
    minimumBase = Math.min(minimumBase, base * 0.5);
    maximumTop = Math.max(maximumTop, top * 0.5);
  }
  return maximumTop > 0
    ? Object.freeze({ bytes, minimumBase, maximumTop })
    : undefined;
}

export function validPackedWeatherVertical(
  value: PackedWeatherVertical | undefined,
  width: number,
  height: number,
): boolean {
  return (
    value !== undefined &&
    value.bytes instanceof Uint8Array &&
    value.bytes.length === width * height * 4 &&
    Number.isFinite(value.minimumBase) &&
    Number.isFinite(value.maximumTop) &&
    value.minimumBase >= 0 &&
    value.maximumTop >= value.minimumBase + 1 &&
    value.maximumTop <= 32767.5
  );
}

export function samplePackedWeatherVertical(
  value: PackedWeatherVertical | undefined,
  width: number,
  height: number,
  u: number,
  v: number,
): [number, number, number] | undefined {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    !validPackedWeatherVertical(value, width, height)
  ) {
    return undefined;
  }
  const px = (u - Math.floor(u)) * width - 0.5;
  const py = Math.max(0, Math.min(1, v)) * height - 0.5;
  const x0 = Math.floor(px),
    y0 = Math.floor(py),
    tx = px - x0,
    ty = py - y0;
  let baseMoment = 0,
    topMoment = 0,
    support = 0;
  // Decode each physical interval before interpolation; unknown texels carry
  // zero support rather than an artificial cloud base at sea level.
  for (let tap = 0; tap < 4; tap++) {
    const x = (((x0 + (tap % 2)) % width) + width) % width;
    const y = Math.max(0, Math.min(height - 1, y0 + (tap < 2 ? 0 : 1)));
    const i = (y * width + x) * 4,
      bytes = value!.bytes;
    const base = (bytes[i] + 256 * bytes[i + 1]) * 0.5;
    const top = (bytes[i + 2] + 256 * bytes[i + 3]) * 0.5;
    if (top < base + 1) {
      continue;
    }
    const weight = (tap % 2 === 0 ? 1 - tx : tx) * (tap < 2 ? 1 - ty : ty);
    baseMoment += base * weight;
    topMoment += top * weight;
    support += weight;
  }
  return support > 0
    ? [baseMoment / support, topMoment / support, support]
    : undefined;
}
