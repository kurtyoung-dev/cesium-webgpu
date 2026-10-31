import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";
import {
  WIND_COMPONENT_MAX_MPS,
  WIND_COMPONENT_MIN_MPS,
  encodeWindVector,
  encodePressureAnomaly,
  encodeTemperature,
  encodeBeaufortScale,
  encodeSignificantWaveHeight,
  sampleEnvironmentalTensor,
  type EnvironmentalTensorSet,
} from "./EnvironmentalTensorMap.js";
import {
  applyEquirectPolarLowPass,
  applyEquirectPolarWindLowPass,
} from "./WeatherMapSeam.js";
import { SynopticWeatherPattern } from "./SynopticWeatherPattern.js";

export class SynopticWeatherSource implements WeatherSource {
  private readonly _seed: string | number;
  private readonly _width: number;
  private readonly _height: number;

  constructor(seed: string | number = 1, width = 360, height = 181) {
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
    this._seed = seed;
    this._width = width;
    this._height = height;
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `procedural:synoptic:${this._seed}`,
      label: "Procedural synoptic weather",
      supportsTime: true,
    };
  }

  async fetchField(request: WeatherFieldRequest): Promise<WeatherField> {
    const time =
      request.time instanceof Date ? request.time : new Date(946728000000);
    const pattern = new SynopticWeatherPattern(this._seed, time.getTime());
    const w = this._width,
      h = this._height;
    const coverage = new Float32Array(w * h),
      type = new Float32Array(w * h);
    const baseMeters = new Float32Array(w * h),
      densityBias = new Float32Array(w * h);
    const atmosphericBytes = new Uint8Array(w * h * 4),
      marineBytes = new Uint8Array(w * h * 4);
    const checkAbort = () => {
      if (request.signal?.aborted) {
        throw new Error("Weather generation aborted.");
      }
    };
    checkAbort();
    for (let y = 0; y < h; y++) {
      if (y % 8 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkAbort();
      }
      const latitude = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
      for (let x = 0; x < w; x++) {
        const longitude = -Math.PI + ((x + 0.5) / w) * Math.PI * 2;
        const sample = pattern.sample(longitude, latitude),
          i = y * w + x,
          offset = i * 4;
        coverage[i] = sample.coverage;
        type[i] = sample.cloudType;
        baseMeters[i] = sample.baseMeters;
        densityBias[i] = sample.densityBias;
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
    environmentalTensors.sample = (longitude, latitude) =>
      sampleEnvironmentalTensor(environmentalTensors, longitude, latitude);
    return {
      gridWidth: w,
      gridHeight: h,
      coverage,
      type,
      baseMeters,
      densityBias,
      bounds: GLOBAL_WEATHER_BOUNDS,
      registration: "cell",
      validTime: time.toISOString(),
      source: this.getCapabilities().id,
      environmentalTensors,
    };
  }
}
