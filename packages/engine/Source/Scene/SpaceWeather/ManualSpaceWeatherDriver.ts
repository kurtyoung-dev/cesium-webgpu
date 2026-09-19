/**
 * Deterministic manual space-weather driver.
 *
 * It produces every visual state the aurora renderers can show — quiet through
 * severe, with or without a flare — from presets, a continuous override and a
 * scripted timeline, with no network, no clock and no timer. The same sample
 * time always yields the same packet, so a scripted storm replays
 * byte-identically and a spec can assert exact values rather than tolerances.
 *
 * Disabled is the default and it is free: {@link ManualSpaceWeatherDriver#sampleAt}
 * returns `undefined` before building anything, no packet is allocated, and the
 * module opens no request, job or animation frame in either state.
 *
 * @module Scene/SpaceWeather/ManualSpaceWeatherDriver
 */
import DeveloperError from "../../Core/DeveloperError.js";
import {
  SPACE_WEATHER_PACKET_VERSION,
  SPACE_WEATHER_RANGES,
  SOLAR_FLARE_CLASSES,
  SpaceWeatherAuthority,
  SpaceWeatherSourceKind,
  type GeomagneticState,
  type SolarFlareClassValue,
  type SolarFlareState,
  type SolarWindDiagnostics,
  type SpaceWeatherPacket,
} from "./SpaceWeatherTypes.js";
import { freezeSpaceWeatherPacket } from "./SpaceWeatherPacket.js";

/** The manual presets the driver ships. */
export type SpaceWeatherPresetValue = "quiet" | "moderate" | "severe";

/** Enumerated {@link SpaceWeatherPresetValue} constants. */
export const SpaceWeatherPreset = Object.freeze({
  QUIET: "quiet",
  MODERATE: "moderate",
  SEVERE: "severe",
});

/** The geomagnetic state one preset stands for. */
export interface SpaceWeatherPresetSample {
  /** Planetary index the preset represents. */
  kpIndex: number;
  /** Normalized activity, the index over its full scale. */
  activity: number;
  /** Representative field north-south component in nT; negative is southward. */
  bzNanoTesla: number;
}

/**
 * The preset table, declared rather than derived so both members of each pair
 * are exact: a quiet preset reports an index of 1 and an activity of one ninth,
 * not one ninth rounded back through a multiplication.
 *
 * The three points are an undisturbed field, a moderate storm, and a severe
 * storm whose oval reaches well into the mid latitudes.
 */
export const SPACE_WEATHER_PRESETS = Object.freeze({
  quiet: Object.freeze({ kpIndex: 1, activity: 1 / 9, bzNanoTesla: -1 }),
  moderate: Object.freeze({ kpIndex: 5, activity: 5 / 9, bzNanoTesla: -8 }),
  severe: Object.freeze({ kpIndex: 8, activity: 8 / 9, bzNanoTesla: -25 }),
}) as Readonly<Record<SpaceWeatherPresetValue, SpaceWeatherPresetSample>>;

/**
 * Validity window a manual packet declares, in seconds. A hand-authored state
 * does not expire on its own; the window exists only so the freshness helpers
 * have a scale to report against.
 */
export const MANUAL_SPACE_WEATHER_VALIDITY_SECONDS = 3600;

/** A flare the caller asserts, independent of the geomagnetic channel. */
export interface ManualFlareOverride {
  flareClass: SolarFlareClassValue;
  magnitude: number;
  longBandFluxWattsPerSquareMeter?: number;
  shortBandFluxWattsPerSquareMeter?: number;
}

/** Solar-wind diagnostics the caller asserts. */
export interface ManualSolarWindOverride {
  sourceName?: string;
  speedKmPerSecond?: number;
  densityPerCubicCm?: number;
  temperatureKelvin?: number;
  btNanoTesla?: number;
  bzGsmNanoTesla?: number;
}

/**
 * One scripted step. Exactly one of `preset`, `activity` or `kpIndex` sets the
 * step's activity; the rest are optional additions to it.
 */
export interface ManualSpaceWeatherStep {
  /** Seconds from the driver epoch. Finite, and strictly increasing across the timeline. */
  timeSeconds: number;
  preset?: SpaceWeatherPresetValue;
  activity?: number;
  kpIndex?: number;
  bzNanoTesla?: number;
  dstNanoTesla?: number;
  flare?: ManualFlareOverride;
}

