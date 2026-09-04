/**
 * Atmospheric effects — Phase A: a backend-agnostic mapper from weather
 * conditions (humidity, air quality, temperature, dew point, visibility) to the
 * Scene's existing visual knobs (fog density, atmosphere saturation/brightness
 * shift, cloud genus bias). Cheapest, highest realism-per-effort tier of the
 * atmospheric-effects roadmap.
 *
 * `computeAtmosphericKnobs` is a pure function (no Scene import) so it is unit-
 * testable; `applyAtmosphericConditions` reads
 * `scene.globe.atmosphericConditions.weather` and writes the knobs. Whether a
 * given backend renders each knob is separate, pre-existing functionality — this
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

/**
 * Result of the WMO present-weather → precipitation mapping
 * ({@link precipFromWmoCode}). `type` is a {@link PrecipitationType} index;
 * `intensity` is 0..1.
 */
export interface PrecipFromWmo {
  type: number;
  intensity: number;
}

/**
 * Map a WMO Table 4677 present-weather `ww` code (00..99) to a
 * {@link PrecipitationType} + an intensity 0..1. Pure and deterministic
 * (unit-testable). The keystone of the data-driven precipitation path: an
 * ingest field's dominant `ww` selects the particle type the WebGPU weather
 * renderer dispatches.
 *
 * Code-range → type (WMO Table 4677, abbreviated to the renderer's 4 particle
 * profiles — there is no separate sleet profile, so freezing/mixed precip maps to
 * SNOW, the closest visual, and convective hail/thunder maps to HAIL):
 *   - 00..39 → NONE   (clear / haze / smoke / dust — no precipitation reaching ground)
 *   - 40..49 → FOG    (fog / ice fog)
 *   - 50..59 → RAIN   (drizzle — light streaks)
 *   - 60..65 → RAIN   (rain, not freezing)
 *   - 66..69 → SNOW   (freezing rain 66-67 + rain-and-snow mixed 68-69 ≈ sleet → SNOW)
 *   - 70..79 → SNOW   (snow / ice crystals / ice pellets)
 *   - 80..82 → RAIN   (rain showers)
 *   - 83..84 → SNOW   (rain-and-snow showers → SNOW)
 *   - 85..86 → SNOW   (snow showers)
 *   - 87..90 → HAIL   (showers of snow pellets / hail / small hail)
 *   - 91..94 → RAIN   (recent thunderstorm, currently rain/snow at obs)
 *   - 95..99 → HAIL   (thunderstorm; 96/99 with hail — HAIL profile reads as heavy convective)
 *
 * Intensity within a band: many WMO sub-ranges encode slight→moderate→heavy in
 * their last digit. We derive a 0.35→1.0 ramp from the in-band position so a
 * "heavy" code yields denser particles than a "slight" one. NaN / out-of-range →
 * NONE at 0.
 *
 * @param ww The WMO present-weather code (00..99).
 * @returns The precipitation type index + intensity 0..1.
 */
