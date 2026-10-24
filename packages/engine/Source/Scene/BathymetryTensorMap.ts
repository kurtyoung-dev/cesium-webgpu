/**
 * Planetary Bathymetry & Seabed Substrate Tensor Map — unified multi-attribute
 * oceanic depth, optical clarity, and seabed substrate representation for
 * Continuous Level of Detail (CLOD).
 *
 * Encodes, packs, resamples, and decodes co-registered planetary bathymetric
 * variables into a compact GPU-ready texture (RGBA8 / RGBA16F):
 *
 *   - R = Square-root normalized ocean depth (0 to 11,000 m Challenger Deep)
 *   - G = Jerlov optical water clarity type (0=Type I, 1=IA, 2=IB, 3=II, 4=III, 5-9=Coastal 1-9)
 *   - B = Seabed substrate classification (0=Sand, 1=Silt/Mud, 2=Coral Reef, 3=Rock/Basalt, 4=Abyssal)
 *   - A = Mean tidal range envelope (0 to 16 m)
 *
 * Acts as the global Level 0 depth and optics prior, providing a plausible,
 * seamless underwater depth and Jerlov water extinction across the whole Earth.
 *
 * Provenance: this is a PROCEDURAL depth and optics prior, not survey data. The
 * bundled `globalBathymetryTensor.bin` is synthesized from coast distance, the
 * EGM2008 geoid Laplacian and reef flags; it is not derived from GEBCO, ETOPO
 * or any measured survey, and its depths are approximate (they are not suitable
 * for navigation or science). The regional "survey" patches below are
 * hand-placed synthetic values, also not measurements.
 *
 * @module Scene/BathymetryTensorMap
 */

import {
  applyEquirectPolarLowPass,
  periodicFbmRow,
  WEATHER_MAP_TEX_HEIGHT,
  WEATHER_MAP_TEX_WIDTH,
} from "./Weather/WeatherMapSeam.js";

/** Maximum ocean depth in metres (Challenger Deep). */
export const BATHYMETRY_MAX_DEPTH_M = 11000.0;

/** Nominal continental shelf edge depth in metres. */
export const BATHYMETRY_SHELF_DEPTH_M = 200.0;

/** Maximum tidal range envelope in metres for byte quantization (0 to 16 m). */
export const MAX_TIDAL_RANGE_M = 16.0;

/**
 * Standard Jerlov water classification indices.
 *
 * Types I, IA, IB, II, III represent open oceanic waters with increasing
 * phytoplankton and dissolved organic matter. Types 1 through 9 represent
 * coastal and estuarine waters with increasing sediment turbidity.
 */
export const JerlovWaterType = {
  TYPE_I: 0,
  TYPE_IA: 1,
  TYPE_IB: 2,
  TYPE_II: 3,
  TYPE_III: 4,
  COASTAL_1: 5,
  COASTAL_3: 6,
  COASTAL_5: 7,
  COASTAL_7: 8,
  COASTAL_9: 9,
} as const;

/**
 * Ocean floor substrate classifications.
 */
export const SeabedSubstrateType = {
  SAND: 0,
  SILT_MUD: 1,
  CORAL_REEF: 2,
  ROCK_BASALT: 3,
  ABYSSAL_SEDIMENT: 4,
} as const;

/** Decoded local bathymetric and seabed state at a geographic position. */
export interface DecodedBathymetryState {
  depthMeters: number;
  jerlovType: number;
  substrateType: number;
  tidalRangeMeters: number;
}

/** Packed bathymetric tensor set. */
export interface BathymetryTensorSet {
  width: number;
  height: number;
  bathymetryBytes: Uint8Array;
  sample?(longitudeRad: number, latitudeRad: number): DecodedBathymetryState;
}

let _globalBundledBathymetryTensor: BathymetryTensorSet | undefined;

/** Helper clamp function. */
function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

/**
 * Encodes ocean depth in metres into an 8-bit unsigned value using square-root scaling.
 * Square-root scaling allocates higher precision to shallow coastal shelves (<200 m).
 */
export function encodeDepth(depthMeters: number): number {
  const clamped = clamp(depthMeters, 0.0, BATHYMETRY_MAX_DEPTH_M);
  const norm = Math.sqrt(clamped / BATHYMETRY_MAX_DEPTH_M);
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned red channel into physical ocean depth in metres.
 */
export function decodeDepth(r: number): number {
  const norm = clamp(r / 255.0, 0.0, 1.0);
  return norm * norm * BATHYMETRY_MAX_DEPTH_M;
}

/**
 * Encodes Jerlov water type index (0 to 9) into an 8-bit unsigned channel.
 */
export function encodeJerlovType(typeIndex: number): number {
  const clamped = clamp(typeIndex, 0, 9);
  return Math.round((clamped / 9.0) * 255);
}

/**
 * Decodes an 8-bit unsigned green channel into Jerlov water type index (0 to 9).
 */
export function decodeJerlovType(g: number): number {
  return Math.round((g / 255.0) * 9.0);
}

/**
 * Encodes seabed substrate classification index (0 to 4) into an 8-bit unsigned channel.
 */
export function encodeSubstrate(substrateIndex: number): number {
  const clamped = clamp(substrateIndex, 0, 4);
  return Math.round((clamped / 4.0) * 255);
}

/**
 * Decodes an 8-bit unsigned blue channel into seabed substrate classification index (0 to 4).
 */
export function decodeSubstrate(b: number): number {
  return Math.round((b / 255.0) * 4.0);
}

/**
 * Encodes mean tidal range envelope in metres (0 to 16 m) into an 8-bit unsigned channel.
 */
export function encodeTidalRange(rangeMeters: number): number {
  const norm = clamp(rangeMeters, 0.0, MAX_TIDAL_RANGE_M) / MAX_TIDAL_RANGE_M;
  return Math.round(norm * 255);
}

/**
 * Decodes an 8-bit unsigned alpha channel into mean tidal range envelope in metres.
 */
export function decodeTidalRange(a: number): number {
  return (a / 255.0) * MAX_TIDAL_RANGE_M;
}

/**
 * Samples the bathymetry tensor map at arbitrary geographic coordinates (lon, lat in radians).
 * Depth (R) and tidal range (A) are bilinearly interpolated; the categorical
 * Jerlov (G) and substrate (B) channels use the nearest texel, because averaging
 * category codes invents classes (reef 2 and abyssal 4 would blend into rock 3).
 * Ensures dateline antimeridian wrapping and polar clamping.
 */
export function sampleBathymetryTensor(
  tensors: BathymetryTensorSet,
  longitudeRad: number,
  latitudeRad: number,
): DecodedBathymetryState {
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

  const buf = tensors.bathymetryBytes;
  function sampleChannel(offset: number): number {
    const v00 = buf[i00 + offset];
    const v10 = buf[i10 + offset];
    const v01 = buf[i01 + offset];
    const v11 = buf[i11 + offset];
    const top = v00 * (1 - wx) + v10 * wx;
    const bot = v01 * (1 - wx) + v11 * wx;
    return top * (1 - wy) + bot * wy;
  }

  const nearest = wy >= 0.5 ? (wx >= 0.5 ? i11 : i01) : wx >= 0.5 ? i10 : i00;
  const r = sampleChannel(0);
  const g = buf[nearest + 1];
  const b = buf[nearest + 2];
  const a = sampleChannel(3);

  return {
    depthMeters: decodeDepth(r),
    jerlovType: decodeJerlovType(g),
    substrateType: decodeSubstrate(b),
    tidalRangeMeters: decodeTidalRange(a),
  };
}

/**
 * Continuous Level of Detail (CLOD) blend between the coarse global procedural
 * prior and a higher-detail regional state (a synthetic patch today).
 *
 * @param baseState Global coarse procedural bathymetric state.
 * @param highDetailState Regional higher-detail state.
 * @param blendFactor 0.0 = full base raster, 1.0 = full high-detail state.
 */
export function blendBathymetryLOD(
  baseState: DecodedBathymetryState,
  highDetailState: DecodedBathymetryState,
  blendFactor: number,
): DecodedBathymetryState {
  const alpha = clamp(blendFactor, 0.0, 1.0);
  const beta = 1.0 - alpha;

  return {
    depthMeters:
      baseState.depthMeters * beta + highDetailState.depthMeters * alpha,
    jerlovType: Math.round(
      baseState.jerlovType * beta + highDetailState.jerlovType * alpha,
    ),
    substrateType:
      alpha > 0.5 ? highDetailState.substrateType : baseState.substrateType,
    tidalRangeMeters:
      baseState.tidalRangeMeters * beta +
      highDetailState.tidalRangeMeters * alpha,
  };
}

interface HydrographicBasinEnvelope {
  lon: number;
  lat: number;
  lonScale: number;
  latScale: number;
  innerRadius: number;
  outerRadius: number;
  depthM: number;
  jerlov: number;
  substrate: number;
  threshold: number;
  tidalOverride?: number;
  extraCenters?: ReadonlyArray<readonly [number, number]>;
}

const HYDROGRAPHIC_BASIN_ENVELOPES: ReadonlyArray<HydrographicBasinEnvelope> = [
  // Shallow carbonate coral shoal (Jerlov IA)
  {
    lon: -77.5,
    lat: 24.5,
    lonScale: 0.9,
    latScale: 1.0,
    innerRadius: 2.0,
    outerRadius: 5.0,
    depthM: 12.0,
    jerlov: JerlovWaterType.TYPE_IA,
    substrate: SeabedSubstrateType.CORAL_REEF,
    threshold: 0.35,
  },
  // Subtropical barrier reef shelf (Jerlov IB)
  {
    lon: 147.0,
    lat: -18.0,
    lonScale: 0.8,
    latScale: 1.0,
    innerRadius: 2.5,
    outerRadius: 6.0,
    depthM: 18.0,
    jerlov: JerlovWaterType.TYPE_IB,
    substrate: SeabedSubstrateType.CORAL_REEF,
    threshold: 0.35,
  },
  // Hadal subduction trench (Jerlov Type I)
  {
    lon: 142.2,
    lat: 11.35,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 1.8,
    outerRadius: 4.5,
    depthM: 10920.0,
    jerlov: JerlovWaterType.TYPE_I,
    substrate: SeabedSubstrateType.ROCK_BASALT,
    threshold: 0.25,
  },
  // Equatorial macro-estuary turbid silt delta plume (Jerlov Coastal 7)
  {
    lon: -49.5,
    lat: -0.5,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 2.0,
    outerRadius: 5.0,
    depthM: 22.0,
    jerlov: JerlovWaterType.COASTAL_7,
    substrate: SeabedSubstrateType.SILT_MUD,
    threshold: 0.3,
  },
  // Boreal tectonic rift graben lake (Jerlov Type I)
  {
    lon: 108.0,
    lat: 53.5,
    lonScale: 0.75,
    latScale: 1.0,
    innerRadius: 1.4,
    outerRadius: 3.5,
    depthM: 1642.0,
    jerlov: JerlovWaterType.TYPE_I,
    substrate: SeabedSubstrateType.ROCK_BASALT,
    threshold: 0.25,
    tidalOverride: 0.05,
  },
  // Equatorial tectonic rift lake (Jerlov Type IA)
  {
    lon: 29.5,
    lat: -6.5,
    lonScale: 1.0,
    latScale: 0.65,
    innerRadius: 1.2,
    outerRadius: 3.2,
    depthM: 1470.0,
    jerlov: JerlovWaterType.TYPE_IA,
    substrate: SeabedSubstrateType.ROCK_BASALT,
    threshold: 0.25,
    tidalOverride: 0.05,
  },
  // Hypersaline endorheic rift basin (Jerlov Coastal 1)
  {
    lon: 35.5,
    lat: 31.5,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 0.8,
    outerRadius: 2.2,
    depthM: 304.0,
    jerlov: JerlovWaterType.COASTAL_1,
    substrate: SeabedSubstrateType.SAND,
    threshold: 0.25,
    tidalOverride: 0.0,
  },
  // Ultra-oligotrophic alpine caldera / graben lake (Jerlov Type I)
  {
    lon: -120.0,
    lat: 39.1,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 1.0,
    outerRadius: 2.5,
    depthM: 501.0,
    jerlov: JerlovWaterType.TYPE_I,
    substrate: SeabedSubstrateType.ROCK_BASALT,
    threshold: 0.25,
    tidalOverride: 0.0,
  },
  // Northern cordillera glacial rock-flour lake (Jerlov Coastal 5)
  {
    lon: -116.2,
    lat: 51.4,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 1.1,
    outerRadius: 2.8,
    depthM: 70.0,
    jerlov: JerlovWaterType.COASTAL_5,
    substrate: SeabedSubstrateType.SILT_MUD,
    threshold: 0.25,
    tidalOverride: 0.0,
  },
  // High-CDOM tannin subtropical wetland basins (Jerlov Coastal 9)
  {
    lon: -80.8,
    lat: 25.6,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 1.0,
    outerRadius: 2.6,
    depthM: 2.5,
    jerlov: JerlovWaterType.COASTAL_9,
    substrate: SeabedSubstrateType.SILT_MUD,
    threshold: 0.25,
    extraCenters: [
      [-91.5, 29.85],
      [89.2, 21.95],
    ],
  },
  // Endorheic continental inland sea shelf (Jerlov Coastal 3)
  {
    lon: 50.0,
    lat: 40.4,
    lonScale: 1.0,
    latScale: 0.8,
    innerRadius: 1.5,
    outerRadius: 3.8,
    depthM: 38.0,
    jerlov: JerlovWaterType.COASTAL_3,
    substrate: SeabedSubstrateType.SAND,
    threshold: 0.25,
    tidalOverride: 0.1,
  },
  // Oligotrophic archipelago sea (Jerlov Type I)
  {
    lon: 25.4,
    lat: 36.4,
    lonScale: 0.75,
    latScale: 1.0,
    innerRadius: 1.8,
    outerRadius: 4.5,
    depthM: 260.0,
    jerlov: JerlovWaterType.TYPE_I,
    substrate: SeabedSubstrateType.ROCK_BASALT,
    threshold: 0.25,
  },
  // Southern hemisphere glacial rock-flour proglacial lakes (Jerlov Coastal 5)
  {
    lon: 170.16,
    lat: -44.12,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 1.0,
    outerRadius: 2.5,
    depthM: 75.0,
    jerlov: JerlovWaterType.COASTAL_5,
    substrate: SeabedSubstrateType.SILT_MUD,
    threshold: 0.25,
    tidalOverride: 0.0,
    extraCenters: [[-72.85, -50.25]],
  },
  // Endorheic playa hypersaline brine basins (Jerlov Coastal 1)
  {
    lon: -112.22,
    lat: 40.95,
    lonScale: 1.0,
    latScale: 1.0,
    innerRadius: 0.9,
    outerRadius: 2.4,
    depthM: 9.5,
    jerlov: JerlovWaterType.COASTAL_1,
    substrate: SeabedSubstrateType.SAND,
    threshold: 0.25,
    tidalOverride: 0.0,
    extraCenters: [[45.35, 37.65]],
  },
];

/**
 * Synthesizes a seamless Level 0 procedural planetary bathymetry tensor set.
 *
 * Models global seabed morphology:
 * - Continental shelves (0-200 m depth)
 * - Continental slopes (200-2000 m depth)
 * - Abyssal plains (3500-5000 m depth)
 * - Oceanic trenches (>6000 m depth)
 * - Coastal water clarity (Jerlov Coastal) versus open ocean (Jerlov I/IB)
 *
 * @param w Texture width (default 1440).
 * @param h Texture height (default 721).
 */
export function buildProceduralBathymetryTensor(
  w: number = WEATHER_MAP_TEX_WIDTH,
  h: number = WEATHER_MAP_TEX_HEIGHT,
): BathymetryTensorSet {
  const bathymetryBytes = new Uint8Array(w * h * 4);
  const coarseRow = new Float64Array(w);
  const fineRow = new Float64Array(w);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;

    // Periodic noise for tectonic continental margins and oceanic basins
    periodicFbmRow(coarseRow, w, v * 5, 5);
    periodicFbmRow(fineRow, w, v * 15, 15);

    for (let x = 0; x < w; x++) {
      const basinNoise = coarseRow[x] * 0.75 + fineRow[x] * 0.25;

      // Model morphology based on basin noise:
      // - < 0.35: Continental margin / shelf (0 - 200 m)
      // - 0.35 - 0.50: Continental slope (200 - 2500 m)
      // - 0.50 - 0.85: Abyssal plain (3500 - 5200 m)
      // - > 0.85: Deep ocean trench (6000 - 10500 m)
      let depthM: number;
      let jerlov: number;
      let substrate: number;
      let tidalRange: number;

      if (basinNoise < 0.35) {
        // Continental shelf
        const t = basinNoise / 0.35;
        depthM = t * BATHYMETRY_SHELF_DEPTH_M;
        jerlov = JerlovWaterType.COASTAL_3;
        substrate = SeabedSubstrateType.SAND;
        tidalRange = 3.5 * (1.0 - t) + 1.0;
      } else if (basinNoise < 0.5) {
        // Continental slope
        const t = (basinNoise - 0.35) / 0.15;
        depthM =
          BATHYMETRY_SHELF_DEPTH_M + t * (2500.0 - BATHYMETRY_SHELF_DEPTH_M);
        jerlov = JerlovWaterType.TYPE_II;
        substrate = SeabedSubstrateType.SILT_MUD;
        tidalRange = 1.0;
      } else if (basinNoise < 0.85) {
        // Abyssal plain
        const t = (basinNoise - 0.5) / 0.35;
        depthM = 3500.0 + t * 1700.0;
        jerlov = JerlovWaterType.TYPE_IB;
        substrate = SeabedSubstrateType.ABYSSAL_SEDIMENT;
        tidalRange = 0.5;
      } else {
        // Ocean trench
        const t = (basinNoise - 0.85) / 0.15;
        depthM = 5200.0 + t * 5300.0;
        jerlov = JerlovWaterType.TYPE_I;
        substrate = SeabedSubstrateType.ROCK_BASALT;
        tidalRange = 0.3;
      }

      const lonDeg = ((x + 0.5) / w) * 360.0 - 180.0;
      const latDeg = 90.0 - v * 180.0;

      // Apply hydrographic basin category envelopes (carbonate shoals, barrier reefs, hadal trenches,
      // turbid river deltas, tectonic rift basins, endorheic brines, alpine calderas, glacial lakes, wetlands, inland seas)
      for (let b = 0; b < HYDROGRAPHIC_BASIN_ENVELOPES.length; b++) {
        const basin = HYDROGRAPHIC_BASIN_ENVELOPES[b];
        let dist = Math.hypot(
          (lonDeg - basin.lon) * basin.lonScale,
          (latDeg - basin.lat) * basin.latScale,
        );
        if (basin.extraCenters) {
          for (let c = 0; c < basin.extraCenters.length; c++) {
            const ec = basin.extraCenters[c];
            const d2 = Math.hypot(lonDeg - ec[0], latDeg - ec[1]);
            if (d2 < dist) {
              dist = d2;
            }
          }
        }
        if (dist < basin.outerRadius) {
          const weight = Math.min(
            1.0,
            Math.max(
              0.0,
              1.0 -
                Math.max(0.0, dist - basin.innerRadius) /
                  (basin.outerRadius - basin.innerRadius),
            ),
          );
          depthM = depthM * (1.0 - weight) + basin.depthM * weight;
          if (weight > basin.threshold) {
            jerlov = basin.jerlov;
            substrate = basin.substrate;
          }
          if (basin.tidalOverride !== undefined) {
            tidalRange =
              basin.tidalOverride === 0.0
                ? 0.0
                : tidalRange * (1.0 - weight) + basin.tidalOverride * weight;
          }
        }
      }

      // Pack into RGBA8
      const i = (y * w + x) * 4;
      bathymetryBytes[i] = encodeDepth(depthM);
      bathymetryBytes[i + 1] = encodeJerlovType(jerlov);
      bathymetryBytes[i + 2] = encodeSubstrate(substrate);
      bathymetryBytes[i + 3] = encodeTidalRange(tidalRange);
    }
  }

  // Ensure seamless polar caps
  applyEquirectPolarLowPass(bathymetryBytes, w, h);

  const tensorSet: BathymetryTensorSet = {
    width: w,
    height: h,
    bathymetryBytes,
  };
  tensorSet.sample = function (lon: number, lat: number) {
    return sampleBathymetryTensor(tensorSet, lon, lat);
  };
  return tensorSet;
}

