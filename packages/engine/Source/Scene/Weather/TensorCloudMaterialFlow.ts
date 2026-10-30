import type { EnvironmentalTensorSet } from "./EnvironmentalTensorMap.js";
import type { CloudMaterialFlowField } from "./CloudMaterialFlow.js";

const TAU = Math.PI * 2;

function vectorAt(
  field: EnvironmentalTensorSet,
  x: number,
  y: number,
  result: Float64Array,
): void {
  const width = field.width,
    height = field.height;
  if (y < 0) {
    y = -y - 1;
    x += width / 2;
  }
  if (y >= height) {
    y = 2 * height - y - 1;
    x += width / 2;
  }
  const first = Math.floor(x),
    fraction = x - first;
  result.fill(0);
  for (let side = 0; side < 2; side++) {
    const ix = (((first + side) % width) + width) % width;
    const weight = side === 0 ? 1 - fraction : fraction;
    const index = (y * width + ix) * 4;
    const lon = ((ix + 0.5) / width - 0.5) * TAU;
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const east = (field.atmosphericBytes[index] / 255) * 120 - 60;
    const north = (field.atmosphericBytes[index + 1] / 255) * 120 - 60;
    result[0] +=
      weight * (-east * Math.sin(lon) - north * Math.sin(lat) * Math.cos(lon));
    result[1] +=
      weight * (east * Math.cos(lon) - north * Math.sin(lat) * Math.sin(lon));
    result[2] += weight * north * Math.cos(lat);
  }
}

export async function tensorCloudMaterialFlow(
  field: EnvironmentalTensorSet,
  timeMs: number,
  cancelled: () => boolean = () => false,
): Promise<CloudMaterialFlowField | undefined> {
  const { width, height } = field;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 1440 ||
    height > 721 ||
    field.atmosphericBytes.length !== width * height * 4 ||
    !Number.isSafeInteger(timeMs) ||
    Math.abs(timeMs) > 8e15
  ) {
    throw new RangeError("Invalid cloud wind tensor snapshot.");
  }
  const w = 64,
    h = 32;
  const velocity = new Float32Array(w * h * 4);
  const vectors = Array.from({ length: 4 }, () => new Float64Array(3));
  for (let y = 0; y < h; y++) {
    if (y % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled()) {
        return undefined;
      }
    }
    const sourceY = ((y + 0.5) / h) * height - 0.5;
    const y0 = Math.floor(sourceY),
      fy = sourceY - y0;
    for (let x = 0; x < w; x++) {
      const sourceX = ((x + 0.5) / w) * width - 0.5;
      const x0 = Math.floor(sourceX),
        fx = sourceX - x0;
      vectorAt(field, x0, y0, vectors[0]);
      vectorAt(field, x0 + 1, y0, vectors[1]);
      vectorAt(field, x0, y0 + 1, vectors[2]);
      vectorAt(field, x0 + 1, y0 + 1, vectors[3]);
      for (let axis = 0; axis < 3; axis++) {
        velocity[(y * w + x) * 4 + axis] =
          (vectors[0][axis] * (1 - fx) + vectors[1][axis] * fx) * (1 - fy) +
          (vectors[2][axis] * (1 - fx) + vectors[3][axis] * fx) * fy;
      }
    }
  }
  if (cancelled()) {
    return undefined;
  }
  // Surface winds provide no evidence of vertical shear.
  return {
    width: w,
    height: h,
    epochTimeMs: timeMs,
    timeMs,
    displacement: new Float32Array(w * h * 4),
    velocity,
  };
}
