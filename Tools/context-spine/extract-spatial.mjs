// extract-spatial.mjs — Spatial R-tree rig indexer, ECEF->WGS84 converter, GIS asset catalog, and minimal set-cover selector.
// @purpose Index Probe Kit spatial rigs into SQLite R-tree, classify planetary singularity regimes, catalog GIS datum assets, and compute minimal validation rig covers.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toPosixRel } from "./schema.mjs";
import {
  extractIndirectRigCoordinates,
  inspectLiveGisAssets,
} from "./spatial-v2.mjs";

const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_B = WGS84_A * (1.0 - WGS84_F);
const WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const RAD_TO_DEG = 180.0 / Math.PI;
const DEG_TO_RAD = Math.PI / 180.0;

/**
 * Canonical planetary, coordinate, and singularity regimes used for spatial validation coverage.
 */
export const CANONICAL_SPATIAL_REGIMES = Object.freeze([
  "north_pole",
  "south_pole",
  "high_latitude",
  "equatorial",
  "antimeridian_seam",
  "prime_meridian_seam",
  "sub_ellipsoid_or_underground",
  "sub_ellipsoid_ocean_bathy",
  "near_surface",
  "cloud_deck_altitude",
  "stratospheric_or_limb",
  "orbital",
  "grazing_terminator",
  "night_lit",
  "coastal_or_water",
  "inland_lake_or_river",
  "antimeridian_coast_sdf",
  "voxel_volume",
  "2d_or_columbus",
]);

/**
 * Convert ECEF `[x, y, z]` meters into WGS84 `{ lon, lat, height }` (degrees, degrees, meters)
 * using Bowring's iterative geodetic formula.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ lon: number, lat: number, height: number }}
 */
export function ecefToWgs84(x, y, z) {
  const p = Math.hypot(x, y);
  if (p < 1e-6 && Math.abs(z) < 1e-6) {
    return { lon: 0, lat: 0, height: -WGS84_A };
  }
  if (p < 1e-6) {
    const sign = z >= 0 ? 1 : -1;
    return {
      lon: 0,
      lat: sign * 90,
      height: Math.abs(z) - WGS84_B,
    };
  }

  const lon = Math.atan2(y, x) * RAD_TO_DEG;
  let theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  let latRad = Math.atan2(
    z + WGS84_EP2 * WGS84_B * Math.pow(Math.sin(theta), 3),
    p - WGS84_E2 * WGS84_A * Math.pow(Math.cos(theta), 3),
  );

  for (let iter = 0; iter < 3; iter += 1) {
    const sinLat = Math.sin(latRad);
    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    theta = Math.atan2((z + WGS84_E2 * n * sinLat) * WGS84_A, p * WGS84_B);
    latRad = Math.atan2(
      z + WGS84_EP2 * WGS84_B * Math.pow(Math.sin(theta), 3),
      p - WGS84_E2 * WGS84_A * Math.pow(Math.cos(theta), 3),
    );
  }

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  const height =
    Math.abs(cosLat) > 1e-6
      ? p / cosLat - n
      : Math.abs(z) / Math.abs(sinLat) - n * (1.0 - WGS84_E2);

  return {
    lon,
    lat: latRad * RAD_TO_DEG,
    height,
  };
}

/**
 * Estimate solar elevation angle (degrees above horizon) for a WGS84 point and ISO-8601 UTC timestamp.
 *
 * @param {number} lonDeg
 * @param {number} latDeg
 * @param {string | null | undefined} isoUtc
 * @returns {number | null}
 */