/** Refractive index of seawater relative to air. */
export const SEAWATER_REFRACTIVE_INDEX = 1.333333;

/**
 * Critical angle of Snell's Window in radians (~0.848062 rad = 48.59 deg),
 * where sin(theta_crit) = 1.0 / 1.333333.
 */
export const SNELL_CRITICAL_ANGLE_RAD = Math.asin(
  1.0 / SEAWATER_REFRACTIVE_INDEX,
);

/**
 * Carbonate Compensation Depth (CCD) in metres (~4,500 m), below which calcium
 * carbonate dissolves and pale pelagic ooze transitions to dark abyssal clay.
 */
export const CARBONATE_COMPENSATION_DEPTH_M = 4500.0;

/**
 * Vertical oceanographic depth regimes from surface air down to hadal trenches.
 */
export const PelagicZone = Object.freeze({
  SURFACE_AIR: "SURFACE_AIR",
  EPIPELAGIC_PHOTIC: "EPIPELAGIC_PHOTIC",
  MESOPELAGIC_TWILIGHT: "MESOPELAGIC_TWILIGHT",
  BATHYPELAGIC_MIDNIGHT: "BATHYPELAGIC_MIDNIGHT",
  ABYSSOPELAGIC: "ABYSSOPELAGIC",
  HADOPELAGIC_TRENCH: "HADOPELAGIC_TRENCH",
} as const);

export interface SnellsWindowOptics {
  isTotalInternalReflection: boolean;
  fresnelReflectance: number;
  transmittanceToSky: number;
  refractedAirZenithCos: number;
  chromaticRimFactor: number;
  refractedChannelCos: { r: number; g: number; b: number };
}

/**
 * Evaluates upward-looking Snell's Window refraction and Total Internal Reflection (TIR)
 * across the water-to-air interface for a submerged camera.
 *
 * Inside the 48.6 deg critical cone (`cosUpZenith > cos(48.59 deg) ≈ 0.661438`), rays
 * refract into the compressed 180 deg sky hemisphere with subtle prismatic dispersion
 * (`n_R = 1.331, n_G = 1.334, n_B = 1.338`) near the critical rim. Outside the cone
 * (`cosUpZenith <= 0.661438`), Total Internal Reflection (`fresnelReflectance = 1.0`)
 * reflects the internal underwater column.
 *
 * @param cosUpZenith Cosine of angle between upward view vector and surface normal.
 */
export function evaluateSnellsWindowOptics(
  cosUpZenith: number,
): SnellsWindowOptics {
  const cosThetaI = clamp(cosUpZenith, -1.0, 1.0);
  if (cosThetaI <= 0.0) {
    return {
      isTotalInternalReflection: true,
      fresnelReflectance: 1.0,
      transmittanceToSky: 0.0,
      refractedAirZenithCos: 0.0,
      chromaticRimFactor: 0.0,
      refractedChannelCos: { r: 0.0, g: 0.0, b: 0.0 },
    };
  }
  const eta = SEAWATER_REFRACTIVE_INDEX;
  const sin2ThetaI = Math.max(0.0, 1.0 - cosThetaI * cosThetaI);
  const sin2ThetaT = eta * eta * sin2ThetaI;
  if (sin2ThetaT >= 1.0) {
    return {
      isTotalInternalReflection: true,
      fresnelReflectance: 1.0,
      transmittanceToSky: 0.0,
      refractedAirZenithCos: 0.0,
      chromaticRimFactor: 0.0,
      refractedChannelCos: { r: 0.0, g: 0.0, b: 0.0 },
    };
  }

  const cosThetaT = Math.sqrt(Math.max(0.0, 1.0 - sin2ThetaT));
  const cosThetaR = Math.sqrt(Math.max(0.0, 1.0 - 1.331 * 1.331 * sin2ThetaI));
  const cosThetaG = Math.sqrt(Math.max(0.0, 1.0 - 1.334 * 1.334 * sin2ThetaI));
  const cosThetaB = Math.sqrt(Math.max(0.0, 1.0 - 1.338 * 1.338 * sin2ThetaI));

  const rsNum = eta * cosThetaI - cosThetaT;
  const rsDen = Math.max(eta * cosThetaI + cosThetaT, 1e-6);
  const rpNum = cosThetaI - eta * cosThetaT;
  const rpDen = Math.max(cosThetaI + eta * cosThetaT, 1e-6);
  const rs = (rsNum / rsDen) * (rsNum / rsDen);
  const rp = (rpNum / rpDen) * (rpNum / rpDen);
  const fresnel = clamp(0.5 * (rs + rp), 0.0, 1.0);

  // Chromatic dispersion rim peaks just inside the critical angle (sin2ThetaT in [0.82, 0.999])
  const rimT = clamp((sin2ThetaT - 0.8) / 0.195, 0.0, 1.0);
  const chromaticRim = rimT * (1.0 - fresnel * 0.5);

  return {
    isTotalInternalReflection: false,
    fresnelReflectance: fresnel,
    transmittanceToSky: 1.0 - fresnel,
    refractedAirZenithCos: cosThetaT,
    chromaticRimFactor: chromaticRim,
    refractedChannelCos: { r: cosThetaR, g: cosThetaG, b: cosThetaB },
  };
}