export function precipFromWmoCode(ww: number): PrecipFromWmo {
  if (!Number.isFinite(ww) || ww < 0 || ww > 99) {
    return { type: PrecipitationType.NONE, intensity: 0 };
  }
  const code = Math.floor(ww);

  // No precipitation reaching the ground (clear / haze / smoke / dust / blowing).
  if (code < 40) {
    return { type: PrecipitationType.NONE, intensity: 0 };
  }

  // Fog (40..49): "intensity" reads as fog density; thicker for the higher codes.
  if (code <= 49) {
    return {
      type: PrecipitationType.FOG,
      intensity: rampInBand(code, 40, 49, 0.4, 1.0),
    };
  }

  // Drizzle (50..59) → RAIN, lighter than rain proper.
  if (code <= 59) {
    return {
      type: PrecipitationType.RAIN,
      intensity: rampInBand(code, 50, 59, 0.3, 0.7),
    };
  }

  // Rain (60..65) not freezing.
  if (code <= 65) {
    return {
      type: PrecipitationType.RAIN,
      intensity: rampInBand(code, 60, 65, 0.45, 1.0),
    };
  }

  // Freezing rain (66..67) + rain-and-snow mixed (68..69) ≈ sleet → SNOW.
  if (code <= 69) {
    return {
      type: PrecipitationType.SNOW,
      intensity: rampInBand(code, 66, 69, 0.5, 0.85),
    };
  }

  // Snow / ice crystals / ice pellets (70..79).
  if (code <= 79) {
    return {
      type: PrecipitationType.SNOW,
      intensity: rampInBand(code, 70, 79, 0.4, 1.0),
    };
  }

  // Rain showers (80..82).
  if (code <= 82) {
    return {
      type: PrecipitationType.RAIN,
      intensity: rampInBand(code, 80, 82, 0.6, 1.0),
    };
  }

  // Rain-and-snow showers (83..84) → SNOW.
  if (code <= 84) {
    return {
      type: PrecipitationType.SNOW,
      intensity: rampInBand(code, 83, 84, 0.6, 0.9),
    };
  }

  // Snow showers (85..86).
  if (code <= 86) {
    return {
      type: PrecipitationType.SNOW,
      intensity: rampInBand(code, 85, 86, 0.6, 1.0),
    };
  }

  // Showers of snow pellets / hail / small hail (87..90).
  if (code <= 90) {
    return {
      type: PrecipitationType.HAIL,
      intensity: rampInBand(code, 87, 90, 0.6, 1.0),
    };
  }

  // Recent / non-hail thunderstorm at observation (91..94) → RAIN.
  if (code <= 94) {
    return {
      type: PrecipitationType.RAIN,
      intensity: rampInBand(code, 91, 94, 0.7, 1.0),
    };
  }

  // Thunderstorm (95..99) — heavy convective; 96/99 carry hail → HAIL.
  return {
    type: PrecipitationType.HAIL,
    intensity: rampInBand(code, 95, 99, 0.8, 1.0),
  };
}

/** Linear ramp of `v` across `[lo, hi]` mapped to `[outLo, outHi]`, clamped. */
function rampInBand(
  v: number,
  lo: number,
  hi: number,
  outLo: number,
  outHi: number,
): number {
  const t = hi > lo ? clamp((v - lo) / (hi - lo), 0, 1) : 0;
  return outLo + (outHi - outLo) * t;
}

/**
 * Time-integrate a ground SNOW-COVER coverage scalar (0..1). Ramps UP while snow
 * is falling (accumulation) and melts DOWN otherwise. PURE + deterministic so the
 * ramp/melt is unit-testable. The renderer (and a future ground-shader snow
 * albedo consumer) reads the returned scalar.
 *
 * Rates are per-second fractions; `dt` is the frame's delta time (seconds). When
 * snow falls the cover gains `accumRate * intensity * dt`; otherwise it loses
 * `meltRate * dt`. Result clamped to [0, 1].
 *
 * @param prev The previous cover scalar (0..1).
 * @param snowing True when the active precip is snow (drives accumulation).
 * @param intensity Precip intensity 0..1 (scales the accumulation rate).
 * @param dt Frame delta time, SECONDS.
 * @param accumRate Per-second accumulation fraction at full intensity (default 0.02).
 * @param meltRate Per-second melt fraction when not snowing (default 0.005).
 * @returns The updated cover scalar 0..1.
 */
export function updateSnowAccumulation(
  prev: number,
  snowing: boolean,
  intensity: number,
  dt: number,
  accumRate = 0.02,
  meltRate = 0.005,
): number {
  const p = clamp(prev, 0, 1);
  const step = clamp(dt, 0, 1); // guard pauses / huge first-frame dt
  if (snowing) {
    return clamp(p + accumRate * clamp(intensity, 0, 1) * step, 0, 1);
  }
  return clamp(p - meltRate * step, 0, 1);
}