export function estimateSolarElevationDeg(lonDeg, latDeg, isoUtc) {
  if (!isoUtc || !Number.isFinite(lonDeg) || !Number.isFinite(latDeg)) {
    return null;
  }
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;

  const jd = ms / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLon = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const meanAnomRad =
    ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG_TO_RAD;
  const eclipticLonRad =
    (meanLon +
      1.915 * Math.sin(meanAnomRad) +
      0.02 * Math.sin(2 * meanAnomRad)) *
    DEG_TO_RAD;
  const obliquityRad = (23.439 - 0.0000004 * n) * DEG_TO_RAD;

  const sinDecl = Math.sin(obliquityRad) * Math.sin(eclipticLonRad);
  const declRad = Math.asin(Math.max(-1, Math.min(1, sinDecl)));

  const raRad = Math.atan2(
    Math.cos(obliquityRad) * Math.sin(eclipticLonRad),
    Math.cos(eclipticLonRad),
  );
  const gmstDeg = (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360;
  const subsolarLon =
    ((((raRad * RAD_TO_DEG - gmstDeg) % 360) + 540) % 360) - 180;
  const hourAngleRad = (lonDeg - subsolarLon) * DEG_TO_RAD;

  const latRad = latDeg * DEG_TO_RAD;
  const sinElev =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) * RAD_TO_DEG;
}

/**
 * Extract geographic pose, station bounding box, and singularity regimes for a rig record.
 *
 * @param {object} rig
 * @returns {{
 *   lon: number | null,
 *   lat: number | null,
 *   heightM: number | null,
 *   minLon: number | null,
 *   maxLon: number | null,
 *   minLat: number | null,
 *   maxLat: number | null,
 *   solarElevationDeg: number | null,
 *   regimes: string[]
 * }}
 */