export interface SeabedSubstrateOptics {
  albedo: { r: number; g: number; b: number };
  microRoughness: number;
  carbonateOozeFraction: number;
  substrateClassification: number;
}

/**
 * Evaluates seabed benthic reflectance, micro-roughness, and Carbonate Compensation
 * Depth (CCD ~ 4,500 m) grading across shelf, slope, abyssal, and hadal substrates.
 */
export function evaluateSeabedSubstrateOptics(
  depthMeters: number,
  substrateType: number = SeabedSubstrateType.SAND,
  slopeRadians: number = 0.0,
): SeabedSubstrateOptics {
  const d = Math.max(0.0, depthMeters);
  const steepWall = slopeRadians > 0.48; // > ~27.5 deg exposes bedrock/basalt

  // Carbonate Compensation Depth (CCD) transition around 4,500 m
  const ccdFactor = clamp(
    1.0 - (d - 3800.0) / (CARBONATE_COMPENSATION_DEPTH_M + 500.0 - 3800.0),
    0.0,
    1.0,
  );

  if (
    steepWall ||
    d >= 6000.0 ||
    substrateType === SeabedSubstrateType.ROCK_BASALT
  ) {
    return {
      albedo: { r: 0.14, g: 0.15, b: 0.17 },
      microRoughness: 0.78,
      carbonateOozeFraction: 0.0,
      substrateClassification: SeabedSubstrateType.ROCK_BASALT,
    };
  }

  if (d < BATHYMETRY_SHELF_DEPTH_M) {
    if (substrateType === SeabedSubstrateType.CORAL_REEF && d < 45.0) {
      return {
        albedo: { r: 0.36, g: 0.34, b: 0.28 },
        microRoughness: 0.62,
        carbonateOozeFraction: 0.85,
        substrateClassification: SeabedSubstrateType.CORAL_REEF,
      };
    }
    return {
      albedo: { r: 0.44, g: 0.41, b: 0.34 },
      microRoughness: 0.32,
      carbonateOozeFraction: 0.9,
      substrateClassification: SeabedSubstrateType.SAND,
    };
  }

  if (d < 2500.0 || substrateType === SeabedSubstrateType.SILT_MUD) {
    return {
      albedo: { r: 0.26, g: 0.27, b: 0.24 },
      microRoughness: 0.45,
      carbonateOozeFraction: 0.55 * ccdFactor,
      substrateClassification: SeabedSubstrateType.SILT_MUD,
    };
  }

  // Abyssal plain: transition from pale pelagic carbonate ooze above CCD to dark abyssal clay below CCD
  const oozeR = 0.34;
  const oozeG = 0.35;
  const oozeB = 0.36;
  const clayR = 0.18;
  const clayG = 0.16;
  const clayB = 0.15;

  return {
    albedo: {
      r: clayR + (oozeR - clayR) * ccdFactor,
      g: clayG + (oozeG - clayG) * ccdFactor,
      b: clayB + (oozeB - clayB) * ccdFactor,
    },
    microRoughness: 0.38,
    carbonateOozeFraction: ccdFactor,
    substrateClassification: SeabedSubstrateType.ABYSSAL_SEDIMENT,
  };
}

export interface UnderwaterVerticalProfileOptions {
  jerlovType?: number;
  viewPitchRadians?: number;
  submersibleLightEnabled?: boolean;
  submersibleLightIntensity?: number;
  targetRangeMeters?: number;
  bathymetricReliefBoost?: number;
}

export interface UnderwaterVerticalProfile {
  pelagicZone: string;
  submergedDepthMeters: number;
  downwellingSolarIrradiance: { r: number; g: number; b: number };
  inscatterColor: { r: number; g: number; b: number };
  causticIntensity: number;
  skyDomeSuppression: number;
  fftComputeActive: boolean;
  marineSnowVisibility: number;
  submersibleSpotlightIrradiance: { r: number; g: number; b: number };
  bathymetricReliefScale: number;
}

/**
 * Evaluates the continuous physical vertical underwater optical profile from
 * the surface (`0 m`) through the Epipelagic Photic (`0-200 m`), Mesopelagic
 * Twilight (`200-1,000 m`), Bathypelagic (`1,000-4,000 m`), Abyssopelagic
 * (`4,000-6,000 m`), and Hadopelagic Trench (`6,000-11,000 m`) zones.
 *
 * Strictly physical by default: below `1,000 m`, solar downwelling irradiance
 * decays below `1e-4` and no artificial spotlight is active unless
 * `options.submersibleLightEnabled === true`.
 */
export function evaluateUnderwaterVerticalProfile(
  submergedDepthMeters: number,
  options: UnderwaterVerticalProfileOptions = {},
): UnderwaterVerticalProfile {
  const jerlov = clamp(options.jerlovType ?? JerlovWaterType.TYPE_IB, 0, 9);
  const pitchRad = options.viewPitchRadians ?? 0.0;
  const spotlightOn = options.submersibleLightEnabled === true;
  const spotlightGain = Math.max(0.0, options.submersibleLightIntensity ?? 1.0);
  const targetRange = Math.max(1.0, options.targetRangeMeters ?? 12.0);
  const reliefBoost = clamp(options.bathymetricReliefBoost ?? 0.0, 0.0, 2.0);

  if (submergedDepthMeters < 0.0) {
    return {
      pelagicZone: PelagicZone.SURFACE_AIR,
      submergedDepthMeters,
      downwellingSolarIrradiance: { r: 1.0, g: 1.0, b: 1.0 },
      inscatterColor: { r: 0.05, g: 0.25, b: 0.35 },
      causticIntensity: 0.0,
      skyDomeSuppression: 0.0,
      fftComputeActive: true,
      marineSnowVisibility: 0.0,
      submersibleSpotlightIrradiance: { r: 0.0, g: 0.0, b: 0.0 },
      bathymetricReliefScale: 1.0 + reliefBoost,
    };
  }

  const z = clamp(submergedDepthMeters, 0.0, BATHYMETRY_MAX_DEPTH_M);
  let pelagicZone: string = PelagicZone.EPIPELAGIC_PHOTIC;
  if (z >= 6000.0) {
    pelagicZone = PelagicZone.HADOPELAGIC_TRENCH;
  } else if (z >= 4000.0) {
    pelagicZone = PelagicZone.ABYSSOPELAGIC;
  } else if (z >= 1000.0) {
    pelagicZone = PelagicZone.BATHYPELAGIC_MIDNIGHT;
  } else if (z >= 200.0) {
    pelagicZone = PelagicZone.MESOPELAGIC_TWILIGHT;
  }

  // Diffuse vertical attenuation Kd(lambda) scaled by Jerlov clarity class:
  // Red extinguishes in upper 15-30 m, Green by 120-200 m, Blue (475 nm) reaches ~1,000 m.
  const turbidityScale = 1.0 + (jerlov / 9.0) * 1.6;
  const kdR = 0.22 * turbidityScale;
  const kdG = 0.032 * turbidityScale;
  const kdB = 0.0095 * (1.0 + (jerlov / 9.0) * 0.85);

  const downR = Math.exp(-kdR * z);
  const downG = Math.exp(-kdG * z);
  const downB = Math.exp(-kdB * z);

  // Pitch-stratified Gordon in-scattering: looking upward (+pitch) catches brighter
  // cyan-blue downwelling light; looking downward (-pitch) shifts toward deep indigo-navy.
  const pitchFactor = clamp(Math.sin(pitchRad) * 0.5 + 0.5, 0.0, 1.0);
  const baseScatterR = 0.02 * downR + 0.008 * downG;
  const baseScatterG = 0.22 * downG + 0.04 * downB;
  const baseScatterB = 0.38 * downB;
  const pitchGain = 0.55 + 0.75 * pitchFactor;

  const inscatterColor = {
    r: baseScatterR * pitchGain,
    g: baseScatterG * pitchGain,
    b: baseScatterB * pitchGain,
  };

  // Caustics active in shallow photic zone (0 - 65 m)
  const causticIntensity =
    z < 80.0 ? Math.exp(-0.048 * z) * (1.0 - clamp(z / 80.0, 0.0, 1.0)) : 0.0;

  // Sky dome suppression ramps quickly once submerged and reaches 1.0 by 80 m depth
  const skyDomeSuppression = clamp(
    1.0 - Math.exp(-0.055 * (z + 2.0)),
    0.0,
    1.0,
  );

  // Auto-sleep surface FFT compute when submerged deeper than 80 m
  const fftComputeActive = z <= 80.0;

  // Opt-in ROV submersible spotlight with inverse-square + Beer-Lambert attenuation
  let spotR = 0.0;
  let spotG = 0.0;
  let spotB = 0.0;
  if (spotlightOn && spotlightGain > 0.0) {
    const geomAtten =
      (spotlightGain * 45.0) /
      Math.max(1.0 + 0.08 * targetRange * targetRange, 1.0);
    spotR = geomAtten * Math.exp(-0.045 * targetRange);
    spotG = geomAtten * Math.exp(-0.015 * targetRange);
    spotB = geomAtten * Math.exp(-0.008 * targetRange);
  }

  // Marine snow visibility: illuminated by twilight blue scatter or by active ROV spotlight
  const ambientLum = downG * 0.3 + downB * 0.7;
  const spotLum = (spotR + spotG + spotB) / 3.0;
  const depthSnowFactor = clamp((z - 15.0) / 185.0, 0.0, 1.0);
  const marineSnowVisibility =
    depthSnowFactor * clamp(ambientLum * 1.8 + spotLum * 0.85, 0.0, 1.0);

  return {
    pelagicZone,
    submergedDepthMeters: z,
    downwellingSolarIrradiance: { r: downR, g: downG, b: downB },
    inscatterColor,
    causticIntensity,
    skyDomeSuppression,
    fftComputeActive,
    marineSnowVisibility,
    submersibleSpotlightIrradiance: { r: spotR, g: spotG, b: spotB },
    bathymetricReliefScale: 1.0 + reliefBoost,
  };
}

export interface WaterlineMeniscusAndWetness {
  isSplitLensActive: boolean;
  meniscusScreenY: number;
  isPixelSubmerged: boolean;
  meniscusGlowIntensity: number;
  emergenceWetnessFactor: number;
}

/**
 * Evaluates the split-lens waterline meniscus when a camera crosses the wave
 * surface (`|h_cam - eta_wave| <= 2.0 m`) and the 1.5 s lens water-sheeting
 * decay upon emerging into the air.
 *
 * @param cameraAltitudeMeters Camera altitude relative to mean sea level in metres.
 * @param waveElevationMeters Instantaneous wave elevation at the camera in metres.
 * @param timeSinceEmergenceSeconds Seconds elapsed since the camera emerged from underwater.
 * @param screenY Normalized vertical screen coordinate (`0 = bottom`, `1 = top`).
 * @param nearPlaneSpanMeters Vertical span of the camera near-plane in metres (default `2.0`).
 */
export function evaluateWaterlineMeniscusAndWetness(
  cameraAltitudeMeters: number,
  waveElevationMeters: number = 0.0,
  timeSinceEmergenceSeconds: number = 10.0,
  screenY: number = 0.5,
  nearPlaneSpanMeters: number = 2.0,
): WaterlineMeniscusAndWetness {
  const deltaH = cameraAltitudeMeters - waveElevationMeters;
  const halfSpan = Math.max(0.25, nearPlaneSpanMeters);
  const isSplitLensActive = Math.abs(deltaH) <= halfSpan;

  const meniscusScreenY = clamp(0.5 - deltaH / (2.0 * halfSpan), 0.0, 1.0);
  const isPixelSubmerged =
    deltaH < -halfSpan
      ? true
      : deltaH > halfSpan
        ? false
        : screenY < meniscusScreenY;

  const distToMeniscus = Math.abs(screenY - meniscusScreenY);
  const meniscusGlowIntensity = isSplitLensActive
    ? Math.exp(-(distToMeniscus * distToMeniscus) / (2.0 * 0.018 * 0.018))
    : 0.0;

  let emergenceWetnessFactor = 0.0;
  if (
    deltaH >= 0.0 &&
    timeSinceEmergenceSeconds >= 0.0 &&
    timeSinceEmergenceSeconds < 1.5
  ) {
    const linearFade = clamp(1.0 - timeSinceEmergenceSeconds / 1.5, 0.0, 1.0);
    emergenceWetnessFactor =
      Math.exp(-timeSinceEmergenceSeconds / 0.55) * linearFade;
  }

  return {
    isSplitLensActive,
    meniscusScreenY,
    isPixelSubmerged,
    meniscusGlowIntensity,
    emergenceWetnessFactor,
  };
}

