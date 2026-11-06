import { CloudMaterialFlowResources } from "./WebGPUCloudMaterialFlow.js";
import {
  validPackedWeatherVertical,
  type PackedWeatherVertical,
} from "../../Scene/Weather/WeatherVerticalField.js";
import type { PackedWeatherSnapshot } from "../../Scene/Weather/WeatherProvider.js";
import {
  validPackedWeatherCloudLayers,
  type PackedWeatherCloudLayers,
} from "../../Scene/Weather/WeatherCloudLayers.js";

export interface CloudWeatherTransitionBindings {
  readonly weatherView: GPUTextureView;
  readonly materialFlowBuffer: GPUBuffer;
}
export class CloudWeatherTransitionResources {
  readonly flow = new CloudMaterialFlowResources();
  source: PackedWeatherSnapshot | undefined;
  bindings: CloudWeatherTransitionBindings | undefined;
  private texture: GPUTexture | undefined;
  private view: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private uploaded: Uint8Array | undefined;
  private vertical: PackedWeatherVertical | undefined;
  private layers = 0;
  private populations: PackedWeatherCloudLayers | undefined;

  prepareWeather(
    device: GPUDevice,
    source: PackedWeatherSnapshot,
    verticalEnabled = false,
    populationsEnabled = false,
  ): GPUTextureView {
    const vertical =
      verticalEnabled &&
      validPackedWeatherVertical(source.vertical, source.width, source.height)
        ? source.vertical
        : undefined;
    const populations =
      populationsEnabled &&
      validPackedWeatherCloudLayers(source.layers, source.width, source.height)
        ? source.layers
        : undefined;
    const layers = populations ? 11 : vertical ? 2 : 1;
    if (
      !this.texture ||
      this.width !== source.width ||
      this.height !== source.height ||
      this.layers !== layers
    ) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        label: "Cloud previous weather snapshot",
        size: [source.width, source.height, layers],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.view = this.texture.createView({ dimension: "2d-array" });
      this.width = source.width;
      this.height = source.height;
      this.uploaded = undefined;
      this.layers = layers;
      this.vertical = undefined;
      this.populations = undefined;
    }
    if (
      this.uploaded !== source.bytes ||
      this.vertical !== vertical ||
      this.populations !== populations
    ) {
      device.queue.writeTexture(
        { texture: this.texture },
        source.bytes,
        { bytesPerRow: source.width * 4, rowsPerImage: source.height },
        [source.width, source.height, 1],
      );
      if (vertical) {
        device.queue.writeTexture(
          { texture: this.texture, origin: { x: 0, y: 0, z: 1 } },
          vertical.bytes,
          { bytesPerRow: source.width * 4, rowsPerImage: source.height },
          [source.width, source.height, 1],
        );
      }
      if (populations) {
        device.queue.writeTexture(
          { texture: this.texture, origin: { x: 0, y: 0, z: 2 } },
          populations.bytes,
          { bytesPerRow: source.width * 4, rowsPerImage: source.height },
          [source.width, source.height, 9],
        );
      }
      this.uploaded = source.bytes;
      this.vertical = vertical;
      this.populations = populations;
    }
    return this.view!;
  }

  prepare(
    device: GPUDevice,
    source: PackedWeatherSnapshot | null,
    frame: number,
    verticalEnabled = false,
    populationsEnabled = false,
  ): CloudWeatherTransitionBindings | undefined {
    this.source = source ?? undefined;
    if (!source) {
      return undefined;
    }
    this.prepareWeather(device, source, verticalEnabled, populationsEnabled);
    const buffer = this.flow.prepare(device, source.flow, frame);
    if (
      !this.bindings ||
      this.bindings.weatherView !== this.view ||
      this.bindings.materialFlowBuffer !== buffer
    ) {
      this.bindings = Object.freeze({
        weatherView: this.view!,
        materialFlowBuffer: buffer,
      });
    }
    return this.bindings;
  }

  destroy(): void {
    this.texture?.destroy();
    this.flow.destroy();
    this.texture = undefined;
    this.view = undefined;
    this.uploaded = undefined;
    this.source = undefined;
    this.bindings = undefined;
    this.width = 0;
    this.height = 0;
    this.vertical = undefined;
    this.layers = 0;
    this.populations = undefined;
  }
}
