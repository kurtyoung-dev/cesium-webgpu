const RADIUS = 6371008.8;
export const CLOUD_MATERIAL_FLOW_ALTITUDES = Object.freeze([
  0, 2000, 6000, 10000, 14000,
]);

export interface CloudMaterialFlowField {
  width: number;
  height: number;
  epochTimeMs: number;
  timeMs: number;
  altitudes?: Float32Array;
  // Surface front normal in ECEF, weighted by strength, followed by weighted width in metres.
  fronts?: Float32Array;
  // Layer-major global cell-centred grids, north to south, with four floats
  // per texel. Missing altitudes select the historical single-level field.
  // XYZ are ECEF displacement in metres and tangent velocity in metres/second;
  // W is reserved and zero. Displacement never contains an absolute position.
  displacement: Float32Array;
  velocity: Float32Array;
}

export function cloudMaterialFlowBytes(
  field: CloudMaterialFlowField | undefined,
): number {
  return field
    ? field.displacement.byteLength +
        field.velocity.byteLength +
        (field.altitudes?.byteLength ?? 0) +
        (field.fronts?.byteLength ?? 0)
    : 0;
}

export function validCloudMaterialFlow(
  field: unknown,
): field is CloudMaterialFlowField {
  const f = field as CloudMaterialFlowField | undefined;
  if (
    !f ||
    !Number.isInteger(f.width) ||
    f.width < 8 ||
    f.width > 128 ||
    !Number.isInteger(f.height) ||
    f.height < 4 ||
    f.height > 64 ||
    !Number.isSafeInteger(f.epochTimeMs) ||
    Math.abs(f.epochTimeMs) > 8e15 ||
    !Number.isSafeInteger(f.timeMs) ||
    f.timeMs < f.epochTimeMs ||
    f.timeMs - f.epochTimeMs > 168 * 3600000
  ) {
    return false;
  }
  if (
    f.altitudes !== undefined &&
    (!(f.altitudes instanceof Float32Array) ||
      f.altitudes.length < 2 ||
      f.altitudes.length > 8 ||
      !f.altitudes.every(
        (v, i, a) =>
          Number.isFinite(v) &&
          v >= 0 &&
          v <= 30000 &&
          (i === 0 || v > a[i - 1]),
      ))
  ) {
    return false;
  }
  const valid = (a: Float32Array, limit: number) =>
    a instanceof Float32Array &&
    a.length === f.width * f.height * (f.altitudes?.length ?? 1) * 4 &&
    a.every(
      (v, i) =>
        Number.isFinite(v) && (i % 4 === 3 ? v === 0 : Math.abs(v) <= limit),
    );
  return (
    valid(f.displacement, 2 * RADIUS + 1) &&
    valid(f.velocity, 4096) &&
    (f.fronts === undefined ||
      validCloudFrontField(f.fronts, f.width * f.height))
  );
}

export function validCloudFrontField(
  values: unknown,
  count: number,
): values is Float32Array {
  if (!(values instanceof Float32Array) || values.length !== count * 4) {
    return false;
  }
  for (let i = 0; i < values.length; i += 4) {
    const strength = Math.hypot(values[i], values[i + 1], values[i + 2]),
      width = values[i + 3];
    if (
      !Number.isFinite(strength) ||
      strength > 1.000001 ||
      !Number.isFinite(width) ||
      width < 0 ||
      width > 600000.01
    ) {
      return false;
    }
  }
  return true;
}

export function cloneCloudMaterialFlow(
  field: CloudMaterialFlowField,
): CloudMaterialFlowField {
  if (!validCloudMaterialFlow(field)) {
    throw new Error("Invalid cloud material flow field.");
  }
  return {
    ...field,
    displacement: field.displacement.slice(),
    velocity: field.velocity.slice(),
    ...(field.fronts ? { fronts: field.fronts.slice() } : {}),
    ...(field.altitudes ? { altitudes: field.altitudes.slice() } : {}),
  };
}

