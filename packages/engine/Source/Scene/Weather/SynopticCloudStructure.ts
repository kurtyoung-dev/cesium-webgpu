// Coherent cloud structure uses a spherical domain so its detail has no
// longitude seam or camera-dependent tangent frame.
const TAU = Math.PI * 2;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => value * value * (3 - 2 * value);
const mix = (a: number, b: number, weight: number): number =>
  a + (b - a) * weight;

function hash(x: number, y: number, z: number, seed: number): number {
  let value =
    Math.imul(x, 0x1f123bb5) ^
    Math.imul(y, 0x5f356495) ^
    Math.imul(z, 0x6c8e9cf5) ^
    seed;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const u = smooth(x - ix),
    v = smooth(y - iy),
    w = smooth(z - iz);
  return mix(
    mix(
      mix(hash(ix, iy, iz, seed), hash(ix + 1, iy, iz, seed), u),
      mix(hash(ix, iy + 1, iz, seed), hash(ix + 1, iy + 1, iz, seed), u),
      v,
    ),
    mix(
      mix(hash(ix, iy, iz + 1, seed), hash(ix + 1, iy, iz + 1, seed), u),
      mix(
        hash(ix, iy + 1, iz + 1, seed),
        hash(ix + 1, iy + 1, iz + 1, seed),
        u,
      ),
      v,
    ),
    w,
  );
}

export class SynopticCloudStructure {
  private readonly _seed: number;
  private readonly _rotation: number;
  private readonly _evolution: number;

  constructor(phase: number, days: number) {
    this._seed = Math.floor((phase / TAU) * 4294967295) | 0;
    this._rotation = (days * 0.04 + phase) % TAU;
    this._evolution = days * 0.22;
  }

  sample(
    longitude: number,
    latitude: number,
  ): { regional: number; cellular: number } {
    const cosine = Math.abs(latitude) >= Math.PI / 2 ? 0 : Math.cos(latitude);
    const angle = longitude - this._rotation;
    const x = cosine * Math.cos(angle),
      y = cosine * Math.sin(angle),
      z = Math.sin(latitude);
    const large = noise(x * 12 + this._evolution, y * 12, z * 12, this._seed);
    const middle = noise(
      x * 32,
      y * 32 + this._evolution * 1.7,
      z * 32,
      this._seed ^ 0x61c88647,
    );
    const fine = noise(
      x * 80,
      y * 80,
      z * 80 + this._evolution * 2.9,
      this._seed ^ 0x27d4eb2d,
    );
    return {
      regional: clamp01(large * 0.6 + middle * 0.3 + fine * 0.1),
      cellular: clamp01(middle * 0.6 + fine * 0.4),
    };
  }
}
