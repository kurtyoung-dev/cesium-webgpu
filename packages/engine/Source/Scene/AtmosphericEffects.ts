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

/**
 * Precipitation genus index used by the unified effects hierarchy
 * (`atmosphericConditions.effects.precipitation.type`). This is the SINGLE
 * canonical index→string mapping for precipitation across the fork — both the
 * 417a auto-master (this module) and the WebGPU weather-particle dispatch route
 * through {@link precipitationTypeToString} so the string the renderer's
 * `WEATHER_TYPES` table consumes is defined in one place.
 *
 * `NONE = 0` is first so a default-constructed effects leaf (`type: 0`) reads as
 * "no precipitation". The remaining order matches the renderer's particle
 * profiles (rain / snow / fog / hail).
 *
 * Note: this is DISTINCT from the legacy flat `scene.weatherType` convention
 * (`0=rain, 1=snow, 2=fog, 3=hail`), which predates the hierarchy and has no
 * `none` slot. {@link weatherTypeIndexToPrecipitationType} bridges the two so
 * the manual facade path (`scene.weatherType`) and the auto path stay in sync.
 *
 * @enum {number}
 */
export const PrecipitationType = {
  NONE: 0,
  RAIN: 1,
  SNOW: 2,
  FOG: 3,
  HAIL: 4,
} as const;

/** The particle-type string the WebGPU weather renderer's `WEATHER_TYPES` consumes. */
export type WeatherTypeString = "rain" | "snow" | "fog" | "hail";

const PRECIP_STRINGS: readonly (WeatherTypeString | "none")[] = [
  "none",
  "rain",
  "snow",
  "fog",
  "hail",
];

/**
 * Map a {@link PrecipitationType} index to the renderer's particle-type string.
 * Out-of-range / `NONE` → `"none"` (the renderer treats anything that isn't a
 * known particle type as disabled). This is the ONE place the index→string
 * mapping lives.
 *
 * @param type A {@link PrecipitationType} index.
 * @returns The lowercase particle-type string.
 */
export function precipitationTypeToString(
  type: number,
): WeatherTypeString | "none" {
  return PRECIP_STRINGS[type] ?? "none";
}

/**
 * Bridge the legacy flat `scene.weatherType` index (`0=rain, 1=snow, 2=fog,
 * 3=hail`) into a {@link PrecipitationType} index (`0=none, 1=rain, …`). Used by
 * the auto-master so the conditions passthrough writes the hierarchy leaf in the
 * hierarchy's own convention rather than the legacy one.
 *
 * @param weatherTypeIndex The legacy `scene.weatherType` value.
 * @returns The equivalent {@link PrecipitationType} index.
 */
export function weatherTypeIndexToPrecipitationType(
  weatherTypeIndex: number | undefined,
): number {
  // rain(0)→RAIN(1), snow(1)→SNOW(2), fog(2)→FOG(3), hail(3)→HAIL(4).
  const idx = (weatherTypeIndex ?? 0) + 1;
  return idx >= PrecipitationType.RAIN && idx <= PrecipitationType.HAIL
    ? idx
    : PrecipitationType.NONE;
}

/**
 * Inverse of {@link weatherTypeIndexToPrecipitationType}: map a
 * {@link PrecipitationType} index back to the legacy flat `scene.weatherType`
 * index the renderer-dispatch + facade consume. `NONE` clamps to `rain(0)` (the
 * flat field has no "none" — the separate `scene.enableWeather` flag carries
 * on/off), so callers MUST gate on `enabled` independently.
 *
 * @param precipType A {@link PrecipitationType} index.
 * @returns The legacy `scene.weatherType` index (0=rain … 3=hail).
 */
export function precipitationTypeToWeatherTypeIndex(
  precipType: number,
): number {
  const idx = precipType - 1;
  return idx >= 0 && idx <= 3 ? idx : 0;
}

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
  /** Optional precipitation type index (0 = none) — passed through to effects. */
  precipType?: number;
  /** Optional precipitation intensity 0..1 — passed through to effects. */
  precipIntensity?: number;
}

/**
 * Per-effect state the unified hierarchy derives from the conditions (Phase B+).
 * Mirrors `atmosphericConditions.effects.*`. Only `shimmer` has a backend today
 * (the WebGPU heat-shimmer post-process); `groundFog`/`optics`/`precipitation`
 * are scaffolds the later phases consume.
 */