/** Construction options. */
export interface ManualSpaceWeatherDriverOptions {
  /** Start enabled. Defaults to `false`, which is the free state. */
  enabled?: boolean;
  /** Instant `timeSeconds` is measured from, in ms since the Unix epoch. Defaults to `0`. */
  epochMs?: number;
  /** Initial preset. Defaults to `"quiet"`. */
  preset?: SpaceWeatherPresetValue;
  /** Source id stamped into every packet's provenance. Defaults to `"manual"`. */
  sourceId?: string;
  /** Validity window in seconds. Defaults to {@link MANUAL_SPACE_WEATHER_VALIDITY_SECONDS}. */
  validitySeconds?: number;
}

/** What the driver reports about itself. */
export interface ManualSpaceWeatherDiagnostics {
  enabled: boolean;
  preset: SpaceWeatherPresetValue | undefined;
  activity: number;
  kpIndex: number;
  timelineSteps: number;
  packetsBuilt: number;
  sourceId: string;
}

/** A timeline step after normalization: activity resolved, times validated. */
interface ResolvedStep {
  timeSeconds: number;
  preset: SpaceWeatherPresetValue | undefined;
  activity: number;
  kpIndex: number;
  bzNanoTesla: number | undefined;
  dstNanoTesla: number | undefined;
  flare: ManualFlareOverride | undefined;
}

function checkFinite(value: number, name: string): void {
  //>>includeStart('debug', pragmas.debug);
  if (!Number.isFinite(value)) {
    throw new DeveloperError(`${name} must be a finite number.`);
  }
  //>>includeEnd('debug');
}

function checkRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  //>>includeStart('debug', pragmas.debug);
  if (!Number.isFinite(value)) {
    throw new DeveloperError(`${name} must be a finite number.`);
  }
  if (value < minimum || value > maximum) {
    throw new DeveloperError(
      `${name} must be within [${minimum}, ${maximum}].`,
    );
  }
  //>>includeEnd('debug');
}

function checkFlare(flare: ManualFlareOverride, name: string): void {
  //>>includeStart('debug', pragmas.debug);
  if (!SOLAR_FLARE_CLASSES.includes(flare.flareClass)) {
    throw new DeveloperError(
      `${name}.flareClass must be one of ${SOLAR_FLARE_CLASSES.join(", ")}.`,
    );
  }
  const range = SPACE_WEATHER_RANGES.flareMagnitude;
  if (
    !Number.isFinite(flare.magnitude) ||
    flare.magnitude < range.minimum ||
    flare.magnitude >= range.maximum
  ) {
    throw new DeveloperError(
      `${name}.magnitude must be within [${range.minimum}, ${range.maximum}).`,
    );
  }
  //>>includeEnd('debug');
}

/** Copy a flare override so later caller mutation cannot reach an emitted packet. */
function copyFlare(flare: ManualFlareOverride): ManualFlareOverride {
  return {
    flareClass: flare.flareClass,
    magnitude: flare.magnitude,
    longBandFluxWattsPerSquareMeter: flare.longBandFluxWattsPerSquareMeter,
    shortBandFluxWattsPerSquareMeter: flare.shortBandFluxWattsPerSquareMeter,
  };
}

/**
 * Linear interpolation between two optional scalars: interpolated when both
 * neighbours carry the value, held from the earlier step when only it does, and
 * absent when it does not.
 */
function blendOptional(
  before: number | undefined,
  after: number | undefined,
  t: number,
): number | undefined {
  if (before === undefined) {
    return undefined;
  }
  if (after === undefined) {
    return before;
  }
  return before + (after - before) * t;
}

/**
 * Produces {@link SpaceWeatherPacket}s from hand-authored state, deterministically.
 *
 * @example
 * const driver = new ManualSpaceWeatherDriver({ enabled: true });
 * driver.setPreset("severe");
 * const packet = driver.sampleAt(0.0);
 */
export class ManualSpaceWeatherDriver {
  private _enabled: boolean;
  private readonly _epochMs: number;
  private readonly _sourceId: string;
  private readonly _validitySeconds: number;
  private _preset: SpaceWeatherPresetValue | undefined;
  private _activity: number;
  private _kpIndex: number;
  private _bzNanoTesla: number | undefined;
  private _dstNanoTesla: number | undefined;
  private _flare: ManualFlareOverride | undefined;
  private _solarWind: ManualSolarWindOverride | undefined;
  private _timeline: ResolvedStep[] | undefined;
  private _packetsBuilt: number;

