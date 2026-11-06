import createTaskProcessorWorker from "./createTaskProcessorWorker.js";
import { generateSynopticWeatherField } from "../Scene/Weather/SynopticWeatherField.js";
import { packWeatherFieldDetailed } from "../Scene/Weather/WeatherTexPacker.js";
import { tensorCloudMaterialFlow } from "../Scene/Weather/TensorCloudMaterialFlow.js";

async function createCloudWeather(parameters, transferableObjects) {
  let result;
  const buffers = [];
  if (parameters.kind === "synoptic") {
    result = await generateSynopticWeatherField(
      parameters.seed,
      parameters.width,
      parameters.height,
      parameters.timeMs,
      () => false,
      false,
      parameters.independentCloudLayers === true,
    );
    for (const name of [
      "coverage",
      "type",
      "baseMeters",
      "topMeters",
      "densityBias",
    ]) {
      buffers.push(result[name].buffer);
    }
    for (const layer of result.layers ?? []) {
      for (const name of [
        "coverage",
        "type",
        "baseMeters",
        "topMeters",
        "densityBias",
      ]) {
        if (layer[name]) {
          buffers.push(layer[name].buffer);
        }
      }
    }
    buffers.push(
      result.environmentalTensors.atmosphericBytes.buffer,
      result.environmentalTensors.marineBytes.buffer,
    );
  } else if (parameters.kind === "pack") {
    result = packWeatherFieldDetailed(
      parameters.field,
      parameters.width,
      parameters.height,
      parameters.options,
    );
    buffers.push(result.bytes.buffer);
    if (result.vertical) {
      buffers.push(result.vertical.bytes.buffer);
    }
    if (result.layers) {
      buffers.push(result.layers.bytes.buffer);
    }
  } else if (parameters.kind === "flow") {
    result = await tensorCloudMaterialFlow(
      parameters.field,
      parameters.timeMs,
      () => false,
      false,
    );
    buffers.push(result.displacement.buffer, result.velocity.buffer);
  } else {
    throw new Error("Unknown cloud weather task.");
  }
  transferableObjects.push(...new Set(buffers));
  return result;
}

export default createTaskProcessorWorker(createCloudWeather);