export interface AtmosphericEffectState {
  /** Heat-haze screen-space warp (Phase B). */
  shimmer: { enabled: boolean; intensity: number };
  /** Low-altitude mist (Phase C). */
  groundFog: { enabled: boolean; intensity: number };
  /** Cold-air ice-crystal sky overlay (Phase D). */
  optics: { enabled: boolean; halo: number };
  /** Rain/snow/hail (Phase E). */
  precipitation: { enabled: boolean; type: number; intensity: number };
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

/**
 * Derive the per-effect state from the conditions — the brain behind the
 * `effects.auto` master. Pure + deterministic. Thresholds:
 *   - shimmer    : ramps in 25 °C → 45 °C (hot-ground heat haze).
 *   - groundFog  : a closing temperature−dewpoint spread (≤4 °C) in humid air.
 *   - optics     : sub-freezing, 0 °C → −15 °C (ice-crystal halos).
 *   - precipitation: pass-through of the weather precip type / intensity.
 *
 * @param input The conditions.
 * @returns The per-effect enabled + intensity values.
 */
export function computeAtmosphericEffects(
  input: AtmosphericConditionsInput = {},
): AtmosphericEffectState {
  const tempC = input.temperatureC ?? 15.0;
  const dewC = input.dewpointC ?? 5.0;
  const humidity = input.humidity ?? 0.5;
  const spread = Math.max(0, tempC - dewC);

  const shimmer = clamp((tempC - 25.0) / 20.0, 0, 1); // 25 → 45 °C
  const fog =
    clamp((4.0 - spread) / 4.0, 0, 1) * clamp((humidity - 0.4) / 0.6, 0, 1);
  const cold = clamp(-tempC / 15.0, 0, 1); // 0 → −15 °C
  const precipIntensity = clamp(input.precipIntensity ?? 0, 0, 1);
  // `input.precipType` arrives in the legacy flat `scene.weatherType` convention
  // (0=rain, 1=snow, 2=fog, 3=hail); the hierarchy leaf carries the
  // PrecipitationType convention (0=none, 1=rain, …) so its `type` is
  // self-describing. When there's no precip the leaf reads NONE.
  const precipEnabled = precipIntensity > 0;
  const precipType = precipEnabled
    ? weatherTypeIndexToPrecipitationType(input.precipType)
    : PrecipitationType.NONE;

  return {
    shimmer: { enabled: shimmer > 0.001, intensity: shimmer },
    groundFog: { enabled: fog > 0.05, intensity: fog },
    optics: { enabled: cold > 0.001, halo: cold },
    precipitation: {
      enabled: precipEnabled,
      type: precipType,
      intensity: precipIntensity,
    },
  };
}

/** Minimal structural view of the parts of Scene the mapper writes. */
interface AtmosphericSceneLike {
  fog?: { density: number };
  /** Ad-hoc scene flags the WebGPU heat-shimmer post-process reads (godRay precedent). */
  heatShimmerEnabled?: boolean;
  heatShimmerIntensity?: number;
  /** Ad-hoc scene flags the WebGPU cold-optics post-process reads (Phase D). */
  coldOpticsEnabled?: boolean;
  coldOpticsIntensity?: number;
  /**
   * Flat weather fields the WebGPU weather-particle renderer reads (Phase E).
   * These are the SAME fields the `atmosphericConditions.weather` facade writes
   * (`weather.enabled→scene.enableWeather`, `weather.type→scene.weatherType`,
   * `weather.intensity→scene.weatherIntensity`), so the auto-master and the
   * manual facade path both drive the renderer through one control surface.
   * `weatherType` is the legacy index (0=rain, 1=snow, 2=fog, 3=hail).
   */
  enableWeather?: boolean;
  weatherType?: number;
  weatherIntensity?: number;
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
        type?: number;
        intensity?: number;
      };
      effects?: {
        auto?: boolean;
        shimmer?: { enabled: boolean; intensity: number };
        groundFog?: { enabled: boolean; intensity: number };
        optics?: { enabled: boolean; halo: number };
        precipitation?: { enabled: boolean; type: number; intensity: number };
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

  // The unified effects hierarchy: when the master `auto` is on, derive each
  // effect from the conditions, write it back into the hierarchy leaf (so the UI
  // reflects the derived state), and push the scene flags the backends read.
  const effects = globe?.atmosphericConditions?.effects;
  if (effects?.auto === true) {
    const state = computeAtmosphericEffects({
      humidity: weather.humidity,
      airQuality: weather.airQuality,
      temperatureC: weather.temperature,
      dewpointC: weather.dewpoint,
      precipType: weather.type,
      precipIntensity: weather.intensity,
    });
    if (effects.shimmer) {
      effects.shimmer.enabled = state.shimmer.enabled;
      effects.shimmer.intensity = state.shimmer.intensity;
    }
    if (effects.groundFog) {
      effects.groundFog.enabled = state.groundFog.enabled;
      effects.groundFog.intensity = state.groundFog.intensity;
    }
    if (effects.optics) {
      effects.optics.enabled = state.optics.enabled;
      effects.optics.halo = state.optics.halo;
    }
    if (effects.precipitation) {
      effects.precipitation.enabled = state.precipitation.enabled;
      effects.precipitation.type = state.precipitation.type;
      effects.precipitation.intensity = state.precipitation.intensity;
    }
    // Scene flags the WebGPU post-process effects consume (Phase B: heat shimmer).
    scene.heatShimmerEnabled = state.shimmer.enabled;
    scene.heatShimmerIntensity = state.shimmer.intensity;
    // Phase D: cold optics (ice-crystal sky halos) — driven by the sub-freezing
    // `optics` leaf (enabled + halo strength), mirroring the shimmer block.
    scene.coldOpticsEnabled = state.optics.enabled;
    scene.coldOpticsIntensity = state.optics.halo;
    // Phase E (Batch 423): precipitation → the WebGPU weather-particle renderer.
    // The renderer reads the flat `scene.enableWeather` / `weatherType` /
    // `weatherIntensity` fields (the same ones the `weather` facade writes), so
    // we push the derived `precipitation` leaf there, converting the leaf's
    // PrecipitationType index back to the legacy flat `weatherType` convention.
    // When the auto-derived precip is off we leave `weatherType` /
    // `weatherIntensity` untouched (only flip `enableWeather` off) so a value an
    // app set manually survives a no-precip frame.
    scene.enableWeather = state.precipitation.enabled;
    if (state.precipitation.enabled) {
      scene.weatherType = precipitationTypeToWeatherTypeIndex(
        state.precipitation.type,
      );
      scene.weatherIntensity = state.precipitation.intensity;
    }
  }
}