export interface BenthicMicroReliefResult {
  normalENU: { x: number; y: number; z: number };
  distanceFade: number;
  coralVoronoiCellIntensity: number;
  sandRipplePhase: number;
  hydrothermalShimmerIntensity: number;
}

/**
 * Synthesizes close-range (`< 150 m`) procedural ENU micro-normals and benthic
 * detail driven by substrate classes: current-aligned 3D sand ripples on sandy
 * shelves, cellular Voronoi coral micro-relief in tropical shallows (`< 45 m`),
 * and pillow-basalt / hydrothermal rift shimmer in deep trenches (`> 2,200 m`).
 */
export function evaluateBenthicMicroRelief(
  depthMeters: number,
  distanceMeters: number,
  substrateType: number = SeabedSubstrateType.SAND,
  latitudeRadians: number = 0.0,
  u: number = 0.5,
  v: number = 0.5,
): BenthicMicroReliefResult {
  const d = Math.max(0.0, depthMeters);
  const dist = Math.max(0.0, distanceMeters);
  const tFade = clamp((dist - 80.0) / (150.0 - 80.0), 0.0, 1.0);
  const distanceFade = 1.0 - tFade * tFade * (3.0 - 2.0 * tFade);

  if (distanceFade <= 1e-5) {
    return {
      normalENU: { x: 0.0, y: 0.0, z: 1.0 },
      distanceFade: 0.0,
      coralVoronoiCellIntensity: 0.0,
      sandRipplePhase: 0.0,
      hydrothermalShimmerIntensity: 0.0,
    };
  }

  const absLat = Math.abs(latitudeRadians);
  const isTropicalCoral =
    (substrateType === SeabedSubstrateType.CORAL_REEF || absLat < 0.56) &&
    d > 0.2 &&
    d < 45.0;

  // Current-aligned asymmetric 3D sand ripples
  const rippleCoord = u * 36.0 + v * 12.0;
  const sandRipplePhase =
    Math.sin(rippleCoord + 0.35 * Math.sin(rippleCoord)) * distanceFade;

  let nx: number;
  let ny: number;
  let coralVoronoi = 0.0;
  let hydrothermalShimmer = 0.0;

  if (isTropicalCoral) {
    const cx = u * 24.0 - Math.floor(u * 24.0) - 0.5;
    const cy = v * 24.0 - Math.floor(v * 24.0) - 0.5;
    const rCell = Math.sqrt(cx * cx + cy * cy);
    coralVoronoi = clamp(1.0 - rCell * 1.4, 0.0, 1.0) * distanceFade;
    nx = -cx * 0.65 * distanceFade;
    ny = -cy * 0.65 * distanceFade;
  } else if (substrateType === SeabedSubstrateType.ROCK_BASALT || d >= 2200.0) {
    const bx = Math.sin(u * 48.0) * Math.cos(v * 48.0);
    const by = Math.cos(u * 48.0) * Math.sin(v * 48.0);
    nx = bx * 0.48 * distanceFade;
    ny = by * 0.48 * distanceFade;
    if (d >= 2200.0) {
      const trenchFactor = clamp((d - 2200.0) / 3800.0, 0.0, 1.0);
      hydrothermalShimmer =
        trenchFactor *
        (0.5 + 0.5 * Math.sin(u * 90.0 + v * 70.0)) *
        distanceFade;
    }
  } else {
    // Sandy / silty seafloor ripples
    const dRipple =
      Math.cos(rippleCoord + 0.35 * Math.sin(rippleCoord)) *
      (1.0 + 0.35 * Math.cos(rippleCoord));
    nx = dRipple * 0.32 * distanceFade;
    ny = dRipple * 0.11 * distanceFade;
  }

  const nz = Math.sqrt(Math.max(0.05, 1.0 - nx * nx - ny * ny));
  const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);

  return {
    normalENU: { x: nx * invLen, y: ny * invLen, z: nz * invLen },
    distanceFade,
    coralVoronoiCellIntensity: coralVoronoi,
    sandRipplePhase,
    hydrothermalShimmerIntensity: hydrothermalShimmer,
  };
}

export interface ShoreRefractionAndSwashOptics {
  refractedWaveAzimuthRad: number;
  refractionAlignmentFactor: number;
  subsurfaceBubblePlumeIntensity: number;
  subsurfaceBubbleColor: { r: number; g: number; b: number };
  wetSandFilmFactor: number;
  wetSandRoughness: number;
  wetSandAlbedoScale: number;
}

/**
 * Evaluates shore-aligned wave refraction along the shoreline SDF gradient
 * (`-grad(d_SDF)`), subsurface aerated jade-emerald bubble plumes (`4.5 s` decay),
 * and receding wet-sand mirror thin-film optics (`roughness = 0.04`, `45%` darkening).
 */
export function evaluateShoreRefractionAndSwashOptics(
  shoreSdf: number,
  sdfGradientAzimuthRad: number,
  offshoreWaveAzimuthRad: number,
  timeSeconds: number = 0.0,
): ShoreRefractionAndSwashOptics {
  const sdf = clamp(shoreSdf, 0.0, 1.0);
  // As shoreSdf approaches the 0.50 coastline from offshore (0.85 -> 0.50),
  // shallow-water phase speed c = sqrt(g*h) bends wave crests parallel to shore.
  const shoalingT = 1.0 - clamp((sdf - 0.5) / 0.35, 0.0, 1.0);
  const refractionAlignmentFactor =
    shoalingT * shoalingT * (3.0 - 2.0 * shoalingT);

  // Shortest-arc angular interpolation toward shore-normal azimuth
  let deltaAngle = sdfGradientAzimuthRad - offshoreWaveAzimuthRad;
  while (deltaAngle > Math.PI) {
    deltaAngle -= 2.0 * Math.PI;
  }
  while (deltaAngle < -Math.PI) {
    deltaAngle += 2.0 * Math.PI;
  }
  const refractedWaveAzimuthRad =
    offshoreWaveAzimuthRad + deltaAngle * refractionAlignmentFactor;

  // Subsurface aerated jade-emerald bubble plumes (4.5 s exponential decay)
  const waveCycle = ((timeSeconds % 4.5) + 4.5) % 4.5;
  const surfBand =
    clamp((sdf - 0.42) / 0.12, 0.0, 1.0) *
    (1.0 - clamp((sdf - 0.72) / 0.2, 0.0, 1.0));
  const plumeDecay = Math.exp(-waveCycle / 2.25);
  const subsurfaceBubblePlumeIntensity = clamp(surfBand * plumeDecay, 0.0, 1.0);

  // Intertidal wet-sand mirror swash band (shoreSdf in [0.36, 0.56])
  const swashBand =
    clamp((sdf - 0.36) / 0.08, 0.0, 1.0) *
    (1.0 - clamp((sdf - 0.5) / 0.08, 0.0, 1.0));
  const swashDrain = Math.exp(-waveCycle / 3.8);
  const wetSandFilmFactor = clamp(swashBand * swashDrain, 0.0, 1.0);
  const wetSandRoughness = 0.42 + (0.04 - 0.42) * wetSandFilmFactor;
  const wetSandAlbedoScale = 1.0 - 0.45 * wetSandFilmFactor;

  return {
    refractedWaveAzimuthRad,
    refractionAlignmentFactor,
    subsurfaceBubblePlumeIntensity,
    subsurfaceBubbleColor: { r: 0.06, g: 0.58, b: 0.46 },
    wetSandFilmFactor,
    wetSandRoughness,
    wetSandAlbedoScale,
  };
}

export const PolarSeaIceRegime = Object.freeze({
  OPEN_WATER: "OPEN_WATER",
  FRAZIL_GREASE_SLUSH: "FRAZIL_GREASE_SLUSH",
  PANCAKE_ICE_FLOES: "PANCAKE_ICE_FLOES",
  CONSOLIDATED_PACK_ICE: "CONSOLIDATED_PACK_ICE",
} as const);

export interface PolarSeaIceAndGlacialOptics {
  iceRegime: string;
  iceConcentration: number;
  capillaryWaveDamping: number;
  pancakeRimFactor: number;
  iceAlbedo: { r: number; g: number; b: number };
  glacialFlourTurbidity: number;
  glacialPlumeColor: { r: number; g: number; b: number };
}

/**
 * Evaluates high-latitude (`|lat| > 62 deg`) polar sea ice transitions
 * (frazil slush -> Voronoi pancake ice floes -> consolidated pack ice) and
 * coastal glacial fjord rock-flour (`Jerlov 7C`) milky-cyan meltwater plumes.
 */
export function evaluatePolarSeaIceAndGlacialOptics(
  latitudeRadians: number,
  solarDeclinationRadians: number = 0.0,
  shoreSdf: number = 0.8,
  cellU: number = 0.35,
  cellV: number = 0.35,
): PolarSeaIceAndGlacialOptics {
  const absLat = Math.abs(latitudeRadians);
  // Seasonal winter hemisphere shift (+/- 4 deg)
  const sameHemisphere =
    latitudeRadians * solarDeclinationRadians > 0.0 ? 1.0 : -1.0;
  const seasonalShift =
    sameHemisphere * Math.abs(solarDeclinationRadians) * 0.3;
  const iceEdgeLat = 1.082104 + seasonalShift; // 62 deg baseline

  const rawIce = clamp((absLat - iceEdgeLat) / 0.24, 0.0, 1.0);
  const iceConcentration = rawIce * rawIce * (3.0 - 2.0 * rawIce);

  // Voronoi pancake floe cell distance
  const fx = cellU - Math.floor(cellU) - 0.5;
  const fy = cellV - Math.floor(cellV) - 0.5;
  const cellRadius = Math.sqrt(fx * fx + fy * fy) * 1.4142;
  const pancakeRimFactor =
    iceConcentration > 0.15 && iceConcentration < 0.82
      ? clamp((cellRadius - 0.62) / 0.22, 0.0, 1.0) *
        (1.0 - clamp((cellRadius - 0.88) / 0.1, 0.0, 1.0))
      : 0.0;

  let iceRegime: string = PolarSeaIceRegime.OPEN_WATER;
  if (iceConcentration >= 0.78) {
    iceRegime = PolarSeaIceRegime.CONSOLIDATED_PACK_ICE;
  } else if (iceConcentration >= 0.32) {
    iceRegime = PolarSeaIceRegime.PANCAKE_ICE_FLOES;
  } else if (iceConcentration >= 0.05) {
    iceRegime = PolarSeaIceRegime.FRAZIL_GREASE_SLUSH;
  }

  // Glacial rock-flour (Jerlov 7C) meltwater plumes in subpolar/polar coastal fjords (|lat| > 54 deg)
  const fjordLatGate = clamp((absLat - 0.942478) / 0.18, 0.0, 1.0);
  const coastalGate = 1.0 - clamp((shoreSdf - 0.48) / 0.26, 0.0, 1.0);
  const glacialFlourTurbidity = clamp(
    fjordLatGate * coastalGate * (1.0 - iceConcentration * 0.6),
    0.0,
    1.0,
  );

  return {
    iceRegime,
    iceConcentration,
    capillaryWaveDamping: clamp(iceConcentration * 1.35, 0.0, 1.0),
    pancakeRimFactor,
    iceAlbedo: {
      r: 0.12 + 0.72 * iceConcentration,
      g: 0.22 + 0.69 * iceConcentration,
      b: 0.32 + 0.64 * iceConcentration,
    },
    glacialFlourTurbidity,
    glacialPlumeColor: { r: 0.28, g: 0.68, b: 0.74 },
  };
}

export interface BuoyancyAndKelvinWakeSlot {
  elevationMeters: number;
  normal: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  kelvinWakeDisplacementMeters: number;
  kelvinWakeFoam: number;
}

/**
 * Evaluates up to 64 batched buoyancy query slots using 2 fixed-point horizontal
 * Gerstner displacement inversions plus the analytical Lord Kelvin 19.47 deg
 * (`arcsin(1/3)`) V-wake pattern behind a moving vessel or seaplane.
 */