/**
 * Map an aggregate horizontal visibility (KILOMETRES) to a particle-density
 * MULTIPLIER. PURE. Heavy precip lowers visibility, so low visibility scales the
 * particle density up: at ≥10 km the multiplier is 1.0 (no change), ramping to a
 * cap (default 2.5×) as visibility falls toward 0. `undefined` visibility → 1.0
 * (no coupling). Used by the data-driven path to make heavy precip read as denser
 * particles + lower visibility together.
 *
 * @param visibilityKm The visibility in km, or undefined for no coupling.
 * @param maxScale The density multiplier at zero visibility (default 2.5).
 * @returns A density multiplier ≥ 1.
 */
export function densityScaleFromVisibility(
  visibilityKm: number | undefined,
  maxScale = 2.5,
): number {
  if (visibilityKm === undefined || !Number.isFinite(visibilityKm)) {
    return 1.0;
  }
  const t = clamp((10 - visibilityKm) / 10, 0, 1); // 0 at ≥10 km, 1 at 0 km
  return 1.0 + (maxScale - 1.0) * t;
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
   * High-quality cold-optics opt-in. Pushed from `effects.optics.advanced`;
   * when true the cold-optics shader draws the advanced 22+46 dispersed
   * halos, upper tangent arc, and light pillars. Default-off keeps the
   * legacy halo + sun-dogs byte-identical.
   */
  coldOpticsAdvanced?: boolean;
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
  /**
   * Ground snow-cover scalar (0..1) the data-driven precipitation path
   * time-integrates and the WebGPU weather renderer consumes. Default-off
   * leaves it untouched (undefined → renderer reads 0).
   */
  weatherSnowCover?: number;
  /**
   * Particle-density multiplier (≥1) derived from the ingest field's
   * visibility. Default-off leaves it untouched (undefined → renderer reads
   * 1.0).
   */
  weatherDensityScale?: number;
  /** Per-frame delta time (seconds) — drives the snow-accumulation integrator. */
  _frameState?: { deltaTime?: number };
  globe?: {
    atmosphereSaturationShift?: number;
    atmosphereBrightnessShift?: number;
    /**
     * Cloud-unification epic slice 4B — the Scene/Globe-owned managed default
     * cloud collection is the single cloud authority. The atmospheric-effects
     * genus bias drives its `cloudType`, and the PRECIP-DATA present-weather read
     * uses its `.volumetric.weatherProvider` (the legacy `globe.cloudType` /
     * `globe.weatherProvider` fields were removed in 4B).
     */
    defaultCloudCollection?: {
      cloudType?: number;
      volumetric?: {
        weatherProvider?: {
          getPresentWeather?: () => {
            ww?: number;
            visibilityKm?: number;
          } | null;
        };
      };
    };
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
        optics?: { enabled: boolean; halo: number; advanced?: boolean };
        precipitation?: {
          enabled: boolean;
          type: number;
          intensity: number;
          /**
           * Opt-in. When true and a weather-ingest provider with
           * present-weather is attached, the precip type/intensity are
           * overridden from the ingest field's WMO `ww` code (and density is
           * scaled by visibility). Default false keeps the manual/auto
           * selection.
           */
          dataDriven?: boolean;
          /**
           * Opt-in. When true, a ground snow-cover scalar ramps up under
           * snow and melts otherwise (`snowCover`). Flag-gated + default
           * false so the integrator is inert unless requested.
           */
          snowAccumulation?: boolean;
          /** The integrated snow-cover scalar (0..1). */
          snowCover?: number;
        };
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
    if (knobs.cloudType !== undefined && globe.defaultCloudCollection) {
      // Cloud-unification epic slice 4B — genus bias drives the managed default
      // cloud collection's collection-level genus (the `globe.cloudType` field
      // was removed in 4B; the collection is the single authority).
      globe.defaultCloudCollection.cloudType = knobs.cloudType;
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
    // The `advanced` sub-flag is a user opt-in (not auto-derived from
    // temperature), so it passes straight through from the hierarchy leaf to
    // the scene flag the cold-optics post-process reads. When unset it reads
    // false — the legacy halo + sun-dogs path (byte-identical).
    scene.coldOpticsAdvanced = effects.optics?.advanced === true;
    // Phase E: precipitation → the WebGPU weather-particle renderer. The
    // renderer reads the flat `scene.enableWeather` / `weatherType` /
    // `weatherIntensity` fields (the same ones the `weather` facade writes),
    // so the derived `precipitation` leaf is pushed there, converting the
    // leaf's PrecipitationType index back to the legacy flat `weatherType`
    // convention. When the auto-derived precip is off, `weatherType` /
    // `weatherIntensity` are left untouched (only `enableWeather` flips off)
    // so a value an app set manually survives a no-precip frame.
    scene.enableWeather = state.precipitation.enabled;
    if (state.precipitation.enabled) {
      scene.weatherType = precipitationTypeToWeatherTypeIndex(
        state.precipitation.type,
      );
      scene.weatherIntensity = state.precipitation.intensity;
    }
  }

  // Data-driven precipitation override. Runs independently of the `auto`
  // master, after the manual/auto selection above, so it overrides only the
  // precip type/intensity (everything else the user/auto chose stands). Hard
  // gate: it does nothing unless both
  //   (a) `effects.precipitation.dataDriven === true`, and
  //   (b) an ingest provider is attached and reports present-weather with a `ww`.
  // When either is false the entire block is skipped, so the precip path
  // stays byte-identical to the manual/auto behavior.
  applyDataDrivenPrecip(scene, effects);
}

/**
 * Override precip type/intensity from the weather-ingest field's WMO `ww`
 * when the data-driven flag is set and a provider with present-weather is
 * attached. Also couples particle density to visibility and (flag-gated)
 * integrates the ground snow-cover scalar. No-op otherwise.
 */
function applyDataDrivenPrecip(
  scene: AtmosphericSceneLike,
  effects: NonNullable<
    NonNullable<AtmosphericSceneLike["globe"]>["atmosphericConditions"]
  >["effects"],
): void {
  const precip = effects?.precipitation;
  if (precip?.dataDriven !== true) {
    return; // gate (a): flag off → no override, manual/auto selection stands.
  }
  // Cloud-unification epic slice 4B — the weather provider is attached to the
  // managed default cloud collection's `.volumetric` (the `globe.weatherProvider`
  // field was removed in 4B; the collection is the single ingest sink).
  const provider =
    scene.globe?.defaultCloudCollection?.volumetric?.weatherProvider;
  const present = provider?.getPresentWeather?.();
  if (!present || present.ww === undefined) {
    return; // gate (b): no ingest present-weather → no override.
  }

  const mapped = precipFromWmoCode(present.ww);
  // Visibility coupling: heavy precip (low visibility) → denser particles.
  const densityScale = densityScaleFromVisibility(present.visibilityKm);
  scene.weatherDensityScale = densityScale;

  // Write the override into BOTH the hierarchy leaf (so UI reflects it) and the
  // flat scene fields the renderer consumes.
  precip.enabled =
    mapped.type !== PrecipitationType.NONE && mapped.intensity > 0;
  precip.type = mapped.type;
  precip.intensity = mapped.intensity;
  scene.enableWeather = precip.enabled;
  if (precip.enabled) {
    scene.weatherType = precipitationTypeToWeatherTypeIndex(mapped.type);
    scene.weatherIntensity = mapped.intensity;
  }

  // Flag-gated ground snow accumulation: ramp up under snow, melt otherwise.
  if (precip.snowAccumulation === true) {
    const snowing = mapped.type === PrecipitationType.SNOW && precip.enabled;
    const dt = scene._frameState?.deltaTime ?? 0.016;
    const prevCover = precip.snowCover ?? 0;
    const cover = updateSnowAccumulation(
      prevCover,
      snowing,
      mapped.intensity,
      dt,
    );
    precip.snowCover = cover;
    scene.weatherSnowCover = cover;
  }
}