  /**
   * @param [options] Construction options.
   */
  constructor(options?: ManualSpaceWeatherDriverOptions) {
    const preset = options?.preset ?? SpaceWeatherPreset.QUIET;
    const sample = SPACE_WEATHER_PRESETS[preset] as
      SpaceWeatherPresetSample | undefined;
    //>>includeStart('debug', pragmas.debug);
    if (sample === undefined) {
      throw new DeveloperError(`options.preset "${preset}" is not a preset.`);
    }
    //>>includeEnd('debug');
    this._enabled = options?.enabled ?? false;
    this._epochMs = options?.epochMs ?? 0;
    this._sourceId = options?.sourceId ?? "manual";
    this._validitySeconds =
      options?.validitySeconds ?? MANUAL_SPACE_WEATHER_VALIDITY_SECONDS;
    this._preset = preset;
    this._activity = sample.activity;
    this._kpIndex = sample.kpIndex;
    this._bzNanoTesla = sample.bzNanoTesla;
    this._dstNanoTesla = undefined;
    this._flare = undefined;
    this._solarWind = undefined;
    this._timeline = undefined;
    this._packetsBuilt = 0;
  }

  /** Whether the driver produces packets. `false` is the default and costs nothing. */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /** The active preset, or `undefined` after a continuous override. */
  get preset(): SpaceWeatherPresetValue | undefined {
    return this._preset;
  }

  /** Normalized activity currently held, in `[0,1]`. */
  get activity(): number {
    return this._activity;
  }

  /** Planetary index currently held, in `[0,9]`. */
  get kpIndex(): number {
    return this._kpIndex;
  }

  /**
   * How many packets this driver has built. It stays at zero for the lifetime of
   * a driver that is never enabled, which is what "default off allocates nothing"
   * means in a number a caller can read.
   */
  get packetsBuilt(): number {
    return this._packetsBuilt;
  }

  /**
   * Select a preset. Both members of the index/activity pair come from the preset
   * table, so neither is a round-trip of the other.
   *
   * @param preset The preset.
   */
  setPreset(preset: SpaceWeatherPresetValue): void {
    const sample = SPACE_WEATHER_PRESETS[preset] as
      SpaceWeatherPresetSample | undefined;
    //>>includeStart('debug', pragmas.debug);
    if (sample === undefined) {
      throw new DeveloperError(`preset "${preset}" is not a preset.`);
    }
    //>>includeEnd('debug');
    this._preset = preset;
    this._activity = sample.activity;
    this._kpIndex = sample.kpIndex;
    this._bzNanoTesla = sample.bzNanoTesla;
  }

  /**
   * Continuous activity override. The planetary index follows it across the same
   * full scale, and the driver stops reporting a preset.
   *
   * @param activity Normalized activity in `[0,1]`.
   */
  setActivity(activity: number): void {
    const range = SPACE_WEATHER_RANGES.activity;
    checkRange(activity, range.minimum, range.maximum, "activity");
    this._preset = undefined;
    this._activity = activity;
    this._kpIndex = activity * SPACE_WEATHER_RANGES.kpIndex.maximum;
  }

  /**
   * Continuous override expressed as a planetary index. Activity follows it.
   *
   * @param kpIndex Planetary index in `[0,9]`.
   */
  setKpIndex(kpIndex: number): void {
    const range = SPACE_WEATHER_RANGES.kpIndex;
    checkRange(kpIndex, range.minimum, range.maximum, "kpIndex");
    this._preset = undefined;
    this._kpIndex = kpIndex;
    this._activity = kpIndex / range.maximum;
  }

  /**
   * Supply or clear the ring-current index.
   *
   * This is the only route by which that index reaches a packet: no provider
   * ships with the engine, because the indices that define it are published under
   * terms that forbid commercial redistribution. The value and its provenance
   * belong to the caller, and the packet records that by stamping the caller as
   * its authority.
   *
   * @param [dstNanoTesla] The index in nT, or `undefined` to clear it.
   */
  setDstOverride(dstNanoTesla?: number): void {
    if (dstNanoTesla === undefined) {
      this._dstNanoTesla = undefined;
      return;
    }
    const range = SPACE_WEATHER_RANGES.dstNanoTesla;
    checkRange(dstNanoTesla, range.minimum, range.maximum, "dstNanoTesla");
    this._dstNanoTesla = dstNanoTesla;
  }

  /**
   * Supply or clear the flare channel. It never touches the geomagnetic state:
   * an X-ray observation carries no information about the plasma that may arrive
   * a day later.
   *
   * @param [flare] The flare, or `undefined` to clear it.
   */
  setFlare(flare?: ManualFlareOverride): void {
    if (flare === undefined) {
      this._flare = undefined;
      return;
    }
    checkFlare(flare, "flare");
    this._flare = copyFlare(flare);
  }