export function evaluateKelvinWakeAndBuoyancyQuery(
  queries: ReadonlyArray<{ x: number; y: number }>,
  vesselState: {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    lengthMeters?: number;
  } = {},
  waveParams: {
    amplitudeMeters?: number;
    wavelengthMeters?: number;
    directionRad?: number;
    timeSeconds?: number;
  } = {},
): BuoyancyAndKelvinWakeSlot[] {
  const maxSlots = Math.min(queries.length, 64);
  const amp = waveParams.amplitudeMeters ?? 1.2;
  const wavelength = Math.max(4.0, waveParams.wavelengthMeters ?? 48.0);
  const k = (2.0 * Math.PI) / wavelength;
  const omega = Math.sqrt(9.80665 * k);
  const dirRad = waveParams.directionRad ?? 0.0;
  const dx = Math.cos(dirRad);
  const dy = Math.sin(dirRad);
  const t = waveParams.timeSeconds ?? 0.0;
  const steepness = 0.45;

  const vx = vesselState.vx ?? 0.0;
  const vy = vesselState.vy ?? 0.0;
  const speed = Math.sqrt(vx * vx + vy * vy);
  const vesselX = vesselState.x ?? 0.0;
  const vesselY = vesselState.y ?? 0.0;
  const hullLen = Math.max(4.0, vesselState.lengthMeters ?? 24.0);

  // Lord Kelvin half-angle: arcsin(1/3) ≈ 0.3398369 rad (19.47122 deg)
  const kelvinTan = 1.0 / Math.sqrt(8.0); // tan(arcsin(1/3)) = 1 / (2*sqrt(2)) ≈ 0.3535534

  const results: BuoyancyAndKelvinWakeSlot[] = new Array(maxSlots);
  for (let i = 0; i < maxSlots; i++) {
    const q = queries[i];
    // 2 fixed-point Eulerian-to-Lagrangian horizontal Gerstner inversions:
    // x^(m+1) = x_q - Delta_horiz(x^(m), t)
    let sx = q.x;
    let sy = q.y;
    for (let iter = 0; iter < 2; iter++) {
      const phaseIter = k * (dx * sx + dy * sy) - omega * t;
      const horizDisp = steepness * amp * Math.cos(phaseIter);
      sx = q.x - dx * horizDisp;
      sy = q.y - dy * horizDisp;
    }

    const phase = k * (dx * sx + dy * sy) - omega * t;
    const sinP = Math.sin(phase);
    const cosP = Math.cos(phase);
    let elev = amp * sinP;
    const nx = -dx * k * amp * cosP;
    const ny = -dy * k * amp * cosP;
    const vz = -amp * omega * cosP;
    const vHoriz = steepness * amp * omega * sinP;

    let kelvinDisp = 0.0;
    let kelvinFoam = 0.0;
    if (speed > 0.5) {
      const fvx = vx / speed;
      const fvy = vy / speed;
      const rvx = -fvy;
      const rvy = fvx;
      const relX = q.x - vesselX;
      const relY = q.y - vesselY;
      // Stern-ward distance along wake axis (positive behind vessel)
      const behind = -(relX * fvx + relY * fvy);
      const lateral = Math.abs(relX * rvx + relY * rvy);

      if (behind > 0.0 && behind < hullLen * 30.0) {
        const wakeHalfWidth = behind * kelvinTan;
        const normLat = lateral / Math.max(wakeHalfWidth, 0.5);
        if (normLat <= 1.35) {
          const cuspEnvelope = Math.exp(
            -((normLat - 1.0) * (normLat - 1.0)) / (2.0 * 0.16 * 0.16),
          );
          const innerEnvelope = normLat < 1.0 ? 0.45 * (1.0 - normLat) : 0.0;
          const distAtten = Math.exp(-behind / (hullLen * 10.0));
          const kWake = (9.80665 / (speed * speed)) * 1.5;
          const transverseWave = Math.cos(kWake * behind);
          const divergentWave = Math.cos(
            kWake * (behind * 0.7 + lateral * 1.8),
          );
          const froudeGain = clamp(speed / 12.0, 0.0, 1.5);
          kelvinDisp =
            (cuspEnvelope * divergentWave * 0.65 +
              innerEnvelope * transverseWave * 0.35) *
            distAtten *
            froudeGain *
            0.55;
          kelvinFoam = clamp(
            (cuspEnvelope * 0.85 + innerEnvelope * 0.3) *
              distAtten *
              froudeGain,
            0.0,
            1.0,
          );
          elev += kelvinDisp;
        }
      }
    }

    const invN = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0);
    results[i] = {
      elevationMeters: elev,
      normal: { x: nx * invN, y: ny * invN, z: invN },
      velocity: { x: dx * vHoriz, y: dy * vHoriz, z: vz },
      kelvinWakeDisplacementMeters: kelvinDisp,
      kelvinWakeFoam: kelvinFoam,
    };
  }

  return results;
}

export interface Case2BioOpticalParams {
  /** Colored Dissolved Organic Matter / humic tannin concentration [0.0, 5.0]. */
  cdomConcentration?: number;
  /** Chlorophyll-a / phytoplankton & macrophyte concentration [0.0, 5.0]. */
  chlorophyllConcentration?: number;
  /** Suspended Particulate Mineral Matter (SPM) concentration [0.0, 5.0]. */
  mineralSpmConcentration?: number;
  /** Fraction of mineral SPM consisting of fine glacial rock flour (1.0) vs ochre alluvial silt (0.0). */
  glacialRockFlourFraction?: number;
  /** Dissolved salinity in parts per thousand (PSU); ~35 for ocean, 280-340 for hypersaline lakes. */
  salinityPermil?: number;
  /** Stagnant margin factor [0.0, 1.0] driving floating duckweed/azolla mats and biogenic thin films. */
  stagnantMarginFactor?: number;
}

export interface Case2BioOpticalIOP {
  sigmaA: { r: number; g: number; b: number };
  sigmaBb: { r: number; g: number; b: number };
  gordonSubsurfaceAlbedo: { r: number; g: number; b: number };
  refractiveIndex: number;
  fresnelF0: number;
  duckweedMatCoverage: number;
  biogenicIridescenceStrength: number;
  haliteSaltCrustFactor: number;
}

/**
 * Evaluates the 3-component Case-2 bio-optical Inherent Optical Properties (IOP):
 * 1. Colored Dissolved Organic Matter (CDOM / humic tannins): exponential short-wave
 *    absorption a_CDOM(lambda) = a_440 * exp(-S * (lambda - 440)) with negligible
 *    backscattering (b_b ~ 0), producing obsidian/espresso mirror water in swamps,
 *    bayous, peat bogs, and blackwater rivers.
 * 2. Chlorophyll-a & phytoplankton / floating macrophyte biofilm: red (675 nm) and
 *    blue (440 nm) absorption peaks with olive-emerald (550 nm) reflectance.
 * 3. Suspended Particulate Mineral Matter (SPM): isotropic Mie backscattering from
 *    glacial rock flour (milky-turquoise Tyndall opalescence) or alluvial silt (ochre).
 * Also resolves hypersaline brine refractive index elevation (n up to 1.355).
 */
export function evaluateCase2BioOpticalIOP(
  params: Case2BioOpticalParams = {},
): Case2BioOpticalIOP {
  const cdom = clamp(params.cdomConcentration ?? 0.0, 0.0, 5.0);
  const chl = clamp(params.chlorophyllConcentration ?? 0.0, 0.0, 5.0);
  const spm = clamp(params.mineralSpmConcentration ?? 0.0, 0.0, 5.0);
  const flourFrac = clamp(params.glacialRockFlourFraction ?? 0.0, 0.0, 1.0);
  const salinity = clamp(params.salinityPermil ?? 35.0, 0.0, 360.0);
  const stagnant = clamp(params.stagnantMarginFactor ?? 0.0, 0.0, 1.0);

  // Pure water baseline absorption (m^-1) at R (650 nm), G (550 nm), B (450 nm)
  const aWaterR = 0.34;
  const aWaterG = 0.056;
  const aWaterB = 0.0092;

  // Pure water molecular Rayleigh backscattering (m^-1)
  const bbWaterR = 0.0004;
  const bbWaterG = 0.0009;
  const bbWaterB = 0.0022;

  // CDOM exponential blue-violet absorption with near-zero backscattering
  const aCdomR = cdom * 0.045;
  const aCdomG = cdom * 0.34;
  const aCdomB = cdom * 1.38;
  const bbCdom = cdom * 0.0004;

  // Chlorophyll-a absorption (peaks in blue 440 nm and red 675 nm) & green backscatter
  const aChlR = chl * 0.11;
  const aChlG = chl * 0.035;
  const aChlB = chl * 0.16;
  const bbChlR = chl * 0.006;
  const bbChlG = chl * 0.028;
  const bbChlB = chl * 0.008;

  // Mineral SPM: blend between ochre alluvial silt (flourFrac = 0) and glacial rock flour (flourFrac = 1)
  const aSpmR = spm * (0.042 * (1.0 - flourFrac) + 0.008 * flourFrac);
  const aSpmG = spm * (0.085 * (1.0 - flourFrac) + 0.012 * flourFrac);
  const aSpmB = spm * (0.18 * (1.0 - flourFrac) + 0.022 * flourFrac);

  const bbSpmR = spm * (0.095 * (1.0 - flourFrac) + 0.018 * flourFrac);
  const bbSpmG = spm * (0.072 * (1.0 - flourFrac) + 0.115 * flourFrac);
  const bbSpmB = spm * (0.028 * (1.0 - flourFrac) + 0.128 * flourFrac);

  const sigmaA = {
    r: aWaterR + aCdomR + aChlR + aSpmR,
    g: aWaterG + aCdomG + aChlG + aSpmG,
    b: aWaterB + aCdomB + aChlB + aSpmB,
  };
  const sigmaBb = {
    r: bbWaterR + bbCdom + bbChlR + bbSpmR,
    g: bbWaterG + bbCdom + bbChlG + bbSpmG,
    b: bbWaterB + bbCdom + bbChlB + bbSpmB,
  };

  // Gordon's multiple-scattering subsurface irradiance reflectance R = 0.33 * bb / (a + bb)
  const gordonSubsurfaceAlbedo = {
    r: clamp(
      (0.33 * sigmaBb.r) / Math.max(sigmaA.r + sigmaBb.r, 1e-5),
      0.0,
      0.48,
    ),
    g: clamp(
      (0.33 * sigmaBb.g) / Math.max(sigmaA.g + sigmaBb.g, 1e-5),
      0.0,
      0.48,
    ),
    b: clamp(
      (0.33 * sigmaBb.b) / Math.max(sigmaA.b + sigmaBb.b, 1e-5),
      0.0,
      0.48,
    ),
  };

  // Brine refractive index elevation: freshwater ~1.333, ocean ~1.334, hypersaline Dead Sea ~1.355
  const refractiveIndex =
    SEAWATER_REFRACTIVE_INDEX +
    clamp((salinity - 35.0) * 0.000072, -0.0006, 0.022);
  const f0Num = refractiveIndex - 1.0;
  const f0Den = refractiveIndex + 1.0;
  const fresnelF0 = (f0Num * f0Num) / (f0Den * f0Den);

  const duckweedMatCoverage = clamp(
    stagnant * clamp((chl - 0.35) * 0.55 + (cdom - 0.5) * 0.25, 0.0, 1.0),
    0.0,
    0.92,
  );
  const biogenicIridescenceStrength = clamp(
    stagnant * clamp(cdom * 0.35 + chl * 0.15, 0.0, 1.0),
    0.0,
    1.0,
  );
  const haliteSaltCrustFactor = clamp((salinity - 120.0) / 180.0, 0.0, 1.0);

  return {
    sigmaA,
    sigmaBb,
    gordonSubsurfaceAlbedo,
    refractiveIndex,
    fresnelF0,
    duckweedMatCoverage,
    biogenicIridescenceStrength,
    haliteSaltCrustFactor,
  };
}

export interface FetchLimitedWaveParams {
  /** Effective windward open-water fetch distance in metres. */
  fetchMeters?: number;
  /** 10m wind speed U_10 in m/s. */
  windSpeedMetersPerSecond?: number;
  /** Local water depth in metres. */
  waterDepthMeters?: number;
  /** Swamp/wetland emergent vegetation & canopy wind-sheltering factor [0.0, 1.0]. */
  vegetationCanopyDamping?: number;
  /** Salinity in PSU (viscous hypersaline brine damps high-frequency capillary ripples). */
  salinityPermil?: number;
  /** River channel flow speed in m/s for 2-phase anisotropic flow advection. */
  flowSpeedMetersPerSecond?: number;
  /** River bed slope (dimensionless rise/run) driving shallow riffle chevrons. */
  riverBedSlope?: number;
  /** Simulation time in seconds. */
  timeSeconds?: number;
}