export function analyzeRigSpatialEnvelope(rig, repoRoot = process.cwd()) {
  let lon = null;
  let lat = null;
  let heightM = null;

  const cam = rig.camera;
  if (cam && typeof cam === "object") {
    if (
      Number.isFinite(cam.lon) &&
      Number.isFinite(cam.lat) &&
      Number.isFinite(cam.height)
    ) {
      lon = cam.lon;
      lat = cam.lat;
      heightM = cam.height;
    } else if (Array.isArray(cam.position) && cam.position.length === 3) {
      const converted = ecefToWgs84(
        cam.position[0],
        cam.position[1],
        cam.position[2],
      );
      lon = converted.lon;
      lat = converted.lat;
      heightM = converted.height;
    }
  }

  const lons = [];
  const lats = [];
  const heights = [];
  if (lon !== null && lat !== null) {
    lons.push(lon);
    lats.push(lat);
  }
  if (heightM !== null) heights.push(heightM);

  if (Array.isArray(rig.stations)) {
    for (const st of rig.stations) {
      if (Number.isFinite(st.lon) && Number.isFinite(st.lat)) {
        lons.push(st.lon);
        lats.push(st.lat);
      }
      if (Number.isFinite(st.height)) {
        heights.push(st.height);
      }
    }
  }

  const indirect = extractIndirectRigCoordinates(rig, repoRoot, ecefToWgs84, {
    hasDirectPose: lons.length > 0,
  });
  if (lons.length === 0 && indirect.lons.length > 0) {
    lons.push(...indirect.lons);
    lats.push(...indirect.lats);
    heights.push(...indirect.heights);
    lon = indirect.lons[0];
    lat = indirect.lats[0];
    heightM = indirect.heights.length > 0 ? indirect.heights[0] : null;
  }

  const minLon = lons.length > 0 ? Math.min(...lons) : null;
  const maxLon = lons.length > 0 ? Math.max(...lons) : null;
  const minLat = lats.length > 0 ? Math.min(...lats) : null;
  const maxLat = lats.length > 0 ? Math.max(...lats) : null;

  const solarElevationDeg =
    lon !== null && lat !== null
      ? estimateSolarElevationDeg(lon, lat, rig.clock)
      : null;

  const regimes = new Set(indirect.extraRegimes);
  const tags = new Set(Array.isArray(rig.tags) ? rig.tags : []);
  const textBlob =
    `${rig.id ?? ""} ${rig.description ?? ""} ${rig.region ?? ""} ${rig.harness ?? ""} ${JSON.stringify(rig.setupParams ?? {})}`.toLowerCase();

  if (maxLat !== null && maxLat >= 80) regimes.add("north_pole");
  if (minLat !== null && minLat <= -80) regimes.add("south_pole");
  if (
    (maxLat !== null && Math.abs(maxLat) >= 60) ||
    (minLat !== null && Math.abs(minLat) >= 60) ||
    tags.has("polar")
  ) {
    regimes.add("high_latitude");
  }
  if (minLat !== null && maxLat !== null && minLat <= 15 && maxLat >= -15) {
    regimes.add("equatorial");
  }
  if (
    lons.some((l) => Math.abs(l) >= 170) ||
    (minLon !== null && maxLon !== null && maxLon - minLon > 180)
  ) {
    regimes.add("antimeridian_seam");
  }
  if (minLon !== null && maxLon !== null && minLon <= 2 && maxLon >= -2) {
    regimes.add("prime_meridian_seam");
  }

  const minH = heights.length > 0 ? Math.min(...heights) : null;
  const maxH = heights.length > 0 ? Math.max(...heights) : null;

  if (
    (minH !== null && minH < 0) ||
    /\b(?:underground|subsurface|excavat|pit|inside-camera|inside-positive)\b/.test(
      textBlob,
    )
  ) {
    regimes.add("sub_ellipsoid_or_underground");
  }
  if (heights.some((h) => h >= 0 && h <= 2000)) {
    regimes.add("near_surface");
  }
  if (heights.some((h) => h > 2000 && h <= 18000) || tags.has("cloud")) {
    regimes.add("cloud_deck_altitude");
  }
  if (heights.some((h) => h > 18000 && h <= 250000)) {
    regimes.add("stratospheric_or_limb");
  }
  if ((maxH !== null && maxH > 250000) || tags.has("orbital-ladder")) {
    regimes.add("orbital");
  }

  if (solarElevationDeg !== null) {
    if (solarElevationDeg >= -8 && solarElevationDeg <= 10) {
      regimes.add("grazing_terminator");
    } else if (solarElevationDeg < -8) {
      regimes.add("night_lit");
    }
  } else if (
    /\b(?:terminator|twilight|dusk|dawn|sunset|sunrise)\b/.test(textBlob)
  ) {
    regimes.add("grazing_terminator");
  }

  if (
    tags.has("water") ||
    tags.has("ssr") ||
    /\b(?:ocean|water|coast|marine|sea|lake|river|reflection)\b/.test(textBlob)
  ) {
    regimes.add("coastal_or_water");
  }
  if (
    minH !== null &&
    minH < 0 &&
    (tags.has("water") ||
      /\b(?:ocean|water|bathy|submerged|abyssal|shelf|mariana)\b/.test(
        textBlob,
      ))
  ) {
    regimes.add("sub_ellipsoid_ocean_bathy");
  }
  if (
    (tags.has("water") || /\b(?:water|lake|river)\b/.test(textBlob)) &&
    /\b(?:lake|lakes|river|rivers|inland|playa|great-lakes|nile)\b/.test(
      textBlob,
    )
  ) {
    regimes.add("inland_lake_or_river");
  }
  if (
    regimes.has("antimeridian_seam") &&
    (tags.has("water") ||
      /\b(?:coast|water|ocean|chukotka|fiji)\b/.test(textBlob))
  ) {
    regimes.add("antimeridian_coast_sdf");
  }
  if (tags.has("voxel") || /\bvoxel\b/.test(textBlob)) {
    regimes.add("voxel_volume");
  }
  if (/\b(?:scene2d|columbus|2d-mode|morph)\b/.test(textBlob)) {
    regimes.add("2d_or_columbus");
  }

  return {
    lon,
    lat,
    heightM,
    minLon,
    maxLon,
    minLat,
    maxLat,
    solarElevationDeg,
    regimes: [...regimes].sort(),
  };
}

/**
 * Load all `.mjs` rig definitions from a directory.
 *
 * @param {string} repoRoot
 * @param {string} [rigsRelDir]
 * @returns {Promise<Array<{ rig: object, relPath: string }>>}
 */
