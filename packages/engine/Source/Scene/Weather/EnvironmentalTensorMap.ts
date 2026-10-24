/**
 * Planetary Environmental Tensor Map — unified multi-attribute atmospheric and
 * marine raster representation for Continuous Level of Detail (CLOD).
 *
 * Encodes, packs, resamples, and decodes co-registered planetary environmental
 * variables into compact GPU-ready textures:
 *
 * 1. Atmospheric Map (RGBA8 / RGBA16F):
 *    - R = Zonal eastward wind component (u10, -60 to +60 m/s)
 *    - G = Meridional northward wind component (v10, -60 to +60 m/s)
 *    - B = Mean Sea Level Pressure anomaly (Delta P = P_msl - 1013.25 hPa, -100 to +50 hPa)
 *    - A = Surface air temperature (-60 to +50 deg C)
 *
 * 2. Marine & Cloud Map (RGBA8):
 *    - R = Cloud fractional coverage (0 to 1)
 *    - G = Beaufort wind force scale (0 to 12)
 *    - B = Significant wave height (Hs, 0 to 20 m)
 *    - A = Precipitation rate & fog intensity (0 to 1)
 *
 * Acts as the global Level 0 fallback substrate, providing immediate, seamless
 * environmental data across the whole Earth while higher-resolution streaming
 * forecast feeds (e.g. NOAA HRRR, radar mosaics) load or compute.
 *
 * @module Scene/Weather/EnvironmentalTensorMap
 */

import {
  applyEquirectPolarLowPass,
  periodicFbmRow,
  WEATHER_MAP_TEX_HEIGHT,
  WEATHER_MAP_TEX_WIDTH,
} from "./WeatherMapSeam.js";

/** Minimum and maximum wind vector component in m/s (-60 m/s to +60 m/s). */
export const WIND_COMPONENT_MIN_MPS = -60.0;
export const WIND_COMPONENT_MAX_MPS = 60.0;
export const WIND_COMPONENT_RANGE_MPS =
  WIND_COMPONENT_MAX_MPS - WIND_COMPONENT_MIN_MPS;

/** Standard mean sea level atmospheric pressure in hPa. */
export const STANDARD_MSLP_HPA = 1013.25;

/** Barometric pressure anomaly range in hPa (-100 to +50 hPa). */
export const PRESSURE_ANOMALY_MIN_HPA = -100.0;
export const PRESSURE_ANOMALY_MAX_HPA = 50.0;
export const PRESSURE_ANOMALY_RANGE_HPA =
  PRESSURE_ANOMALY_MAX_HPA - PRESSURE_ANOMALY_MIN_HPA;

/** Surface air temperature range in Celsius (-60 to +50 deg C). */
export const TEMPERATURE_MIN_C = -60.0;
export const TEMPERATURE_MAX_C = 50.0;
export const TEMPERATURE_RANGE_C = TEMPERATURE_MAX_C - TEMPERATURE_MIN_C;

/** Maximum significant wave height in metres for byte quantization (0 to 20 m). */
export const MAX_SIGNIFICANT_WAVE_HEIGHT_M = 20.0;

/** Maximum Beaufort scale number. */
export const MAX_BEAUFORT_SCALE = 12.0;

/** Decoded local environmental state at a geographic position. */
export interface DecodedEnvironmentalState {
  windU: number;
  windV: number;
  windSpeed: number;
  windHeadingRad: number;
  pressureHpa: number;
  stormSurgeMeters: number;
  temperatureC: number;
  cloudCoverage: number;
  beaufortScale: number;
  significantWaveHeightM: number;
  precipitationRate: number;
}

/** Dual-raster packed environmental tensor set. */
export interface EnvironmentalTensorSet {
  width: number;
  height: number;
  atmosphericBytes: Uint8Array;
  marineBytes: Uint8Array;
  sample?(longitudeRad: number, latitudeRad: number): DecodedEnvironmentalState;
}

/** Helper clamp function. */
function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

/**
 * Encodes signed zonal (u) and meridional (v) wind components into 8-bit unsigned values.
 * Maps [-60, +60] m/s onto [0, 255].
 */
export function encodeWindVector(
  uMps: number,
  vMps: number,
): { r: number; g: number } {
  const normU =
    (clamp(uMps, WIND_COMPONENT_MIN_MPS, WIND_COMPONENT_MAX_MPS) -
      WIND_COMPONENT_MIN_MPS) /
    WIND_COMPONENT_RANGE_MPS;
  const normV =
    (clamp(vMps, WIND_COMPONENT_MIN_MPS, WIND_COMPONENT_MAX_MPS) -
      WIND_COMPONENT_MIN_MPS) /
    WIND_COMPONENT_RANGE_MPS;
  return {
    r: Math.round(normU * 255),
    g: Math.round(normV * 255),
  };
}