export interface FetchLimitedWaveSpectrum {
  dimensionlessFetch: number;
  significantWaveHeightMeters: number;
  peakWavelengthMeters: number;
  octaveWeights: {
    swell150m: number;
    chop50m: number;
    windWave15m: number;
    capillary3m: number;
  };
  glassMirrorCalmFactor: number;
  anisotropicFlowAdvection: {
    uPhase0: number;
    uPhase1: number;
    phaseBlendWeight0: number;
    phaseBlendWeight1: number;
    riffleChevronIntensity: number;
  };
}

/**
 * Evaluates the JONSWAP fetch-limited wave spectrum (Hasselmann et al. 1973,
 * H_s ~ U_10 * sqrt(F / g)) and 2-phase anisotropic river flow advection.
 *
 * Suppresses long-period ocean swells (150m and 50m octaves) in short-fetch
 * inland lakes, rivers, and vegetated swamps while preserving capillary chop
 * or glass-mirror calm.
 */
export function evaluateFetchLimitedWaveSpectrum(
  params: FetchLimitedWaveParams = {},
): FetchLimitedWaveSpectrum {
  const g = 9.80665;
  const fetchM = Math.max(1.0, params.fetchMeters ?? 250000.0);
  const u10 = Math.max(0.1, params.windSpeedMetersPerSecond ?? 8.0);
  const depthM = Math.max(0.1, params.waterDepthMeters ?? 100.0);
  const canopyDamp = clamp(params.vegetationCanopyDamping ?? 0.0, 0.0, 1.0);
  const salinity = clamp(params.salinityPermil ?? 35.0, 0.0, 360.0);
  const flowSpeed = Math.max(0.0, params.flowSpeedMetersPerSecond ?? 0.0);
  const bedSlope = Math.max(0.0, params.riverBedSlope ?? 0.0);
  const timeS = params.timeSeconds ?? 0.0;

  // Dimensionless fetch X = g * F / U_10^2 (fully developed sea at X >= 2.2e4)
  const dimensionlessFetch = (g * fetchM) / (u10 * u10);
  const fetchGrowth =
    dimensionlessFetch >= 22000.0
      ? 1.0
      : clamp(Math.sqrt(dimensionlessFetch / 22000.0), 0.02, 1.0);
  const depthArg = 0.12 * depthM;
  const depthGrowth =
    depthArg >= 5.5 ? 1.0 : clamp(Math.tanh(depthArg), 0.08, 1.0);
  const canopyRetention = 1.0 - canopyDamp * 0.92;
  const brineViscosityDamp =
    salinity <= 80.0
      ? 1.0
      : 1.0 - clamp((salinity - 80.0) / 260.0, 0.0, 1.0) * 0.45;

  const fullyDevelopedHs = (0.21 * (u10 * u10)) / g;
  const significantWaveHeightMeters =
    fullyDevelopedHs * fetchGrowth * depthGrowth * canopyRetention;
  const fetchPow = fetchGrowth >= 1.0 ? 1.0 : Math.pow(fetchGrowth, 0.66);
  const peakWavelengthMeters =
    Math.max(0.6, ((2.0 * Math.PI * u10 * u10) / g) * fetchPow) *
    canopyRetention;

  // Per-octave fetch gating:
  // - 150m open-ocean swell requires > 40 km fetch
  // - 50m intermediate swell requires > 6 km fetch
  // - 15m short wind wave requires > 400 m fetch
  // - 3m capillary ripple is damped by swamp canopy or hypersaline viscosity
  const swell150m =
    clamp((fetchM - 15000.0) / 95000.0, 0.0, 1.0) *
    clamp((depthM - 8.0) / 35.0, 0.0, 1.0) *
    canopyRetention;
  const chop50m =
    clamp((fetchM - 1500.0) / 22000.0, 0.0, 1.0) *
    clamp((depthM - 2.5) / 14.0, 0.0, 1.0) *
    canopyRetention;
  const windWave15m =
    clamp((fetchM - 80.0) / 2400.0, 0.0, 1.0) *
    canopyRetention *
    brineViscosityDamp;
  const capillary3m =
    clamp(fetchM / 250.0, 0.08, 1.0) * canopyRetention * brineViscosityDamp;

  const glassMirrorCalmFactor = clamp(
    1.0 -
      (swell150m * 0.35 +
        chop50m * 0.3 +
        windWave15m * 0.25 +
        capillary3m * 0.1),
    0.0,
    1.0,
  );

  // 2-phase flow-map advection cycle (period T = 3.0 s, offset by 0.5 cycle)
  const flowCycle = 3.0;
  const phase0 = (((timeS / flowCycle) % 1.0) + 1.0) % 1.0;
  const phase1 = (((timeS / flowCycle + 0.5) % 1.0) + 1.0) % 1.0;
  const phaseBlendWeight0 = 1.0 - Math.abs(2.0 * phase0 - 1.0);
  const phaseBlendWeight1 = 1.0 - phaseBlendWeight0;
  const froudeProxy = flowSpeed / Math.sqrt(g * Math.max(depthM, 0.25));
  const riffleChevronIntensity = clamp(
    (froudeProxy * 0.65 + bedSlope * 18.0) *
      (1.0 - clamp(depthM / 4.5, 0.0, 1.0)),
    0.0,
    1.0,
  );

  return {
    dimensionlessFetch,
    significantWaveHeightMeters,
    peakWavelengthMeters,
    octaveWeights: {
      swell150m,
      chop50m,
      windWave15m,
      capillary3m,
    },
    glassMirrorCalmFactor,
    anisotropicFlowAdvection: {
      uPhase0: phase0 * flowSpeed,
      uPhase1: phase1 * flowSpeed,
      phaseBlendWeight0,
      phaseBlendWeight1,
      riffleChevronIntensity,
    },
  };
}

