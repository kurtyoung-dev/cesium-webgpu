// A bounded kinematic weather model: pressure systems, frontal cloud bands and
// seasonal circulation share geographic coordinates and a reproducible seed.
// It supplies plausible procedural structure rather than a numerical forecast.
export interface SynopticWeatherSample {
  coverage: number;
  cloudType: number;
  baseMeters: number;
  densityBias: number;
  pressureHpa: number;
  windU: number;
  windV: number;
  temperatureC: number;
  precipitation: number;
}

interface PressureSystem {
  longitude: number;
  sinLatitude: number;
  cosLatitude: number;
  radius: number;
  strength: number;
  hemisphere: number;
}

const TAU = Math.PI * 2;
const DAY_MS = 86400000;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function seededRandom(seed: string | number): () => number {
  const text = String(seed);
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state = Math.imul(state ^ text.charCodeAt(i), 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export class SynopticWeatherPattern {
  private readonly _systems: PressureSystem[] = [];
  private readonly _season: number;
  private readonly _tropicalLatitude: number;
  private readonly _phase: number;

  constructor(seed: string | number, timeMs: number) {
    if (
      !Number.isFinite(timeMs) ||
      !Number.isFinite(new Date(timeMs).getTime())
    ) {
      throw new RangeError(
        "Weather time must be a valid finite UTC timestamp.",
      );
    }
    const date = new Date(timeMs);
    const day = (timeMs - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS;
    this._season = Math.sin((TAU * (day - 80)) / 365.2425);
    this._tropicalLatitude = 0.12 * this._season;
    const random = seededRandom(seed);
    this._phase = random() * TAU;
    // A fixed epoch avoids camera/session-dependent weather. Each system moves
    // and waxes smoothly; crossing midnight never reseeds the field.
    const days = (timeMs - 946728000000) / DAY_MS;
    for (const hemisphere of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const low = i < 4;
        const phase = random() * TAU;
        const speed = low
          ? 0.018 + random() * 0.016
          : -0.003 + random() * 0.006;
        const longitude =
          -Math.PI + ((i % 4) * TAU) / 4 + phase * 0.35 + days * speed;
        const latitude =
          hemisphere *
          ((low ? 0.78 : 0.48) -
            hemisphere * this._season * 0.07 +
            Math.sin(phase + days * 0.13) * 0.08);
        const life =
          0.55 + 0.45 * Math.sin(days * (0.3 + random() * 0.2) + phase) ** 2;
        this._systems.push({
          longitude: longitude % TAU,
          sinLatitude: Math.sin(latitude),
          cosLatitude: Math.cos(latitude),
          radius: low ? 0.19 + random() * 0.09 : 0.28 + random() * 0.12,
          strength:
            (low ? -28 : 19) * life * (1 - hemisphere * this._season * 0.15),
          hemisphere,
        });
      }
    }
  }

  sample(longitude: number, latitude: number): SynopticWeatherSample {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new RangeError("Weather coordinates must be finite radians.");
    }
    latitude = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latitude));
    longitude = ((((longitude + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    const sinLat = Math.sin(latitude),
      cosLat = Math.cos(latitude);
    const tropicalDistance = (latitude - this._tropicalLatitude) / 0.12;
    const tropical =
      Math.exp(-tropicalDistance * tropicalDistance) *
      (0.5 +
        0.5 *
          cosLat *
          cosLat *
          Math.sin(longitude * 3 + this._phase + sinLat * 7) ** 2);
    const dryBelt = Math.exp(
      -(
        ((Math.abs(latitude - this._tropicalLatitude * 0.3) - 0.49) / 0.16) **
        2
      ),
    );
    const absoluteLatitude = Math.abs(latitude);
    let windU =
      absoluteLatitude < Math.PI / 6
        ? -8 * Math.cos(absoluteLatitude * 3)
        : absoluteLatitude < Math.PI / 3
          ? 14 * Math.sin((absoluteLatitude - Math.PI / 6) * 6)
          : -6 * Math.sin((absoluteLatitude - Math.PI / 3) * 3);
    let windV = -Math.sign(latitude - this._tropicalLatitude) * tropical * 3;
    let pressure = 1013.25 + dryBelt * 7 - tropical * 5;
    let front = 0,
      head = 0,
      suppression = 0;
    for (const system of this._systems) {
      const delta = longitude - system.longitude;
      const cosDelta = Math.cos(delta);
      const facing =
        sinLat * system.sinLatitude + cosLat * system.cosLatitude * cosDelta;
      if (facing < 0.5) {
        continue;
      }
      // Tangent coordinates are bounded offsets about each geographic system,
      // independent of the camera and continuous across the antimeridian.
      const x = (cosLat * Math.sin(delta)) / system.radius;
      const y =
        (sinLat * system.cosLatitude - cosLat * system.sinLatitude * cosDelta) /
        system.radius;
      const q = x * x + y * y;
      const gaussian = Math.exp(-q * 0.5);
      pressure += system.strength * gaussian;
      const rotation = -system.hemisphere * system.strength * gaussian * 0.6;
      windU -= rotation * y;
      windV += rotation * x;
      if (system.strength < 0) {
        const along = y * system.hemisphere;
        const coldDistance = x + 0.35 * along + 0.18 * along * along;
        const cold = Math.exp(
          (-coldDistance * coldDistance) / 0.08 - ((along + 1.1) / 1.8) ** 4,
        );
        const warmDistance = along - 0.5 + 0.17 * (x - 0.8) ** 2;
        const warm = Math.exp(
          (-warmDistance * warmDistance) / 0.18 - ((x - 0.7) / 1.8) ** 4,
        );
        const strength = Math.min(1, -system.strength / 22);
        front = Math.max(front, (cold * 0.92 + warm * 0.75) * strength);
        const comma =
          Math.exp(-(((Math.sqrt(q) - 0.9) / 0.5) ** 2)) *
          clamp01(0.7 + along * 0.4 - x * 0.2);
        head = Math.max(head, comma * strength);
      } else {
        suppression = Math.max(suppression, (gaussian * system.strength) / 24);
      }
    }
    const surfaceX = cosLat * Math.cos(longitude),
      surfaceY = cosLat * Math.sin(longitude);
    const cellular =
      0.5 +
      0.5 *
        Math.sin(surfaceX * 11 + sinLat * 31 + this._phase) *
        Math.sin(surfaceY * 7 - sinLat * 23);
    const background = (0.1 + cellular * 0.25) * (1 - dryBelt * 0.8);
    const coverage = clamp01(
      (1 -
        (1 - background) *
          (1 - tropical * 0.75) *
          (1 - Math.min(0.96, front)) *
          (1 - head * 0.7)) *
        (1 - clamp01(suppression) * 0.85),
    );
    // Local east/north components are not uniquely defined at the poles.
    windU *= cosLat;
    windV *= cosLat;
    return {
      coverage,
      cloudType: front > 0.45 ? 6 : tropical > 0.55 ? 10 : head > 0.35 ? 4 : 8,
      baseMeters: front > 0.45 ? 1100 : tropical > 0.55 ? 1600 : 1800,
      densityBias: clamp01(0.45 + front * 0.25 + tropical * 0.1),
      pressureHpa: Math.max(930, Math.min(1060, pressure)),
      windU,
      windV,
      temperatureC:
        28 * cosLat -
        35 * sinLat * sinLat +
        12 * this._season * sinLat -
        front * 5,
      precipitation: clamp01((front - 0.3) * 1.2 + tropical * 0.4),
    };
  }
}