export async function loadRigRecords(
  repoRoot,
  rigsRelDir = "Tools/visual-regression/rigs",
) {
  const absDir = path.resolve(repoRoot, rigsRelDir);
  if (!fs.existsSync(absDir)) return [];
  const names = fs
    .readdirSync(absDir)
    .filter((n) => n.endsWith(".mjs"))
    .sort();
  const loaded = [];
  for (const name of names) {
    const full = path.join(absDir, name);
    const mod = await import(pathToFileURL(full).href);
    if (mod.default && typeof mod.default === "object") {
      loaded.push({
        rig: mod.default,
        relPath: toPosixRel(repoRoot, full),
      });
    }
  }
  loaded.sort((a, b) => String(a.rig.id).localeCompare(String(b.rig.id)));
  return loaded;
}

/**
 * Greedy weighted set-cover selector that picks the smallest set of Probe Kit rigs
 * covering `requiredTargets` (any mix of spatial regime names and `RIG_TAGS`),
 * breaking ties toward dual-backend (`webgl` + `webgpu`) and lower settle cost.
 *
 * @param {Array<{ id: string, tags: string[], renderers: string[], regimes: string[], file_path?: string }>} rigs
 * @param {string[]} requiredTargets
 * @param {{ preferDualBackend?: boolean, primaryDomainTag?: string }} [options]
 */
export function selectMinimalRigCover(rigs, requiredTargets, options = {}) {
  const preferDualBackend = options.preferDualBackend !== false;
  const primaryDomainTag = options.primaryDomainTag ?? null;
  const remaining = new Set(requiredTargets.filter(Boolean));
  const selectedRigs = [];
  const usedIds = new Set();

  while (remaining.size > 0) {
    let best = null;
    let bestCovered = [];
    let bestScore = -1;

    for (const rig of rigs) {
      if (usedIds.has(rig.id)) continue;
      const cap = new Set([...(rig.regimes ?? []), ...(rig.tags ?? [])]);
      const hits = [...remaining].filter((t) => cap.has(t));
      if (hits.length === 0) continue;

      const isDual =
        Array.isArray(rig.renderers) &&
        rig.renderers.includes("webgl") &&
        rig.renderers.includes("webgpu");
      const hasPrimaryDomain =
        Boolean(primaryDomainTag) &&
        Array.isArray(rig.tags) &&
        rig.tags.includes(primaryDomainTag);
      const isOffControlTwin = /-off$/.test(String(rig.id ?? ""));
      const score =
        hits.length * 100 +
        (hasPrimaryDomain ? 40 : 0) +
        (preferDualBackend && isDual ? 5 : 0) -
        (isOffControlTwin ? 2 : 0);

      if (
        score > bestScore ||
        (score === bestScore && best && rig.id.localeCompare(best.id) < 0)
      ) {
        best = rig;
        bestCovered = hits;
        bestScore = score;
      }
    }

    if (!best) break;
    usedIds.add(best.id);
    selectedRigs.push({
      ...best,
      newlyCovered: bestCovered,
    });
    for (const hit of bestCovered) {
      remaining.delete(hit);
    }
  }

  return {
    selectedRigs,
    coveredTargets: requiredTargets.filter((t) => !remaining.has(t)),
    uncoveredTargets: [...remaining],
  };
}

/**
 * Identify canonical spatial/coordinate singularity regimes that have zero rig coverage.
 *
 * @param {Array<{ regimes: string[] }>} rigs
 * @returns {string[]}
 */
export function findSpatialCoverageGaps(rigs) {
  const present = new Set();
  for (const r of rigs) {
    for (const reg of r.regimes ?? []) {
      present.add(reg);
    }
  }
  return CANONICAL_SPATIAL_REGIMES.filter((reg) => !present.has(reg));
}

/**
 * Populate `spatial_rigs`, `spatial_rigs_rtree`, and `gis_assets`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {{ rigsDir?: string, gisAssets?: object[] }} [options]
 */