  /**
   * Supply or clear the solar-wind diagnostics.
   *
   * @param [solarWind] The diagnostics, or `undefined` to clear them.
   */
  setSolarWind(solarWind?: ManualSolarWindOverride): void {
    this._solarWind = solarWind === undefined ? undefined : { ...solarWind };
  }

  /**
   * Install or clear a scripted timeline. While one is installed it, and not the
   * single held state, decides what {@link ManualSpaceWeatherDriver#sampleAt}
   * returns.
   *
   * Continuous scalars interpolate linearly between neighbouring steps; the
   * preset name and the flare are held from the most recent step at or before the
   * sample time. Before the first step the first step's state holds, and after
   * the last, the last step's.
   *
   * @param [timeline] The steps, or `undefined` to clear.
   */
  setTimeline(timeline?: readonly ManualSpaceWeatherStep[]): void {
    if (timeline === undefined || timeline.length === 0) {
      this._timeline = undefined;
      return;
    }
    const resolved: ResolvedStep[] = [];
    let previousTime = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < timeline.length; ++i) {
      const step = timeline[i];
      //>>includeStart('debug', pragmas.debug);
      if (!Number.isFinite(step.timeSeconds)) {
        throw new DeveloperError(
          `timeline[${i}].timeSeconds must be a finite number.`,
        );
      }
      if (step.timeSeconds <= previousTime) {
        throw new DeveloperError(
          `timeline[${i}].timeSeconds must be greater than the previous step's.`,
        );
      }
      const sources = [step.preset, step.activity, step.kpIndex].filter(
        (value) => value !== undefined,
      ).length;
      if (sources !== 1) {
        throw new DeveloperError(
          `timeline[${i}] must set exactly one of preset, activity or kpIndex.`,
        );
      }
      //>>includeEnd('debug');
      previousTime = step.timeSeconds;

      let activity: number;
      let kpIndex: number;
      if (step.preset !== undefined) {
        const sample = SPACE_WEATHER_PRESETS[step.preset] as
          SpaceWeatherPresetSample | undefined;
        //>>includeStart('debug', pragmas.debug);
        if (sample === undefined) {
          throw new DeveloperError(
            `timeline[${i}].preset "${step.preset}" is not a preset.`,
          );
        }
        //>>includeEnd('debug');
        activity = sample.activity;
        kpIndex = sample.kpIndex;
      } else if (step.activity !== undefined) {
        const range = SPACE_WEATHER_RANGES.activity;
        checkRange(
          step.activity,
          range.minimum,
          range.maximum,
          `timeline[${i}].activity`,
        );
        activity = step.activity;
        kpIndex = step.activity * SPACE_WEATHER_RANGES.kpIndex.maximum;
      } else {
        const range = SPACE_WEATHER_RANGES.kpIndex;
        const value = step.kpIndex as number;
        checkRange(
          value,
          range.minimum,
          range.maximum,
          `timeline[${i}].kpIndex`,
        );
        kpIndex = value;
        activity = value / range.maximum;
      }
      if (step.bzNanoTesla !== undefined) {
        const range = SPACE_WEATHER_RANGES.bzNanoTesla;
        checkRange(
          step.bzNanoTesla,
          range.minimum,
          range.maximum,
          `timeline[${i}].bzNanoTesla`,
        );
      }
      if (step.dstNanoTesla !== undefined) {
        const range = SPACE_WEATHER_RANGES.dstNanoTesla;
        checkRange(
          step.dstNanoTesla,
          range.minimum,
          range.maximum,
          `timeline[${i}].dstNanoTesla`,
        );
      }
      if (step.flare !== undefined) {
        checkFlare(step.flare, `timeline[${i}].flare`);
      }
      resolved.push({
        timeSeconds: step.timeSeconds,
        preset: step.preset,
        activity: activity,
        kpIndex: kpIndex,
        bzNanoTesla:
          step.bzNanoTesla ??
          (step.preset === undefined
            ? undefined
            : SPACE_WEATHER_PRESETS[step.preset].bzNanoTesla),
        dstNanoTesla: step.dstNanoTesla,
        flare: step.flare === undefined ? undefined : copyFlare(step.flare),
      });
    }
    this._timeline = resolved;
  }

  /**
   * The packet for one instant on the driver's own time base, or `undefined`
   * while disabled.
   *
   * @param timeSeconds Seconds from the driver epoch.
   * @returns A frozen packet, or `undefined`.
   */
  sampleAt(timeSeconds: number): SpaceWeatherPacket | undefined {
    if (!this._enabled) {
      return undefined;
    }
    checkFinite(timeSeconds, "timeSeconds");
    const timeline = this._timeline;
    if (timeline === undefined) {
      return this._buildPacket(
        timeSeconds,
        this._preset,
        this._activity,
        this._kpIndex,
        this._bzNanoTesla,
        this._dstNanoTesla,
        this._flare,
      );
    }
    const last = timeline.length - 1;
    if (timeSeconds <= timeline[0].timeSeconds) {
      return this._buildPacketFromStep(timeSeconds, timeline[0]);
    }
    if (timeSeconds >= timeline[last].timeSeconds) {
      return this._buildPacketFromStep(timeSeconds, timeline[last]);
    }
    let index = 0;
    while (index < last && timeline[index + 1].timeSeconds <= timeSeconds) {
      ++index;
    }
    const before = timeline[index];
    const after = timeline[index + 1];
    const span = after.timeSeconds - before.timeSeconds;
    const t = (timeSeconds - before.timeSeconds) / span;
    const activity = before.activity + (after.activity - before.activity) * t;
    return this._buildPacket(
      timeSeconds,
      before.preset,
      activity,
      before.kpIndex + (after.kpIndex - before.kpIndex) * t,
      blendOptional(before.bzNanoTesla, after.bzNanoTesla, t),
      blendOptional(before.dstNanoTesla, after.dstNanoTesla, t),
      before.flare,
    );
  }

  /**
   * A snapshot of the driver's state, for a diagnostic readout.
   *
   * @returns The snapshot.
   */
  getDiagnostics(): ManualSpaceWeatherDiagnostics {
    return {
      enabled: this._enabled,
      preset: this._preset,
      activity: this._activity,
      kpIndex: this._kpIndex,
      timelineSteps: this._timeline?.length ?? 0,
      packetsBuilt: this._packetsBuilt,
      sourceId: this._sourceId,
    };
  }

  private _buildPacketFromStep(
    timeSeconds: number,
    step: ResolvedStep,
  ): SpaceWeatherPacket {
    return this._buildPacket(
      timeSeconds,
      step.preset,
      step.activity,
      step.kpIndex,
      step.bzNanoTesla,
      step.dstNanoTesla,
      step.flare,
    );
  }

  private _buildPacket(
    timeSeconds: number,
    preset: SpaceWeatherPresetValue | undefined,
    activity: number,
    kpIndex: number,
    bzNanoTesla: number | undefined,
    dstNanoTesla: number | undefined,
    flare: ManualFlareOverride | undefined,
  ): SpaceWeatherPacket {
    const observedTimeMs = this._epochMs + timeSeconds * 1000;
    const geomagnetic: GeomagneticState = {
      activity: activity,
      authority: SpaceWeatherAuthority.MANUAL,
      kpIndex: kpIndex,
      bzNanoTesla: bzNanoTesla,
    };
    if (dstNanoTesla !== undefined) {
      geomagnetic.dstNanoTesla = dstNanoTesla;
      geomagnetic.dstAuthority = SpaceWeatherAuthority.CALLER;
    }
    const packet: SpaceWeatherPacket = {
      version: SPACE_WEATHER_PACKET_VERSION,
      provenance: {
        sourceId: this._sourceId,
        kind: SpaceWeatherSourceKind.MANUAL,
        label: preset,
        validitySeconds: this._validitySeconds,
      },
      observedTimeMs: observedTimeMs,
      forecastTimeMs: observedTimeMs,
      geomagnetic: geomagnetic,
    };
    if (flare !== undefined) {
      const flareState: SolarFlareState = {
        authority: SpaceWeatherAuthority.MANUAL,
        flareClass: flare.flareClass,
        magnitude: flare.magnitude,
        observedTimeMs: observedTimeMs,
      };
      if (flare.longBandFluxWattsPerSquareMeter !== undefined) {
        flareState.longBandFluxWattsPerSquareMeter =
          flare.longBandFluxWattsPerSquareMeter;
      }
      if (flare.shortBandFluxWattsPerSquareMeter !== undefined) {
        flareState.shortBandFluxWattsPerSquareMeter =
          flare.shortBandFluxWattsPerSquareMeter;
      }
      packet.flare = flareState;
    }
    const solarWind = this._solarWind;
    if (solarWind !== undefined) {
      const diagnostics: SolarWindDiagnostics = {
        authority: SpaceWeatherAuthority.MANUAL,
        ...solarWind,
      };
      packet.solarWind = diagnostics;
    }
    ++this._packetsBuilt;
    return freezeSpaceWeatherPacket(packet);
  }
}

export default ManualSpaceWeatherDriver;
