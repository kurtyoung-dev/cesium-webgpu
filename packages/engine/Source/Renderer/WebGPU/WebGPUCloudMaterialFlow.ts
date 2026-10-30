import JulianDate from "../../Core/JulianDate.js";
export type { CloudMaterialFlowField } from "../../Scene/Weather/CloudMaterialFlow.js";
import {
  validCloudMaterialFlow,
  type CloudMaterialFlowField,
} from "../../Scene/Weather/CloudMaterialFlow.js";

function isJulianDateParts(
  value: unknown,
): value is { dayNumber: number; secondsOfDay: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "dayNumber" in value &&
    "secondsOfDay" in value &&
    typeof value.dayNumber === "number" &&
    typeof value.secondsOfDay === "number"
  );
}

export class CloudMaterialFlowResources {
  buffer: GPUBuffer | null = null;
  source: CloudMaterialFlowField | undefined;
  bytes = 0;
  private retired: GPUBuffer[] = [];
  private frame = -1;
  private epoch: JulianDate | undefined;
  private epochSource: CloudMaterialFlowField | undefined;

  /**
   * The flow field's age at `time`, in seconds, bounded to +/-900. `time` is
   * the frame's Julian date, which the frame state types opaquely; anything
   * that is not one gives 0.
   */
  ageSeconds(field: CloudMaterialFlowField | undefined, time: unknown): number {
    if (this.epochSource !== field) {
      this.epochSource = field;
      this.epoch = field
        ? JulianDate.fromDate(new Date(field.timeMs))
        : undefined;
    }
    if (
      !this.epoch ||
      !isJulianDateParts(time) ||
      !Number.isFinite(time.dayNumber) ||
      !Number.isFinite(time.secondsOfDay)
    ) {
      return 0;
    }
    return Math.max(
      -900,
      Math.min(
        900,
        (time.dayNumber - this.epoch.dayNumber) * 86400 +
          time.secondsOfDay -
          this.epoch.secondsOfDay,
      ),
    );
  }

  prepare(
    device: GPUDevice,
    field: CloudMaterialFlowField | undefined,
    frame: number,
  ): GPUBuffer {
    if (frame !== this.frame) {
      for (const buffer of this.retired) {
        buffer.destroy();
      }
      this.retired.length = 0;
      this.frame = frame;
    }
    if (this.buffer && this.source === field) {
      return this.buffer;
    }
    if (field && !validCloudMaterialFlow(field)) {
      throw new Error("Invalid cloud material flow snapshot.");
    }
    const count = field ? field.width * field.height : 0;
    const levels = field?.altitudes?.length ?? 1;
    const packed = new ArrayBuffer(
      16 + (field ? (count + 2) * levels : 1) * 32,
    );
    new Uint32Array(packed, 0, 4).set([
      field?.width ?? 0,
      field?.height ?? 0,
      count,
      field?.altitudes?.length ?? 0,
    ]);
    const values = new Float32Array(packed, 16);
    if (field) {
      for (let level = 0; level < levels; level++) {
        const source = level * count * 4,
          target = level * (count + 2) * 8;
        for (let i = 0; i < count; i++) {
          values.set(
            field.displacement.subarray(source + i * 4, source + i * 4 + 4),
            target + i * 8,
          );
          values.set(
            field.velocity.subarray(source + i * 4, source + i * 4 + 4),
            target + i * 8 + 4,
          );
        }
        values[target + count * 8 + 3] = field.altitudes?.[level] ?? 0;
        for (let pole = 0; pole < 2; pole++) {
          for (let axis = 0; axis < 3; axis++) {
            let displacement = 0,
              velocity = 0;
            const row = pole === 0 ? 0 : field.height - 1;
            for (let x = 0; x < field.width; x++) {
              displacement +=
                field.displacement[source + (row * field.width + x) * 4 + axis];
              velocity +=
                field.velocity[source + (row * field.width + x) * 4 + axis];
            }
            values[target + (count + pole) * 8 + axis] =
              displacement / field.width;
            values[target + (count + pole) * 8 + 4 + axis] =
              velocity / field.width;
          }
        }
      }
    }
    const buffer = device.createBuffer({
      label: "Cloud geographic material flow",
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    try {
      device.queue.writeBuffer(buffer, 0, packed);
    } catch (error) {
      buffer.destroy();
      throw error;
    }
    // Earlier prepared views may still reference this frame's previous snapshot.
    if (this.buffer) {
      this.retired.push(this.buffer);
    }
    this.buffer = buffer;
    this.source = field;
    this.bytes = packed.byteLength;
    return buffer;
  }

  destroy(): void {
    this.buffer?.destroy();
    for (const buffer of this.retired) {
      buffer.destroy();
    }
    this.buffer = null;
    this.source = undefined;
    this.bytes = 0;
    this.retired.length = 0;
    this.frame = -1;
    this.epoch = undefined;
    this.epochSource = undefined;
  }
}