function sample(
  a: Float32Array,
  channel: number,
  x: number,
  y: number,
  width: number,
  height: number,
  offset = 0,
): number {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    fx = x - x0,
    fy = y - y0;
  const at = (xx: number, yy: number) => {
    if (yy < 0) {
      yy = -yy - 1;
      xx += width / 2;
    }
    if (yy >= height) {
      yy = 2 * height - yy - 1;
      xx += width / 2;
    }
    const ix = Math.floor(xx),
      fraction = xx - ix,
      left = ((ix % width) + width) % width;
    return (
      a[offset + (yy * width + left) * 4 + channel] * (1 - fraction) +
      a[offset + (yy * width + ((left + 1) % width)) * 4 + channel] * fraction
    );
  };
  return (
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  );
}

function sampleLevel(
  a: Float32Array,
  channel: number,
  x: number,
  y: number,
  width: number,
  height: number,
  altitudes: Float32Array | undefined,
  altitude: number,
): number {
  let upper = altitudes ? 1 : 0;
  while (
    altitudes &&
    upper < altitudes.length - 1 &&
    altitude > altitudes[upper]
  ) {
    upper++;
  }
  const lower = altitudes ? upper - 1 : 0;
  const weight = altitudes
    ? Math.max(
        0,
        Math.min(
          1,
          (altitude - altitudes[lower]) / (altitudes[upper] - altitudes[lower]),
        ),
      )
    : 0;
  const stride = width * height * 4;
  const at = (level: number) => {
    const offset = level * stride;
    if (y >= 0 && y <= height - 1) {
      return sample(a, channel, x, y, width, height, offset);
    }
    // Close the interpolated material map with one longitude-independent pole value.
    const row = y < 0 ? 0 : height - 1;
    const blend = Math.max(
      0,
      Math.min(1, y < 0 ? 2 * y + 1 : 1 - 2 * (y - row)),
    );
    let sum = 0;
    for (let column = 0; column < width; column++) {
      sum += a[offset + (row * width + column) * 4 + channel];
    }
    return (
      Math.fround(sum / width) * (1 - blend) +
      sample(a, channel, x, row, width, height, offset) * blend
    );
  };
  return at(lower) * (1 - weight) + at(upper) * weight;
}

export function sampleCloudMaterialFlow(
  field: CloudMaterialFlowField,
  lon: number,
  lat: number,
  displacement: Float64Array,
  velocity: Float64Array,
  altitude = 0,
): void {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(altitude) ||
    Math.abs(lat) > Math.PI / 2
  ) {
    throw new Error("Invalid cloud material flow coordinates.");
  }
  const x = ((lon + Math.PI) / (2 * Math.PI)) * field.width - 0.5;
  const y = (0.5 - lat / Math.PI) * field.height - 0.5;
  for (let channel = 0; channel < 3; channel++) {
    displacement[channel] = sampleLevel(
      field.displacement,
      channel,
      x,
      y,
      field.width,
      field.height,
      field.altitudes,
      altitude,
    );
    velocity[channel] = sampleLevel(
      field.velocity,
      channel,
      x,
      y,
      field.width,
      field.height,
      field.altitudes,
      altitude,
    );
  }
}

export class CloudMaterialFlow {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly altitudes?: Float32Array;
  private displacement: Float32Array;
  private next: Float32Array;
  private velocity: Float32Array;
  readonly fronts?: Float32Array;

  constructor(
    width: number,
    height: number,
    displacement?: Float32Array,
    layered = false,
    fronts = false,
  ) {
    this.width = Math.min(128, width);
    this.height = Math.min(64, height);
    if (
      !Number.isInteger(this.width) ||
      this.width < 8 ||
      !Number.isInteger(this.height) ||
      this.height < 4
    ) {
      throw new Error("Invalid cloud material flow grid.");
    }
    if (layered) {
      this.altitudes = Float32Array.from(CLOUD_MATERIAL_FLOW_ALTITUDES);
    }
    this.count = this.width * this.height * (this.altitudes?.length ?? 1);
    if (
      displacement &&
      (!(displacement instanceof Float32Array) ||
        displacement.length !== this.count * 4 ||
        !displacement.every(
          (v, i) =>
            Number.isFinite(v) &&
            (i % 4 === 3 ? v === 0 : Math.abs(v) <= 2 * RADIUS + 1),
        ))
    ) {
      throw new Error("Invalid cloud material flow checkpoint.");
    }
    this.displacement =
      displacement?.slice() ?? new Float32Array(this.count * 4);
    this.next = new Float32Array(this.count * 4);
    this.velocity = new Float32Array(this.count * 4);
    if (fronts) {
      this.fronts = new Float32Array(this.width * this.height * 4);
    }
  }