export async function indexSpatialAndGis(db, repoRoot, options = {}) {
  const rigRecords = await loadRigRecords(repoRoot, options.rigsDir);
  const gisAssets = options.gisAssets ?? inspectLiveGisAssets(repoRoot);

  const insertRig = db.prepare(`
    INSERT INTO spatial_rigs(
      id, file_path, tags_json, renderers_json,
      lon, lat, height_m, min_lon, max_lon, min_lat, max_lat,
      clock_utc, solar_elevation_deg, regimes_json, dials_json, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRtree = db.prepare(`
    INSERT INTO spatial_rigs_rtree(rowid_num, min_lon, max_lon, min_lat, max_lat)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertGis = db.prepare(`
    INSERT OR REPLACE INTO gis_assets(
      id, builder_path, asset_path, crs_from, crs_to, vertical_datum,
      min_lon, max_lon, min_lat, max_lat, resolution_deg, seam_rule, error_budget, consumers_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGisEdge = db.prepare(`
    INSERT OR IGNORE INTO edges(src_id, dst_id, relation, provenance, detail, file_path, line)
    VALUES (?, ?, ?, 'gis-asset', ?, ?, 1)
  `);

  let geoIndexedCount = 0;
  const analyzedList = [];

  db.exec("BEGIN;");
  try {
    db.exec("DELETE FROM spatial_rigs_rtree;");
    db.exec("DELETE FROM spatial_rigs;");
    db.exec("DELETE FROM gis_assets;");
    db.exec("DELETE FROM edges WHERE provenance = 'gis-asset';");

    for (const { rig, relPath } of rigRecords) {
      const env = analyzeRigSpatialEnvelope(rig, repoRoot);
      analyzedList.push({ id: rig.id, regimes: env.regimes });
      const res = insertRig.run(
        rig.id,
        relPath,
        JSON.stringify(rig.tags ?? []),
        JSON.stringify(rig.renderers ?? []),
        env.lon,
        env.lat,
        env.heightM,
        env.minLon,
        env.maxLon,
        env.minLat,
        env.maxLat,
        rig.clock ?? null,
        env.solarElevationDeg !== null
          ? Number(env.solarElevationDeg.toFixed(2))
          : null,
        JSON.stringify(env.regimes),
        rig.dials ? JSON.stringify(rig.dials) : null,
        rig.description ?? null,
      );

      if (
        env.minLon !== null &&
        env.maxLon !== null &&
        env.minLat !== null &&
        env.maxLat !== null
      ) {
        insertRtree.run(
          Number(res.lastInsertRowid),
          env.minLon,
          env.maxLon,
          env.minLat,
          env.maxLat,
        );
        geoIndexedCount += 1;
      }
    }

    for (const asset of gisAssets) {
      insertGis.run(
        asset.id,
        asset.builderPath,
        asset.assetPath,
        asset.crsFrom,
        asset.crsTo,
        asset.verticalDatum,
        asset.minLon,
        asset.maxLon,
        asset.minLat,
        asset.maxLat,
        asset.resolutionDeg ?? null,
        asset.seamRule,
        asset.errorBudget ?? null,
        JSON.stringify(asset.consumers ?? []),
      );

      const gisNodeId = `gis:${asset.id}`;
      for (const consumer of asset.consumers ?? []) {
        insertGisEdge.run(
          `file:${consumer}`,
          gisNodeId,
          "gis_consumes",
          `${asset.crsFrom} -> ${asset.crsTo} (${asset.seamRule})`,
          consumer,
        );
      }
      for (const gate of asset.gates ?? []) {
        insertGisEdge.run(
          gisNodeId,
          `file:${gate}`,
          "gis_verified_by",
          asset.errorBudget ?? "GIS asset verification spec/probe",
          gate,
        );
        for (const consumer of asset.consumers ?? []) {
          insertGisEdge.run(
            `file:${consumer}`,
            `file:${gate}`,
            "gis_verified_by",
            `${asset.id}: ${asset.errorBudget ?? "GIS verification gate"}`,
            gate,
          );
        }
      }
    }

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return {
    rigCount: rigRecords.length,
    geoIndexedCount,
    gisAssetCount: gisAssets.length,
    coverageGaps: findSpatialCoverageGaps(analyzedList),
  };
}