/** Geographic rectangle in radians matching EPSG:4326 WMTS / GeographicTilingScheme. */
export interface WMTSTileRectangle {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** WMTS / Quadtree tile coordinate in EPSG:4326 GeographicTilingScheme (2x1 root tiles). */
export interface WMTSBathymetryTileCoord {
  level: number;
  x: number;
  y: number;
}

/**
 * Regional hand-placed, synthetic depth and hydro-optical patch. The values are
 * invented for plausibility; they are not survey measurements.
 */
export interface WMTSRegionalBathymetrySurvey {
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
  centerLonRad: number;
  centerLatRad: number;
  radiusRad: number;
  maxDepthMeters: number;
  shelfDepthMeters: number;
  jerlovType: number;
  substrateType: number;
  tidalRangeMeters: number;
}

/** Per-tile WMTS bathymetric and hydrological RGBA8 tensor tile. */
export interface WMTSBathymetryTensorTile extends BathymetryTensorSet {
  level: number;
  x: number;
  y: number;
  rectangle: WMTSTileRectangle;
  surveysEvaluated: number;
  upsampledFromParent: boolean;
}

const DEG_TO_RAD_WMTS = Math.PI / 180.0;
const WMTS_GRID_COLS = 36;
const WMTS_GRID_ROWS = 18;

function createSurveyPatch(
  id: string,
  centerLonDeg: number,
  centerLatDeg: number,
  radiusDeg: number,
  maxDepthMeters: number,
  shelfDepthMeters: number,
  jerlovType: number,
  substrateType: number,
  tidalRangeMeters: number,
): WMTSRegionalBathymetrySurvey {
  const cLon = centerLonDeg * DEG_TO_RAD_WMTS;
  const cLat = centerLatDeg * DEG_TO_RAD_WMTS;
  const rRad = radiusDeg * DEG_TO_RAD_WMTS;
  return {
    id,
    west: Math.max(-Math.PI, cLon - rRad * 1.35),
    south: Math.max(-Math.PI * 0.5, cLat - rRad),
    east: Math.min(Math.PI, cLon + rRad * 1.35),
    north: Math.min(Math.PI * 0.5, cLat + rRad),
    centerLonRad: cLon,
    centerLatRad: cLat,
    radiusRad: rRad,
    maxDepthMeters,
    shelfDepthMeters,
    jerlovType,
    substrateType,
    tidalRangeMeters,
  };
}

/**
 * Catalog of 47 hand-placed SYNTHETIC regional depth and bio-optical patches
 * (circular, with invented depth, Jerlov and substrate values). It is not
 * survey data and is no substitute for GEBCO or any measured dataset. Indexed
 * into a 36x18 (10-degree) 2D spatial grid so WMTS tile generation only
 * evaluates patches overlapping the requested `(level, x, y)` tile rectangle.
 *
 * @experimental Nothing at runtime consumes the catalog yet (the intended
 * consumer is a WMTS-style bathymetry tile stream, tracked in DEFERRED_WORK).
 */
export const GLOBAL_WMTS_BATHYMETRY_SURVEYS: ReadonlyArray<WMTSRegionalBathymetrySurvey> =
  [
    createSurveyPatch(
      "volcanic-fringing-reef-01",
      -159.5,
      22.2,
      1.4,
      26.0,
      2.2,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.CORAL_REEF,
      0.6,
    ),
    createSurveyPatch(
      "carbonate-platform-shoal-01",
      -77.5,
      24.5,
      4.5,
      12.0,
      1.8,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.SAND,
      0.9,
    ),
    createSurveyPatch(
      "rift-fringing-coral-01",
      34.0,
      27.2,
      3.2,
      18.0,
      2.0,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.CORAL_REEF,
      0.7,
    ),
    createSurveyPatch(
      "continental-shelf-barrier-reef-01",
      147.0,
      -18.0,
      6.0,
      18.0,
      2.5,
      JerlovWaterType.TYPE_IB,
      SeabedSubstrateType.CORAL_REEF,
      2.4,
    ),
    createSurveyPatch(
      "oligotrophic-archipelago-sea-01",
      25.4,
      36.4,
      5.5,
      260.0,
      8.0,
      JerlovWaterType.TYPE_I,
      SeabedSubstrateType.ROCK_BASALT,
      0.4,
    ),
    createSurveyPatch(
      "endorheic-inland-basin-south-01",
      50.0,
      40.4,
      4.0,
      38.0,
      4.0,
      JerlovWaterType.COASTAL_3,
      SeabedSubstrateType.SILT_MUD,
      0.1,
    ),
    createSurveyPatch(
      "endorheic-inland-shelf-north-01",
      48.0,
      45.7,
      3.4,
      6.5,
      1.5,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      0.1,
    ),
    createSurveyPatch(
      "hadal-subduction-trench-01",
      142.2,
      11.35,
      4.0,
      10920.0,
      3500.0,
      JerlovWaterType.TYPE_I,
      SeabedSubstrateType.ABYSSAL_SEDIMENT,
      0.8,
    ),
    createSurveyPatch(
      "macro-tidal-estuary-bay-01",
      -1.51,
      48.65,
      1.5,
      8.5,
      1.2,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      13.5,
    ),
    createSurveyPatch(
      "drowned-river-valley-estuary-01",
      -76.3,
      37.0,
      2.4,
      9.0,
      1.5,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      1.2,
    ),
    createSurveyPatch(
      "equatorial-macro-delta-01",
      -49.5,
      -0.5,
      5.0,
      18.0,
      2.5,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      4.5,
    ),
    createSurveyPatch(
      "alluvial-birdfoot-delta-01",
      -90.0,
      29.9,
      3.2,
      14.0,
      2.0,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.6,
    ),
    createSurveyPatch(
      "boreal-tectonic-rift-graben-01",
      107.4,
      53.1,
      4.2,
      1642.0,
      3.5,
      JerlovWaterType.TYPE_I,
      SeabedSubstrateType.ROCK_BASALT,
      0.05,
    ),
    createSurveyPatch(
      "equatorial-tectonic-rift-graben-01",
      29.5,
      -6.5,
      3.4,
      1470.0,
      3.5,
      JerlovWaterType.TYPE_I,
      SeabedSubstrateType.ROCK_BASALT,
      0.05,
    ),
    createSurveyPatch(
      "cratonic-glacial-basin-01",
      -88.0,
      47.5,
      4.5,
      405.0,
      4.0,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.ROCK_BASALT,
      0.08,
    ),
    createSurveyPatch(
      "subtropical-sawgrass-slough-01",
      -80.82,
      26.2,
      3.4,
      2.2,
      0.4,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.5,
    ),
    createSurveyPatch(
      "alluvial-cypress-swamp-01",
      -91.5,
      30.2,
      2.5,
      3.0,
      0.6,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.4,
    ),
    createSurveyPatch(
      "temperate-reed-delta-wetland-01",
      29.55,
      45.15,
      2.2,
      4.5,
      0.8,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      0.3,
    ),
    createSurveyPatch(
      "equatorial-humic-blackwater-01",
      -60.55,
      -3.0,
      2.0,
      22.0,
      2.5,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.1,
    ),
    createSurveyPatch(
      "cordillera-rock-flour-glacial-01",
      -116.55,
      50.5,
      3.4,
      95.0,
      2.0,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.ROCK_BASALT,
      0.0,
    ),
    createSurveyPatch(
      "southern-alps-proglacial-01",
      170.16,
      -44.12,
      2.6,
      70.0,
      1.8,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.ROCK_BASALT,
      0.0,
    ),
    createSurveyPatch(
      "hypersaline-rift-graben-brine-01",
      35.46,
      31.5,
      2.4,
      304.0,
      1.5,
      JerlovWaterType.COASTAL_3,
      SeabedSubstrateType.SAND,
      0.0,
    ),
    createSurveyPatch(
      "endorheic-playa-brine-01",
      -112.5,
      41.1,
      2.5,
      10.0,
      0.8,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.SAND,
      0.0,
    ),
    createSurveyPatch(
      "subtropical-barrier-lagoon-01",
      -80.145,
      25.825,
      1.6,
      4.5,
      1.2,
      JerlovWaterType.COASTAL_1,
      SeabedSubstrateType.SAND,
      0.8,
    ),
    createSurveyPatch(
      "estuarine-barrier-sound-01",
      -82.035,
      26.475,
      1.6,
      5.5,
      1.0,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SAND,
      1.1,
    ),
    createSurveyPatch(
      "subtropical-coastal-embayment-01",
      -82.655,
      27.625,
      1.8,
      11.0,
      1.4,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.SAND,
      0.9,
    ),
    createSurveyPatch(
      "tectonic-coastal-estuary-bay-01",
      -122.465,
      37.82,
      2.2,
      36.0,
      2.5,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      1.8,
    ),
    createSurveyPatch(
      "oligotrophic-glacial-trough-lake-01",
      -73.625,
      43.565,
      1.2,
      60.0,
      2.5,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.ROCK_BASALT,
      0.0,
    ),
    createSurveyPatch(
      "montane-dimictic-basin-lake-01",
      -73.982,
      44.298,
      1.0,
      46.0,
      2.2,
      JerlovWaterType.TYPE_IB,
      SeabedSubstrateType.ROCK_BASALT,
      0.0,
    ),
    createSurveyPatch(
      "large-river-sediment-confluence-01",
      -89.133,
      36.982,
      2.2,
      16.0,
      2.0,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.1,
    ),
    createSurveyPatch(
      "temperate-coastal-fjord-sound-01",
      -125.905,
      49.152,
      2.8,
      180.0,
      6.0,
      JerlovWaterType.TYPE_III,
      SeabedSubstrateType.ROCK_BASALT,
      3.8,
    ),
    createSurveyPatch(
      "resonant-macro-tidal-funnel-bay-01",
      -64.35,
      45.32,
      2.4,
      28.0,
      1.5,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      15.0,
    ),
    createSurveyPatch(
      "enclosed-brackish-marsh-lagoon-01",
      12.332,
      45.438,
      1.6,
      6.5,
      0.9,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.SILT_MUD,
      1.1,
    ),
    createSurveyPatch(
      "prealpine-glacial-fjord-lake-01",
      9.262,
      46.002,
      1.6,
      425.0,
      4.5,
      JerlovWaterType.TYPE_IB,
      SeabedSubstrateType.ROCK_BASALT,
      0.0,
    ),
    createSurveyPatch(
      "high-latitude-deep-sill-fjord-01",
      7.095,
      62.105,
      2.4,
      580.0,
      12.0,
      JerlovWaterType.TYPE_II,
      SeabedSubstrateType.ROCK_BASALT,
      1.8,
    ),
    createSurveyPatch(
      "intertidal-barrier-mudflat-sea-01",
      8.42,
      54.88,
      2.6,
      7.5,
      0.8,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SAND,
      3.4,
    ),
    createSurveyPatch(
      "karst-travertine-cascade-lakes-01",
      15.61,
      44.88,
      1.4,
      46.0,
      1.5,
      JerlovWaterType.COASTAL_1,
      SeabedSubstrateType.SAND,
      0.0,
    ),
    createSurveyPatch(
      "mesotidal-barrier-island-lagoon-01",
      -7.86,
      36.99,
      1.8,
      9.0,
      1.2,
      JerlovWaterType.COASTAL_3,
      SeabedSubstrateType.SAND,
      3.2,
    ),
    createSurveyPatch(
      "submerged-tower-karst-embayment-01",
      107.085,
      20.845,
      2.4,
      18.0,
      2.2,
      JerlovWaterType.COASTAL_3,
      SeabedSubstrateType.SILT_MUD,
      2.2,
    ),
    createSurveyPatch(
      "endorheic-inland-alluvial-fan-01",
      22.92,
      -19.28,
      2.8,
      4.0,
      0.6,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SAND,
      0.0,
    ),
    createSurveyPatch(
      "tropical-monsoon-brackish-lagoon-01",
      76.38,
      9.62,
      2.0,
      5.5,
      0.9,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      1.0,
    ),
    createSurveyPatch(
      "equatorial-karst-coral-archipelago-01",
      130.02,
      -0.16,
      2.8,
      16.0,
      1.8,
      JerlovWaterType.TYPE_IA,
      SeabedSubstrateType.CORAL_REEF,
      1.6,
    ),
    createSurveyPatch(
      "metahaline-seagrass-carbonate-embayment-01",
      113.82,
      -25.92,
      2.6,
      9.0,
      1.1,
      JerlovWaterType.COASTAL_1,
      SeabedSubstrateType.SAND,
      1.2,
    ),
    createSurveyPatch(
      "temperate-tannin-stratified-fjord-01",
      167.89,
      -44.64,
      2.2,
      290.0,
      8.0,
      JerlovWaterType.COASTAL_5,
      SeabedSubstrateType.ROCK_BASALT,
      2.1,
    ),
    createSurveyPatch(
      "coastal-interdunal-freshwater-lagoon-01",
      -43.12,
      -2.48,
      1.8,
      3.5,
      0.6,
      JerlovWaterType.COASTAL_1,
      SeabedSubstrateType.SAND,
      2.4,
    ),
    createSurveyPatch(
      "canyon-bedrock-river-gorge-01",
      110.82,
      30.98,
      2.8,
      120.0,
      4.0,
      JerlovWaterType.COASTAL_7,
      SeabedSubstrateType.SILT_MUD,
      0.2,
    ),
    createSurveyPatch(
      "monsoon-flood-pulse-floodplain-lake-01",
      104.05,
      12.88,
      2.6,
      10.0,
      1.2,
      JerlovWaterType.COASTAL_9,
      SeabedSubstrateType.SILT_MUD,
      0.4,
    ),
  ];

/**
 * Computes the geographic bounding rectangle (in radians) of a WMTS / Quadtree
 * tile `(x, y)` at `level` under Cesium's standard EPSG:4326 `GeographicTilingScheme`
 * (`2 * 2^level` columns by `2^level` rows, row 0 at North Pole).
 */
export function wmtsTileRectangle(
  x: number,
  y: number,
  level: number,
): WMTSTileRectangle {
  const safeLevel = Math.max(0, Math.min(24, Math.floor(level)));
  const numX = 2 * Math.pow(2, safeLevel);
  const numY = Math.pow(2, safeLevel);
  const lonSpan = (2.0 * Math.PI) / numX;
  const latSpan = Math.PI / numY;
  const clampedX = Math.max(0, Math.min(numX - 1, Math.floor(x)));
  const clampedY = Math.max(0, Math.min(numY - 1, Math.floor(y)));
  const west = -Math.PI + clampedX * lonSpan;
  const east = west + lonSpan;
  const north = Math.PI * 0.5 - clampedY * latSpan;
  const south = north - latSpan;
  return { west, south, east, north };
}

/**
 * Converts a geographic coordinate `(longitudeRad, latitudeRad)` into its
 * containing WMTS / Quadtree tile coordinate `(level, x, y)` at LOD `level`.
 */
export function wmtsCoordAtLonLat(
  longitudeRad: number,
  latitudeRad: number,
  level: number,
): WMTSBathymetryTileCoord {
  const safeLevel = Math.max(0, Math.min(24, Math.floor(level)));
  const numX = 2 * Math.pow(2, safeLevel);
  const numY = Math.pow(2, safeLevel);
  let u = (longitudeRad + Math.PI) / (2.0 * Math.PI);
  u = u - Math.floor(u);
  const v = clamp((Math.PI * 0.5 - latitudeRad) / Math.PI, 0.0, 1.0 - 1e-12);
  const x = clamp(Math.floor(u * numX), 0, numX - 1);
  const y = clamp(Math.floor(v * numY), 0, numY - 1);
  return { level: safeLevel, x, y };
}

function wmtsLonToCol(lonRad: number): number {
  const col = Math.floor(
    ((lonRad + Math.PI) / (2.0 * Math.PI)) * WMTS_GRID_COLS,
  );
  return col < 0 ? 0 : col >= WMTS_GRID_COLS ? WMTS_GRID_COLS - 1 : col;
}

function wmtsLatToRow(latRad: number): number {
  const row = Math.floor(((latRad + Math.PI * 0.5) / Math.PI) * WMTS_GRID_ROWS);
  return row < 0 ? 0 : row >= WMTS_GRID_ROWS ? WMTS_GRID_ROWS - 1 : row;
}

/**
 * WMTS-style LOD-Streaming Bathymetry & Hydrological Tensor Tile Provider.
 *
 * Streams and computes per-tile `(level, x, y)` RGBA8 bathymetric & optical
 * tensors on demand as quadtree LOD tiles refine, backed by:
 * - A coarse Level-0 planetary substrate (`360x181`)
 * - A 36x18 (10-degree) 2D Spatial Grid Index over the synthetic regional patches
 * - Bounded LRU tile caching (`maxCachedTiles`, default 256) with automatic eviction
 * - Parent-to-child quadtree sub-tile upsampling (`upsampleParentTileTensor`)
 *   for zero-stall CLOD transitions while child LOD tiles compute/stream.
 */
export class WMTSBathymetryTensorTileProvider {
  private _tileSize: number;
  private _maxCachedTiles: number;
  private _basePlanetTensor?: BathymetryTensorSet;
  private _surveys: ReadonlyArray<WMTSRegionalBathymetrySurvey>;
  private _gridCells: number[][];
  private _seenStamp: Uint32Array;
  private _currentStamp = 0;
  private _tileCache = new Map<string, WMTSBathymetryTensorTile>();

  constructor(options?: {
    tileSize?: number;
    maxCachedTiles?: number;
    basePlanetTensor?: BathymetryTensorSet;
    surveys?: ReadonlyArray<WMTSRegionalBathymetrySurvey>;
  }) {
    this._tileSize = Math.max(8, Math.min(256, options?.tileSize ?? 64));
    this._maxCachedTiles = Math.max(16, options?.maxCachedTiles ?? 256);
    this._basePlanetTensor = options?.basePlanetTensor;
    this._surveys = options?.surveys ?? GLOBAL_WMTS_BATHYMETRY_SURVEYS;

    const cells: number[][] = new Array(WMTS_GRID_COLS * WMTS_GRID_ROWS);
    for (let i = 0; i < cells.length; i++) {
      cells[i] = [];
    }
    for (let i = 0; i < this._surveys.length; i++) {
      const s = this._surveys[i];
      const c0 = wmtsLonToCol(s.west);
      const c1 = wmtsLonToCol(s.east);
      const r0 = wmtsLatToRow(s.south);
      const r1 = wmtsLatToRow(s.north);
      for (let r = r0; r <= r1; r++) {
        const rowBase = r * WMTS_GRID_COLS;
        for (let c = c0; c <= c1; c++) {
          cells[rowBase + c].push(i);
        }
      }
    }
    this._gridCells = cells;
    this._seenStamp = new Uint32Array(this._surveys.length);
  }

  get tileSize(): number {
    return this._tileSize;
  }

  get maxCachedTiles(): number {
    return this._maxCachedTiles;
  }

  get cachedTileCount(): number {
    return this._tileCache.size;
  }