  writeCell(i: number, east: number, north: number, seconds: number): void {
    const spatial = i % (this.width * this.height);
    const offset = (i - spatial) * 4;
    const lon =
      ((((spatial % this.width) + 0.5) / this.width) * 2 - 1) * Math.PI;
    const lat =
      (0.5 - (Math.floor(spatial / this.width) + 0.5) / this.height) * Math.PI;
    const cl = Math.cos(lon),
      sl = Math.sin(lon),
      cp = Math.cos(lat),
      sp = Math.sin(lat);
    const px = cp * cl,
      py = cp * sl,
      pz = sp;
    const vx = -east * sl - north * sp * cl,
      vy = east * cl - north * sp * sl,
      vz = north * cp;
    const index = i * 4;
    this.velocity[index] = vx;
    this.velocity[index + 1] = vy;
    this.velocity[index + 2] = vz;
    if (seconds === 0) {
      return;
    }
    const speed = Math.hypot(east, north);
    if (speed === 0) {
      for (let channel = 0; channel < 3; channel++) {
        this.next[index + channel] = this.displacement[index + channel];
      }
      return;
    }
    const angle = (speed * seconds) / RADIUS,
      ca = Math.cos(angle),
      sa = Math.sin(angle) / speed;
    const qx = ca * px - sa * vx,
      qy = ca * py - sa * vy,
      qz = ca * pz - sa * vz;
    const x =
      ((Math.atan2(qy, qx) + Math.PI) / (2 * Math.PI)) * this.width - 0.5;
    const y =
      (0.5 - Math.asin(Math.max(-1, Math.min(1, qz))) / Math.PI) * this.height -
      0.5;
    // Backtrace the previous material map, then put its origin back on the
    // reference sphere. This avoids radial drift from bilinear interpolation.
    const mx =
      RADIUS * qx +
      sample(this.displacement, 0, x, y, this.width, this.height, offset);
    const my =
      RADIUS * qy +
      sample(this.displacement, 1, x, y, this.width, this.height, offset);
    const mz =
      RADIUS * qz +
      sample(this.displacement, 2, x, y, this.width, this.height, offset);
    const length = Math.hypot(mx, my, mz);
    const scale = length > 1 ? RADIUS / length : 0;
    this.next[index] = (scale ? mx * scale : RADIUS * qx) - RADIUS * px;
    this.next[index + 1] = (scale ? my * scale : RADIUS * qy) - RADIUS * py;
    this.next[index + 2] = (scale ? mz * scale : RADIUS * qz) - RADIUS * pz;
  }

  sampleVelocity(
    lon: number,
    lat: number,
    altitude: number,
    result: Float64Array,
  ): void {
    const x = ((lon + Math.PI) / (2 * Math.PI)) * this.width - 0.5;
    const y = (0.5 - lat / Math.PI) * this.height - 0.5;
    for (let channel = 0; channel < 3; channel++) {
      result[channel] = sampleLevel(
        this.velocity,
        channel,
        x,
        y,
        this.width,
        this.height,
        this.altitudes,
        altitude,
      );
    }
  }

  advance(): void {
    [this.displacement, this.next] = [this.next, this.displacement];
  }

  checkpoint(): Float32Array {
    return this.displacement.slice();
  }

  field(epochTimeMs: number, timeMs: number): CloudMaterialFlowField {
    return {
      width: this.width,
      height: this.height,
      epochTimeMs,
      timeMs,
      displacement: this.displacement.slice(),
      velocity: this.velocity.slice(),
      ...(this.fronts ? { fronts: this.fronts.slice() } : {}),
      ...(this.altitudes ? { altitudes: this.altitudes.slice() } : {}),
    };
  }
}