/**
 * Decodes 8-bit unsigned red and green channels into physical wind components and vector polar metrics.
 */
export function decodeWindVector(
  r: number,
  g: number,
): { u: number; v: number; speed: number; headingRad: number } {
  const u = (r / 255.0) * WIND_COMPONENT_RANGE_MPS + WIND_COMPONENT_MIN_MPS;
  const v = (g / 255.0) * WIND_COMPONENT_RANGE_MPS + WIND_COMPONENT_MIN_MPS;
  const speed = Math.sqrt(u * u + v * v);
  const headingRad = Math.atan2(v, u);
  return { u, v, speed, headingRad };
}

/**
 * Encodes Mean Sea Level Pressure anomaly (Delta P = P_msl - 1013.25) into an 8-bit unsigned value.
 * Maps [-100, +50] hPa onto [0, 255].
 */
export function encodePressureAnomaly(deltaHpa: number): number {
  const norm =
    (clamp(deltaHpa, PRESSURE_ANOMALY_MIN_HPA, PRESSURE_ANOMALY_MAX_HPA) -
      PRESSURE_ANOMALY_MIN_HPA) /
    PRESSURE_ANOMALY_RANGE_HPA;
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned blue channel into barometric pressure anomaly, absolute pressure,
 * and physical inverse barometer storm surge elevation.
 */
export function decodePressureAnomaly(b: number): {
  deltaHpa: number;
  pressureHpa: number;
  stormSurgeMeters: number;
} {
  const deltaHpa =
    (b / 255.0) * PRESSURE_ANOMALY_RANGE_HPA + PRESSURE_ANOMALY_MIN_HPA;
  const pressureHpa = STANDARD_MSLP_HPA + deltaHpa;
  const stormSurgeMeters = -deltaHpa * 0.01;
  return { deltaHpa, pressureHpa, stormSurgeMeters };
}

/**
 * Encodes surface air temperature in Celsius into an 8-bit unsigned value.
 * Maps [-60, +50] deg C onto [0, 255].
 */
export function encodeTemperature(celsius: number): number {
  const norm =
    (clamp(celsius, TEMPERATURE_MIN_C, TEMPERATURE_MAX_C) - TEMPERATURE_MIN_C) /
    TEMPERATURE_RANGE_C;
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned alpha channel into surface air temperature in Celsius.
 */
export function decodeTemperature(a: number): number {
  return (a / 255.0) * TEMPERATURE_RANGE_C + TEMPERATURE_MIN_C;
}

/**
 * Encodes Beaufort scale number (0 to 12) into an 8-bit unsigned value.
 */
export function encodeBeaufortScale(b: number): number {
  const norm = clamp(b, 0.0, MAX_BEAUFORT_SCALE) / MAX_BEAUFORT_SCALE;
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned channel into Beaufort scale number (0 to 12).
 */
export function decodeBeaufortScale(val: number): number {
  return (val / 255.0) * MAX_BEAUFORT_SCALE;
}

/**
 * Encodes significant wave height in metres (0 to 20 m) into an 8-bit unsigned value.
 */
export function encodeSignificantWaveHeight(hsMeters: number): number {
  const norm =
    clamp(hsMeters, 0.0, MAX_SIGNIFICANT_WAVE_HEIGHT_M) /
    MAX_SIGNIFICANT_WAVE_HEIGHT_M;
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned channel into significant wave height in metres.
 */
export function decodeSignificantWaveHeight(val: number): number {
  return (val / 255.0) * MAX_SIGNIFICANT_WAVE_HEIGHT_M;
}

/**
 * Bilinearly samples the environmental tensor map at arbitrary geographic coordinates (lon, lat in radians).
 * Ensures dateline antimeridian wrapping and polar clamping.
 */
export function sampleEnvironmentalTensor(
  tensors: EnvironmentalTensorSet,
  longitudeRad: number,
  latitudeRad: number,
): DecodedEnvironmentalState {
  const w = tensors.width;
  const h = tensors.height;

  // Normalized coordinates: lon [-PI, PI] -> u [0, 1], lat [-PI/2, PI/2] -> v [0, 1] (row 0 = north)
  let u = (longitudeRad + Math.PI) / (2 * Math.PI);
  u = u - Math.floor(u); // Wrap antimeridian
  const v = clamp((Math.PI / 2 - latitudeRad) / Math.PI, 0.0, 1.0);

  // Texel coordinates
  const fx = u * w - 0.5;
  const fy = clamp(v * h - 0.5, 0.0, h - 1.0);
  const x0 = ((Math.floor(fx) % w) + w) % w;
  const x1 = (x0 + 1) % w;
  const y0 = Math.floor(fy);
  const y1 = Math.min(y0 + 1, h - 1);

  const wx = fx - Math.floor(fx);
  const wy = fy - y0;

  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;

  function sampleChannel(buf: Uint8Array, offset: number): number {
    const v00 = buf[i00 + offset];
    const v10 = buf[i10 + offset];
    const v01 = buf[i01 + offset];
    const v11 = buf[i11 + offset];
    const top = v00 * (1 - wx) + v10 * wx;
    const bot = v01 * (1 - wx) + v11 * wx;
    return top * (1 - wy) + bot * wy;
  }

  // Sample atmospheric channels
  const rAtm = sampleChannel(tensors.atmosphericBytes, 0);
  const gAtm = sampleChannel(tensors.atmosphericBytes, 1);
  const bAtm = sampleChannel(tensors.atmosphericBytes, 2);
  const aAtm = sampleChannel(tensors.atmosphericBytes, 3);

  // Sample marine/cloud channels
  const rMar = sampleChannel(tensors.marineBytes, 0);
  const gMar = sampleChannel(tensors.marineBytes, 1);
  const bMar = sampleChannel(tensors.marineBytes, 2);
  const aMar = sampleChannel(tensors.marineBytes, 3);

  const wind = decodeWindVector(rAtm, gAtm);
  const pressure = decodePressureAnomaly(bAtm);
  const temp = decodeTemperature(aAtm);

  return {
    windU: wind.u,
    windV: wind.v,
    windSpeed: wind.speed,
    windHeadingRad: wind.headingRad,
    pressureHpa: pressure.pressureHpa,
    stormSurgeMeters: pressure.stormSurgeMeters,
    temperatureC: temp,
    cloudCoverage: rMar / 255.0,
    beaufortScale: decodeBeaufortScale(gMar),
    significantWaveHeightM: decodeSignificantWaveHeight(bMar),
    precipitationRate: aMar / 255.0,
  };
}

/**
 * Continuous Level of Detail (CLOD) blend between base global raster state and
 * higher-resolution regional forecast observations.
 *
 * @param baseState Global coarse environmental state.
 * @param highDetailState Regional detailed observation.
 * @param blendFactor 0.0 = full base raster, 1.0 = full high-detail observation.
 */
export function blendEnvironmentalLOD(
  baseState: DecodedEnvironmentalState,
  highDetailState: DecodedEnvironmentalState,
  blendFactor: number,
): DecodedEnvironmentalState {
  const alpha = clamp(blendFactor, 0.0, 1.0);
  const beta = 1.0 - alpha;

  const windU = baseState.windU * beta + highDetailState.windU * alpha;
  const windV = baseState.windV * beta + highDetailState.windV * alpha;

  return {
    windU,
    windV,
    windSpeed: Math.sqrt(windU * windU + windV * windV),
    windHeadingRad: Math.atan2(windV, windU),
    pressureHpa:
      baseState.pressureHpa * beta + highDetailState.pressureHpa * alpha,
    stormSurgeMeters:
      baseState.stormSurgeMeters * beta +
      highDetailState.stormSurgeMeters * alpha,
    temperatureC:
      baseState.temperatureC * beta + highDetailState.temperatureC * alpha,
    cloudCoverage:
      baseState.cloudCoverage * beta + highDetailState.cloudCoverage * alpha,
    beaufortScale:
      baseState.beaufortScale * beta + highDetailState.beaufortScale * alpha,
    significantWaveHeightM:
      baseState.significantWaveHeightM * beta +
      highDetailState.significantWaveHeightM * alpha,
    precipitationRate:
      baseState.precipitationRate * beta +
      highDetailState.precipitationRate * alpha,
  };
}

/**
 * Synthesizes a seamless Level 0 procedural planetary environmental tensor set.
 *
 * Models global atmospheric circulation (trade winds, westerlies, polar easterlies),
 * storm track depressions along subpolar zones, equatorial ITCZ cloud convergence,
 * and physical wave heights coupled with wind speed.
 *
 * @param w Texture width (default 1440).
 * @param h Texture height (default 721).
 */
export function buildProceduralEnvironmentalTensor(
  w: number = WEATHER_MAP_TEX_WIDTH,
  h: number = WEATHER_MAP_TEX_HEIGHT,
): EnvironmentalTensorSet {
  const atmosphericBytes = new Uint8Array(w * h * 4);
  const marineBytes = new Uint8Array(w * h * 4);

  const coarseRow = new Float64Array(w);
  const fineRow = new Float64Array(w);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const latRad = Math.PI / 2 - v * Math.PI;
    const latDeg = (latRad * 180.0) / Math.PI;

    // Atmospheric general circulation (Hadley, Ferrel, Polar cells)
    // - Tropical trade winds (0-30 deg): Easterly (negative u)
    // - Mid-latitude westerlies (30-60 deg): Westerly (positive u)
    // - Polar easterlies (60-90 deg): Easterly (negative u)
    let meanZonalWind: number;
    if (Math.abs(latDeg) <= 30.0) {
      meanZonalWind = -8.0 * Math.cos((latDeg / 30.0) * (Math.PI / 2));
    } else if (Math.abs(latDeg) <= 60.0) {
      meanZonalWind =
        14.0 * Math.sin(((Math.abs(latDeg) - 30.0) / 30.0) * Math.PI);
    } else {
      meanZonalWind =
        -6.0 * Math.sin(((Math.abs(latDeg) - 60.0) / 30.0) * (Math.PI / 2));
    }

    // Latitude-dependent thermal gradient (warm equator ~28C, cold poles ~-35C)
    const baseTemp =
      28.0 * Math.cos(latRad) - 35.0 * Math.pow(Math.sin(latRad), 2);

    // Procedural fBM for regional weather variations and synoptic storms
    periodicFbmRow(coarseRow, w, v * 6, 6);
    periodicFbmRow(fineRow, w, v * 18, 18);

    for (let x = 0; x < w; x++) {
      const noise = coarseRow[x] * 0.7 + fineRow[x] * 0.3;
      const stormDepression = Math.max(0.0, (noise - 0.45) / 0.35); // 0 in clear, up to ~1 in storms

      // Wind modulation by storm vortex turbulence
      const u = meanZonalWind + (noise - 0.5) * 16.0;
      const vWind = (coarseRow[(x + Math.floor(w / 4)) % w] - 0.5) * 14.0;
      const windSpeed = Math.sqrt(u * u + vWind * vWind);

      // Low-pressure anomaly: up to -45 hPa in deep storms
      const deltaHpa = -45.0 * stormDepression + (noise - 0.5) * 10.0;
      const tempC = baseTemp - 5.0 * stormDepression;

      // Pack Atmospheric Map
      const windEnc = encodeWindVector(u, vWind);
      const i = (y * w + x) * 4;
      atmosphericBytes[i] = windEnc.r;
      atmosphericBytes[i + 1] = windEnc.g;
      atmosphericBytes[i + 2] = encodePressureAnomaly(deltaHpa);
      atmosphericBytes[i + 3] = encodeTemperature(tempC);

      // Derive marine state from wind speed (Beaufort & JONSWAP significant wave height)
      const beaufort = Math.min(12.0, Math.pow(windSpeed / 0.836, 2.0 / 3.0));
      // Empirical significant wave height: Hs ~ 0.0246 * U10^2
      const hs = Math.min(20.0, 0.0246 * windSpeed * windSpeed);
      const coverage = clamp((noise - 0.42) / 0.18, 0.0, 1.0);
      const precip =
        stormDepression > 0.5 ? (stormDepression - 0.5) * 2.0 : 0.0;

      // Pack Marine & Cloud Map
      marineBytes[i] = Math.round(coverage * 255);
      marineBytes[i + 1] = encodeBeaufortScale(beaufort);
      marineBytes[i + 2] = encodeSignificantWaveHeight(hs);
      marineBytes[i + 3] = Math.round(precip * 255);
    }
  }

  // Ensure seamless polar caps
  applyEquirectPolarLowPass(atmosphericBytes, w, h);
  applyEquirectPolarLowPass(marineBytes, w, h);

  const tensorSet: EnvironmentalTensorSet = {
    width: w,
    height: h,
    atmosphericBytes,
    marineBytes,
  };
  tensorSet.sample = function (lon: number, lat: number) {
    return sampleEnvironmentalTensor(tensorSet, lon, lat);
  };
  return tensorSet;
}
