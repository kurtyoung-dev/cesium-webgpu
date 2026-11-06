import { GLOBAL_WEATHER_BOUNDS, type WeatherField } from "./WeatherTypes.js";
import {
  WIND_COMPONENT_MAX_MPS,
  WIND_COMPONENT_MIN_MPS,
  encodeWindVector,
  encodePressureAnomaly,
  encodeTemperature,
  encodeBeaufortScale,
  encodeSignificantWaveHeight,
  type EnvironmentalTensorSet,
} from "./EnvironmentalTensorMap.js";
import {
  applyEquirectPolarLowPass,
  applyEquirectPolarWindLowPass,
} from "./WeatherMapSeam.js";
import { SynopticWeatherPattern } from "./SynopticWeatherPattern.js";
import { createWeatherCloudLayer } from "./WeatherCloudLayers.js";

export async function generateSynopticWeatherField(
  seed: string | number,
  width: number,
  height: number,
  timeMs: number,
  cancelled: () => boolean = () => false,
  cooperative = true,
  independentLayers = false,
): Promise<WeatherField> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 4 ||
    height < 3 ||
    width > 1440 ||
    height > 721
  ) {
    throw new RangeError(
      "Weather grid dimensions must be bounded positive integers.",
    );
  }

  const pattern = new SynopticWeatherPattern(seed, timeMs);
  const time = new Date(timeMs);
  const w = width,
    h = height;
  const coverage = new Float32Array(w * h),
    type = new Float32Array(w * h);
  const baseMeters = new Float32Array(w * h),
    densityBias = new Float32Array(w * h);
  const topMeters = new Float32Array(w * h);
  const layers = independentLayers
    ? [0, 1, 2].map(() => createWeatherCloudLayer(w * h))
    : undefined;
  const atmosphericBytes = new Uint8Array(w * h * 4),
    marineBytes = new Uint8Array(w * h * 4);
  const checkAbort = () => {
    if (cancelled()) {
      throw new Error("Weather generation aborted.");
    }
  };
  checkAbort();
  for (let y = 0; y < h; y++) {
    if (cooperative && y % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      checkAbort();
    }
    const latitude = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const longitude = -Math.PI + ((x + 0.5) / w) * Math.PI * 2;
      const sample = pattern.sample(longitude, latitude, independentLayers),
        i = y * w + x,
        offset = i * 4;
      coverage[i] = sample.coverage;
      type[i] = sample.cloudType;
      baseMeters[i] = sample.baseMeters;
      topMeters[i] = sample.topMeters;
      densityBias[i] = sample.densityBias;
      if (layers) {
        for (let layer = 0; layer < 3; layer++) {
          const value = sample.layers![layer],
            target = layers[layer];
          target.coverage[i] = value.coverage;
          target.type![i] = value.cloudType;
          target.baseMeters[i] = value.baseMeters;
          target.topMeters[i] = value.topMeters;
          target.densityBias![i] = value.densityBias;
        }
      }
      const wind = encodeWindVector(sample.windU, sample.windV);
      atmosphericBytes[offset] = wind.r;
      atmosphericBytes[offset + 1] = wind.g;
      atmosphericBytes[offset + 2] = encodePressureAnomaly(
        sample.pressureHpa - 1013.25,
      );
      atmosphericBytes[offset + 3] = encodeTemperature(sample.temperatureC);
      const speed = Math.hypot(sample.windU, sample.windV);
      marineBytes[offset] = Math.round(sample.coverage * 255);
      marineBytes[offset + 1] = encodeBeaufortScale(
        Math.min(12, (speed / 0.836) ** (2 / 3)),
      );
      marineBytes[offset + 2] = encodeSignificantWaveHeight(
        0.0246 * speed * speed,
      );
      marineBytes[offset + 3] = Math.round(sample.precipitation * 255);
    }
  }
  checkAbort();
  applyEquirectPolarWindLowPass(
    atmosphericBytes,
    w,
    h,
    WIND_COMPONENT_MIN_MPS,
    WIND_COMPONENT_MAX_MPS,
  );
  applyEquirectPolarLowPass(marineBytes, w, h);
  const environmentalTensors: EnvironmentalTensorSet = {
    width: w,
    height: h,
    atmosphericBytes,
    marineBytes,
  };
  return {
    gridWidth: w,
    gridHeight: h,
    coverage,
    type,
    baseMeters,
    topMeters,
    densityBias,
    ...(layers ? { layers } : {}),
    bounds: GLOBAL_WEATHER_BOUNDS,
    registration: "cell",
    validTime: time.toISOString(),
    source: ["procedural", "synoptic", seed].join(":"),
    environmentalTensors,
  };
}