  private _ensureBasePlanetTensor(): BathymetryTensorSet {
    if (_globalBundledBathymetryTensor !== undefined) {
      return _globalBundledBathymetryTensor;
    }
    if (!this._basePlanetTensor) {
      this._basePlanetTensor = buildProceduralBathymetryTensor(360, 181);
    }
    return this._basePlanetTensor;
  }

  /**
   * Queries the 2D spatial grid index for regional surveys intersecting `rect` in O(1) time.
   */
  queryIntersectingSurveys(
    rect: WMTSTileRectangle,
  ): WMTSRegionalBathymetrySurvey[] {
    const c0 = wmtsLonToCol(rect.west);
    const c1 = wmtsLonToCol(rect.east);
    const r0 = wmtsLatToRow(rect.south);
    const r1 = wmtsLatToRow(rect.north);

    this._currentStamp = (this._currentStamp + 1) >>> 0;
    if (this._currentStamp === 0) {
      this._seenStamp.fill(0);
      this._currentStamp = 1;
    }
    const stamp = this._currentStamp;
    const seen = this._seenStamp;
    const out: WMTSRegionalBathymetrySurvey[] = [];

    for (let r = r0; r <= r1; r++) {
      const rowBase = r * WMTS_GRID_COLS;
      for (let c = c0; c <= c1; c++) {
        const bucket = this._gridCells[rowBase + c];
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i];
          if (seen[idx] === stamp) {
            continue;
          }
          seen[idx] = stamp;
          const s = this._surveys[idx];
          if (
            rect.east >= s.west &&
            rect.west <= s.east &&
            rect.north >= s.south &&
            rect.south <= s.north
          ) {
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  /**
   * Requests or computes a WMTS bathymetric tensor tile `(level, x, y)` on demand.
   * Uses the LRU cache for O(1) hits and evicts oldest tiles when exceeding `maxCachedTiles`.
   */
  requestTileTensor(
    x: number,
    y: number,
    level: number,
    waterMask?: Uint8Array,
  ): WMTSBathymetryTensorTile {
    const safeLevel = Math.max(0, Math.min(24, Math.floor(level)));
    const key = `L${safeLevel}_X${x}_Y${y}`;
    const existing = this._tileCache.get(key);
    if (existing !== undefined && waterMask === undefined) {
      this._tileCache.delete(key);
      this._tileCache.set(key, existing);
      return existing;
    }

    const rectangle = wmtsTileRectangle(x, y, safeLevel);
    const intersectingSurveys = this.queryIntersectingSurveys(rectangle);
    const basePlanet = this._ensureBasePlanetTensor();
    const size = this._tileSize;
    const bytes = new Uint8Array(size * size * 4);

    // LOD blend weight increases with quadtree level so regional surveys smoothly
    // sharpen from coarse planetary level 0 into high-detail coastal levels (L3..L14).
    const lodDetailFactor = clamp((safeLevel - 1.0) / 6.0, 0.25, 1.0);
    const dLon = (rectangle.east - rectangle.west) / size;
    const dLat = (rectangle.north - rectangle.south) / size;
    const maskSize =
      waterMask && waterMask.length > 1
        ? Math.round(Math.sqrt(waterMask.length))
        : 1;

    for (let row = 0; row < size; row++) {
      const latRad = rectangle.north - (row + 0.5) * dLat;
      for (let col = 0; col < size; col++) {
        const lonRad = rectangle.west + (col + 0.5) * dLon;
        let state = sampleBathymetryTensor(basePlanet, lonRad, latRad);

        // Evaluate only the spatially-indexed regional surveys overlapping this tile
        for (let sIdx = 0; sIdx < intersectingSurveys.length; sIdx++) {
          const s = intersectingSurveys[sIdx];
          if (
            lonRad < s.west ||
            lonRad > s.east ||
            latRad < s.south ||
            latRad > s.north
          ) {
            continue;
          }
          const distRad = Math.hypot(
            lonRad - s.centerLonRad,
            latRad - s.centerLatRad,
          );
          if (distRad < s.radiusRad) {
            const radialWeight = 1.0 - distRad / s.radiusRad;
            const smoothWeight =
              radialWeight * radialWeight * (3.0 - 2.0 * radialWeight);
            const surveyState: DecodedBathymetryState = {
              depthMeters:
                s.shelfDepthMeters +
                (s.maxDepthMeters - s.shelfDepthMeters) * smoothWeight,
              jerlovType: s.jerlovType,
              substrateType: s.substrateType,
              tidalRangeMeters: s.tidalRangeMeters,
            };
            state = blendBathymetryLOD(
              state,
              surveyState,
              smoothWeight * lodDetailFactor,
            );
          }
        }

        // Couple with tile water-mask SDF if provided (shoreline -> continental shelf)
        if (waterMask !== undefined) {
          let maskVal = 255;
          if (waterMask.length === 1) {
            maskVal = waterMask[0];
          } else if (maskSize > 1) {
            const mr = Math.min(
              maskSize - 1,
              Math.floor((row / size) * maskSize),
            );
            const mc = Math.min(
              maskSize - 1,
              Math.floor((col / size) * maskSize),
            );
            maskVal = waterMask[mr * maskSize + mc];
          }
          if (maskVal <= 112) {
            state.depthMeters = 0.0;
          } else if (maskVal < 168) {
            const shoreRamp = (maskVal - 112) / (168 - 112);
            state.depthMeters *= shoreRamp * shoreRamp;
          }
        }

        const dst = (row * size + col) * 4;
        bytes[dst] = encodeDepth(state.depthMeters);
        bytes[dst + 1] = encodeJerlovType(state.jerlovType);
        bytes[dst + 2] = encodeSubstrate(state.substrateType);
        bytes[dst + 3] = encodeTidalRange(state.tidalRangeMeters);
      }
    }

    const tile: WMTSBathymetryTensorTile = {
      level: safeLevel,
      x,
      y,
      width: size,
      height: size,
      rectangle,
      bathymetryBytes: bytes,
      surveysEvaluated: intersectingSurveys.length,
      upsampledFromParent: false,
    };

    if (waterMask === undefined) {
      if (this._tileCache.size >= this._maxCachedTiles) {
        const oldestKey = this._tileCache.keys().next().value;
        if (oldestKey !== undefined) {
          this._tileCache.delete(oldestKey);
        }
      }
      this._tileCache.set(key, tile);
    }
    return tile;
  }

  /**
   * Bilinearly upsamples an ancestor WMTS tensor tile `(parentTile.level, parentTile.x, parentTile.y)`
   * into a descendant quadtree tile `(childLevel, childX, childY)`.
   *
   * Matches Cesium's `waterMaskTranslationAndScale` quadtree fallback so child
   * terrain tiles render with immediate, continuous bathymetry while their own
   * higher-LOD tensor tile streams asynchronously.
   */
  upsampleParentTileTensor(
    parentTile: WMTSBathymetryTensorTile,
    childX: number,
    childY: number,
    childLevel: number,
  ): WMTSBathymetryTensorTile {
    const levelDelta = Math.max(0, childLevel - parentTile.level);
    const scale = 1.0 / Math.pow(2, levelDelta);
    const localX = childX - (parentTile.x << levelDelta);
    const localY = childY - (parentTile.y << levelDelta);
    const uOffset = clamp(localX * scale, 0.0, 1.0 - scale);
    const vOffset = clamp(localY * scale, 0.0, 1.0 - scale);

    const w = parentTile.width;
    const h = parentTile.height;
    const src = parentTile.bathymetryBytes;
    const dst = new Uint8Array(w * h * 4);

    for (let row = 0; row < h; row++) {
      const v = vOffset + ((row + 0.5) / h) * scale;
      const fy = clamp(v * h - 0.5, 0.0, h - 1.0);
      const y0 = Math.floor(fy);
      const y1 = Math.min(y0 + 1, h - 1);
      const wy = fy - y0;

      for (let col = 0; col < w; col++) {
        const u = uOffset + ((col + 0.5) / w) * scale;
        const fx = clamp(u * w - 0.5, 0.0, w - 1.0);
        const x0 = Math.floor(fx);
        const x1 = Math.min(x0 + 1, w - 1);
        const wx = fx - x0;

        const i00 = (y0 * w + x0) * 4;
        const i10 = (y0 * w + x1) * 4;
        const i01 = (y1 * w + x0) * 4;
        const i11 = (y1 * w + x1) * 4;
        const outIdx = (row * w + col) * 4;

        for (let c = 0; c < 4; c++) {
          const top = src[i00 + c] * (1.0 - wx) + src[i10 + c] * wx;
          const bot = src[i01 + c] * (1.0 - wx) + src[i11 + c] * wx;
          dst[outIdx + c] = Math.round(top * (1.0 - wy) + bot * wy);
        }
      }
    }

    return {
      level: childLevel,
      x: childX,
      y: childY,
      width: w,
      height: h,
      rectangle: wmtsTileRectangle(childX, childY, childLevel),
      bathymetryBytes: dst,
      surveysEvaluated: parentTile.surveysEvaluated,
      upsampledFromParent: true,
    };
  }

  /**
   * Samples the LOD-appropriate WMTS tensor tile at `(longitudeRad, latitudeRad, level)`.
   */
  sampleAtLonLat(
    longitudeRad: number,
    latitudeRad: number,
    level: number,
  ): DecodedBathymetryState {
    const coord = wmtsCoordAtLonLat(longitudeRad, latitudeRad, level);
    const tile = this.requestTileTensor(coord.x, coord.y, coord.level);
    const rect = tile.rectangle;
    const u = clamp(
      (longitudeRad - rect.west) / Math.max(rect.east - rect.west, 1e-12),
      0.0,
      1.0,
    );
    const v = clamp(
      (rect.north - latitudeRad) / Math.max(rect.north - rect.south, 1e-12),
      0.0,
      1.0,
    );
    const w = tile.width;
    const h = tile.height;
    const fx = clamp(u * w - 0.5, 0.0, w - 1.0);
    const fy = clamp(v * h - 0.5, 0.0, h - 1.0);
    const x0 = Math.floor(fx);
    const x1 = Math.min(x0 + 1, w - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, h - 1);
    const wx = fx - x0;
    const wy = fy - y0;
    const buf = tile.bathymetryBytes;
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    const sampleChan = (c: number): number => {
      const top = buf[i00 + c] * (1.0 - wx) + buf[i10 + c] * wx;
      const bot = buf[i01 + c] * (1.0 - wx) + buf[i11 + c] * wx;
      return top * (1.0 - wy) + bot * wy;
    };
    return {
      depthMeters: decodeDepth(sampleChan(0)),
      jerlovType: decodeJerlovType(sampleChan(1)),
      substrateType: decodeSubstrate(sampleChan(2)),
      tidalRangeMeters: decodeTidalRange(sampleChan(3)),
    };
  }
}

/** Magic header (`0x31544247` = `"GBT1"`) for `Assets/WaterMask/globalBathymetryTensor.bin`. */
export const MAGIC_GBT1 = 0x31544247;

/**
 * Returns the globally registered bundled geophysical bathymetry tensor if loaded.
 */
export function getGlobalBundledBathymetryTensor():
  BathymetryTensorSet | undefined {
  return _globalBundledBathymetryTensor;
}

/**
 * Registers or clears the global bundled geophysical bathymetry tensor.
 */
export function setGlobalBundledBathymetryTensor(
  tensor: BathymetryTensorSet | undefined,
): void {
  _globalBundledBathymetryTensor = tensor;
}

/**
 * Parses a `GBT1` (`0x31544247`) binary buffer (`Assets/WaterMask/globalBathymetryTensor.bin`)
 * into a {@link BathymetryTensorSet}. Pure: it does not register the result;
 * call {@link setGlobalBundledBathymetryTensor} to make it the default prior.
 */
export function parseBundledBathymetryTensor(
  buffer: ArrayBuffer,
): BathymetryTensorSet {
  if (buffer.byteLength < 12) {
    throw new Error("parseBundledBathymetryTensor: buffer too small (< 12B)");
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC_GBT1) {
    throw new Error(
      `parseBundledBathymetryTensor: invalid magic 0x${magic.toString(16)}`,
    );
  }
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const expectedPayload = width * height * 4;
  if (buffer.byteLength < 12 + expectedPayload) {
    throw new Error(
      `parseBundledBathymetryTensor: truncated payload (${buffer.byteLength - 12} < ${expectedPayload})`,
    );
  }
  const bathymetryBytes = new Uint8Array(buffer, 12, expectedPayload);
  const tensorSet: BathymetryTensorSet = {
    width,
    height,
    bathymetryBytes,
  };
  tensorSet.sample = function (lon: number, lat: number) {
    return sampleBathymetryTensor(tensorSet, lon, lat);
  };
  return tensorSet;
}
