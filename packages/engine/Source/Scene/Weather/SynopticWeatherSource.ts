import type { WeatherSource } from "./WeatherSource.js";
import type {
  WeatherCapabilities,
  WeatherField,
  WeatherFieldRequest,
} from "./WeatherTypes.js";
import { sampleEnvironmentalTensor } from "./EnvironmentalTensorMap.js";
import { generateSynopticWeatherField } from "./SynopticWeatherField.js";
import { scheduleWeatherTask } from "./WeatherTaskProcessor.js";

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
    const cancelled = () => request.signal?.aborted === true;
    if (cancelled()) {
      throw new Error("Weather generation aborted.");
    }
    if (!Number.isFinite(time.getTime())) {
      throw new RangeError(
        "Weather time must be a valid finite UTC timestamp.",
      );
    }
    let field =
      request.useWorkers !== true
        ? undefined
        : await scheduleWeatherTask<WeatherField>({
            kind: "synoptic",
            seed: this._seed,
            width: this._width,
            height: this._height,
            timeMs: time.getTime(),
            independentCloudLayers: request.independentCloudLayers === true,
          });
    if (cancelled()) {
      throw new Error("Weather generation aborted.");
    }
    field ??= await generateSynopticWeatherField(
      this._seed,
      this._width,
      this._height,
      time.getTime(),
      cancelled,
      true,
      request.independentCloudLayers === true,
    );
    const tensors = field.environmentalTensors!;
    tensors.sample = (longitude, latitude) =>
      sampleEnvironmentalTensor(tensors, longitude, latitude);
    return field;
  }
}
