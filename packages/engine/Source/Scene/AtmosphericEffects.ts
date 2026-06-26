/**
 * Atmospheric effects — Phase A: a backend-agnostic mapper from weather
 * CONDITIONS (humidity, air quality, temperature, dew point, visibility) to the
 * Scene's existing visual KNOBS (fog density, atmosphere saturation/brightness
 * shift, cloud genus bias). Cheapest, highest realism-per-effort tier of the
 * atmospheric-effects roadmap (migration_doc/ATMOSPHERIC_EFFECTS_ROADMAP.md).
 *
 * `computeAtmosphericKnobs` is a PURE function (no Scene import) so it is unit-
 * testable; `applyAtmosphericConditions` reads
 * `scene.globe.atmosphericConditions.weather` and writes the knobs. Whether a
 * given backend RENDERS each knob is separate, pre-existing functionality — this
 * module only maps conditions → knob values. Later phases add screen-space
 * effects (heat shimmer, ground fog, cold optics).
 *
 * @module Scene/AtmosphericEffects
 */
import CloudType from "./CloudType.js";

/** Weather conditions consumed by the mapper. All optional → sensible defaults. */
export interface AtmosphericConditionsInput {
  /** 0 = dry desert … 0.5 = neutral … 1 = saturated. */
  humidity?: number;
  /** 1 = clean, <1 = dust/haze, >1 = very clean. */
  airQuality?: number;
  /** Air temperature, °C. */
  temperatureC?: number;
  /** Dew point, °C (the temperature−dewpoint spread drives fog). */
  dewpointC?: number;
  /** Optional explicit horizontal visibility, km (low → more fog). */
  visibilityKm?: number;
}

/** The Scene knobs the mapper produces. */
export interface AtmosphericKnobs {
  /** `scene.fog.density`. */
  fogDensity: number;
  /** `globe.atmosphereSaturationShift` in [-1, 1] (haze desaturates; crisp saturates). */
  atmosphereSaturationShift: number;
  /** `globe.atmosphereBrightnessShift` in [-1, 1]. */
  atmosphereBrightnessShift: number;
  /** `globe.cloudType` genus bias (CloudType index), or undefined for no bias. */
  cloudType: number | undefined;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Map weather conditions to visual knobs. Pure + deterministic.
 *
 * Behaviour: warm/moist or dusty air → denser fog, desaturated + slightly dimmer
 * sky (milky haze), and a stratus genus bias when the dew-point spread is small;
 * cold + dry air → minimal fog and a saturated (deep-blue), slightly brighter
 * sky. Neutral defaults (humidity 0.5, airQuality 1, 15 °C / 5 °C) → near-zero
 * shifts so the change is invisible until conditions are set.
 *
 * @param input The conditions.
 * @returns The knob values.
 */
export function computeAtmosphericKnobs(
  input: AtmosphericConditionsInput = {},
): AtmosphericKnobs {
  const humidity = input.humidity ?? 0.5;
  const airQuality = input.airQuality ?? 1.0;
  const tempC = input.temperatureC ?? 15.0;
  const dewC = input.dewpointC ?? 5.0;
  const spread = Math.max(0, tempC - dewC); // dew-point depression, °C

  // Haze: humidity above neutral, plus reduced air quality (dust).
  const haze =
    clamp((humidity - 0.5) * 2.0, 0, 1) * 0.7 +
    clamp(1 - airQuality, 0, 1) * 0.3;
  // Dryness / coldness drive the crisp deep-blue look.
  const dry = clamp((0.5 - humidity) * 2.0, 0, 1);
  const cold = clamp((10 - tempC) / 30, 0, 1);
  // Fog forms as the dew-point spread closes (near-surface saturation).
  const fogFromSpread = clamp((4.0 - spread) / 4.0, 0, 1);
  const visFog =
    input.visibilityKm !== undefined
      ? clamp((10 - input.visibilityKm) / 10, 0, 1)
      : 0;

  const BASE_FOG = 0.0001;
  const fogDensity = clamp(
    BASE_FOG * (1.0 + haze * 4.0) + fogFromSpread * 0.0006 + visFog * 0.0006,
    0,
    0.002,
  );

  const atmosphereSaturationShift = clamp(
    -haze * 0.4 + dry * cold * 0.3,
    -1,
    1,
  );
  const atmosphereBrightnessShift = clamp(
    -haze * 0.12 + dry * cold * 0.05,
    -1,
    1,
  );

  // Genus bias: moist air near saturation reads as a low stratus/fog deck.
  const cloudType: number | undefined =
    haze > 0.55 && fogFromSpread > 0.4 ? CloudType.STRATUS : undefined;

  return {
    fogDensity,
    atmosphereSaturationShift,
    atmosphereBrightnessShift,
    cloudType,
  };
}

/** Minimal structural view of the parts of Scene the mapper writes. */
interface AtmosphericSceneLike {
  fog?: { density: number };
  globe?: {
    atmosphereSaturationShift?: number;
    atmosphereBrightnessShift?: number;
    cloudType?: number;
    atmosphericConditions?: {
      weather?: {
        humidity?: number;
        airQuality?: number;
        temperature?: number;
        dewpoint?: number;
      };
    };
  };
}

/**
 * Read the scene's weather conditions and apply the mapped knobs. Call it when
 * the conditions change (e.g. after a weather ingest, or a UI slider). No-op if
 * the weather facade isn't built yet.
 *
 * @param scene The Cesium Scene.
 */
export function applyAtmosphericConditions(scene: AtmosphericSceneLike): void {
  const weather = scene?.globe?.atmosphericConditions?.weather;
  if (weather === undefined) {
    return;
  }
  const knobs = computeAtmosphericKnobs({
    humidity: weather.humidity,
    airQuality: weather.airQuality,
    temperatureC: weather.temperature,
    dewpointC: weather.dewpoint,
  });
  if (scene.fog) {
    scene.fog.density = knobs.fogDensity;
  }
  const globe = scene.globe;
  if (globe) {
    globe.atmosphereSaturationShift = knobs.atmosphereSaturationShift;
    globe.atmosphereBrightnessShift = knobs.atmosphereBrightnessShift;
    if (knobs.cloudType !== undefined) {
      globe.cloudType = knobs.cloudType;
    }
  }
}
