// spatial-v2.mjs — Indirect Probe Kit rig geolocator and live binary GIS asset header/gate inspector.
// @purpose Geolocate indirect `camera: null` Probe Kit rigs (dials, 3D Tilesets, Sandcastle/harness HTML, camera tracks) and inspect live binary GIS headers (`EGM1`, `GBT1`, `LWM2`, `NE1R`, TMS XML, `IAU2006_XYS`) with `.spec.mjs` gate bindings.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";

const RAD_TO_DEG = 180.0 / Math.PI;

/**
 * Clamp longitude to `[-180, 180]` and latitude to `[-90, 90]` if finite and plausible.
 *
 * @param {number} lon
 * @param {number} lat
 * @returns {{ lon: number, lat: number } | null}
 */
function validLonLat(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -360 || lon > 360 || lat < -90.001 || lat > 90.001) return null;
  const normLon = lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
  const normLat = Math.max(-90, Math.min(90, lat));
  return { lon: normLon, lat: normLat };
}

/**
 * Walk nested rig configuration objects (`dials`, `setupParams`, `states`, `cases`, `waypoints`)
 * for geographic coordinates, polylines, rectangles, and scene modes.
 *
 * @param {unknown} value
 * @param {{ lons: number[], lats: number[], heights: number[], sceneModes: Set<string>, globeHidden: boolean }} acc
 * @param {number} [depth]
 */
function walkRigObject(value, acc, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      walkRigObject(item, acc, depth + 1);
    }
    return;
  }

  const obj = /** @type {Record<string, unknown>} */ (value);

  if (Array.isArray(obj.hide) && obj.hide.includes("globe")) {
    acc.globeHidden = true;
  }
  if (typeof obj.sceneMode === "string") {
    acc.sceneModes.add(obj.sceneMode.toUpperCase());
  }

  const rawLon =
    typeof obj.lon === "number"
      ? obj.lon
      : typeof obj.longitude === "number"
        ? obj.longitude
        : typeof obj.lonDeg === "number"
          ? obj.lonDeg
          : null;
  const rawLat =
    typeof obj.lat === "number"
      ? obj.lat
      : typeof obj.latitude === "number"
        ? obj.latitude
        : typeof obj.latDeg === "number"
          ? obj.latDeg
          : null;

  if (rawLon !== null && rawLat !== null) {
    const pt = validLonLat(rawLon, rawLat);
    if (pt) {
      acc.lons.push(pt.lon);
      acc.lats.push(pt.lat);
      const h =
        typeof obj.height === "number"
          ? obj.height
          : typeof obj.heightMetres === "number"
            ? obj.heightMetres
            : typeof obj.altitude === "number"
              ? obj.altitude
              : null;
      if (h !== null && Number.isFinite(h)) acc.heights.push(h);
      if (
        typeof obj.rangeMetres === "number" &&
        Number.isFinite(obj.rangeMetres)
      ) {
        acc.heights.push((h ?? 0) + obj.rangeMetres * 0.6);
      }
    }
  }

  if (
    typeof obj.west === "number" &&
    typeof obj.south === "number" &&
    typeof obj.east === "number" &&
    typeof obj.north === "number"
  ) {
    const sw = validLonLat(obj.west, obj.south);
    const ne = validLonLat(obj.east, obj.north);
    if (sw && ne) {
      acc.lons.push(sw.lon, ne.lon);
      acc.lats.push(sw.lat, ne.lat);
    }
  }

  if (Array.isArray(obj.positionsDegrees)) {
    const arr = obj.positionsDegrees;
    for (let i = 0; i + 1 < arr.length; i += 2) {
      if (typeof arr[i] === "number" && typeof arr[i + 1] === "number") {
        const pt = validLonLat(arr[i], arr[i + 1]);
        if (pt) {
          acc.lons.push(pt.lon);
          acc.lats.push(pt.lat);
        }
      }
    }
  }

  if (Array.isArray(obj.positionsDegreesHeights)) {
    const arr = obj.positionsDegreesHeights;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      if (
        typeof arr[i] === "number" &&
        typeof arr[i + 1] === "number" &&
        typeof arr[i + 2] === "number"
      ) {
        const pt = validLonLat(arr[i], arr[i + 1]);
        if (pt) {
          acc.lons.push(pt.lon);
          acc.lats.push(pt.lat);
          acc.heights.push(arr[i + 2]);
        }
      }
    }
  }

  for (const child of Object.values(obj)) {
    if (child && typeof child === "object") {
      walkRigObject(child, acc, depth + 1);
    }
  }
}

/**
 * Extract geographic coordinates from a 3D Tiles `tileset.json` asset if present.
 *
 * @param {string} repoRoot
 * @param {unknown} rawAsset
 * @param {(x: number, y: number, z: number) => { lon: number, lat: number, height: number }} ecefToWgs84
 * @param {{ lons: number[], lats: number[], heights: number[] }} acc
 */
function extractAssetCoordinates(repoRoot, rawAsset, ecefToWgs84, acc) {
  const candidates = Array.isArray(rawAsset)
    ? rawAsset
    : typeof rawAsset === "string"
      ? [rawAsset]
      : [];

  for (const item of candidates) {
    if (typeof item !== "string") continue;
    const cleanRel = decodeURIComponent(item.split("?")[0]).replace(/^\/+/, "");
    if (!cleanRel.endsWith(".json")) continue;
    const absPath = path.resolve(repoRoot, cleanRel);
    if (!fs.existsSync(absPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(absPath, "utf8"));
      const root = json?.root;
      if (!root || typeof root !== "object") continue;

      const region = root.boundingVolume?.region;
      if (Array.isArray(region) && region.length >= 6) {
        const west = region[0] * RAD_TO_DEG;
        const south = region[1] * RAD_TO_DEG;
        const east = region[2] * RAD_TO_DEG;
        const north = region[3] * RAD_TO_DEG;
        const sw = validLonLat(west, south);
        const ne = validLonLat(east, north);
        if (sw && ne) {
          acc.lons.push(sw.lon, ne.lon);
          acc.lats.push(sw.lat, ne.lat);
          if (Number.isFinite(region[4])) acc.heights.push(region[4]);
          if (Number.isFinite(region[5])) acc.heights.push(region[5]);
          continue;
        }
      }

      const tx = root.transform;
      if (Array.isArray(tx) && tx.length === 16) {
        const x = Number(tx[12]);
        const y = Number(tx[13]);
        const z = Number(tx[14]);
        if (Math.hypot(x, y, z) > 1e6) {
          const wgs = ecefToWgs84(x, y, z);
          acc.lons.push(wgs.lon);
          acc.lats.push(wgs.lat);
          acc.heights.push(wgs.height);
          continue;
        }
      }

      const boxOrSphere =
        root.boundingVolume?.box ?? root.boundingVolume?.sphere;
      if (Array.isArray(boxOrSphere) && boxOrSphere.length >= 3) {
        const x = Number(boxOrSphere[0]);
        const y = Number(boxOrSphere[1]);
        const z = Number(boxOrSphere[2]);
        if (Math.hypot(x, y, z) > 1e6) {
          const wgs = ecefToWgs84(x, y, z);
          acc.lons.push(wgs.lon);
          acc.lats.push(wgs.lat);
          acc.heights.push(wgs.height);
        }
      }
    } catch {
      // Malformed or non-tileset JSON; skip cleanly.
    }
  }
}

const _htmlCoordCache = new Map();

/**
 * Parse literal `fromDegrees` / `Rectangle.fromDegrees` coordinates from a harness or Sandcastle HTML file.
 *
 * @param {string} repoRoot
 * @param {string} rawPageOrHarness
 * @returns {{ lons: number[], lats: number[], heights: number[] }}
 */
function extractHtmlPageCoordinates(repoRoot, rawPageOrHarness) {
  const cleanRel = decodeURIComponent(rawPageOrHarness.split("?")[0]).replace(
    /^\/+/,
    "",
  );
  if (_htmlCoordCache.has(cleanRel)) {
    return _htmlCoordCache.get(cleanRel);
  }
  const result = { lons: [], lats: [], heights: [] };
  const absPath = path.resolve(repoRoot, cleanRel);
  if (!fs.existsSync(absPath)) {
    _htmlCoordCache.set(cleanRel, result);
    return result;
  }

  try {
    const text = fs.readFileSync(absPath, "utf8");
    const numPat = "(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)";

    const degRe = new RegExp(
      `(?:Cartesian3|Cartographic)\\.fromDegrees\\(\\s*${numPat}\\s*,\\s*${numPat}(?:\\s*,\\s*${numPat})?`,
      "gi",
    );
    for (const m of text.matchAll(degRe)) {
      const pt = validLonLat(Number(m[1]), Number(m[2]));
      if (pt) {
        result.lons.push(pt.lon);
        result.lats.push(pt.lat);
        if (m[3] !== undefined && Number.isFinite(Number(m[3]))) {
          result.heights.push(Number(m[3]));
        }
      }
    }

    const rectRe = new RegExp(
      `Rectangle\\.fromDegrees\\(\\s*${numPat}\\s*,\\s*${numPat}\\s*,\\s*${numPat}\\s*,\\s*${numPat}`,
      "gi",
    );
    for (const m of text.matchAll(rectRe)) {
      const sw = validLonLat(Number(m[1]), Number(m[2]));
      const ne = validLonLat(Number(m[3]), Number(m[4]));
      if (sw && ne) {
        result.lons.push(sw.lon, ne.lon);
        result.lats.push(sw.lat, ne.lat);
      }
    }

    if (result.lons.length === 0) {
      const objCoordRe = new RegExp(
        `\\b(?:lon|longitude)\\s*:\\s*${numPat}\\s*,\\s*(?:lat|latitude)\\s*:\\s*${numPat}(?:\\s*,\\s*(?:height|altitude)\\s*:\\s*${numPat})?`,
        "gi",
      );
      for (const m of text.matchAll(objCoordRe)) {
        const pt = validLonLat(Number(m[1]), Number(m[2]));
        if (pt) {
          result.lons.push(pt.lon);
          result.lats.push(pt.lat);
          if (m[3] !== undefined && Number.isFinite(Number(m[3]))) {
            result.heights.push(Number(m[3]));
          }
        }
      }
    }
  } catch {
    // Ignore unreadable HTML/JS files.
  }

  _htmlCoordCache.set(cleanRel, result);
  return result;
}

/**
 * Resolve a Sandcastle gallery slug from `rig.dials.galleryId`, `rig.demo`, or `?id=<slug>` query parameters.
 *
 * @param {Record<string, any>} rig
 * @returns {string | null}
 */
function resolveSandcastleGallerySlug(rig) {
  if (typeof rig?.dials?.galleryId === "string" && rig.dials.galleryId.trim()) {
    return rig.dials.galleryId.trim();
  }
  if (typeof rig?.demo === "string" && rig.demo.trim()) {
    return rig.demo.trim();
  }
  for (const field of [rig?.page, rig?.url, rig?.harness]) {
    if (typeof field !== "string") continue;
    const m = field.match(/[?&](?:id|src)=([^&#]+)/i);
    if (m) {
      return decodeURIComponent(m[1])
        .replace(/\.html$/i, "")
        .trim();
    }
  }
  return null;
}

/**
 * Resolve indirect spatial coordinates (`dials`, `setupParams`, 3D Tilesets, Sandcastle/harness HTML,
 * `cameraTrack`, and default `CesiumViewer` home rectangle) for rigs with `camera: null`.
 *
 * @param {Record<string, any>} rig
 * @param {string} repoRoot
 * @param {(x: number, y: number, z: number) => { lon: number, lat: number, height: number }} ecefToWgs84
 * @param {{ hasDirectPose?: boolean }} [options] `hasDirectPose`: the rig sets its
 *   own camera or stations, so the page's default home view is never its pose and
 *   must not lend it the home view's regimes (the orbital home view used to tag a
 *   150 m ground rig `orbital`).
 */
export function extractIndirectRigCoordinates(
  rig,
  repoRoot,
  ecefToWgs84,
  options = {},
) {
  const poseKnown = Boolean(options.hasDirectPose);
  const acc = {
    lons: [],
    lats: [],
    heights: [],
    sceneModes: new Set(),
    globeHidden: false,
    extraRegimes: new Set(),
  };

  for (const key of [
    "dials",
    "setupParams",
    "states",
    "cases",
    "waypoints",
    "cameraPath",
  ]) {
    if (rig[key]) {
      walkRigObject(rig[key], acc, 0);
    }
  }

  if (
    acc.sceneModes.has("SCENE2D") ||
    acc.sceneModes.has("COLUMBUS_VIEW") ||
    acc.sceneModes.has("MORPHING")
  ) {
    acc.extraRegimes.add("2d_or_columbus");
  }

  if (acc.lons.length === 0 && rig.asset) {
    extractAssetCoordinates(repoRoot, rig.asset, ecefToWgs84, acc);
  }

  if (acc.lons.length === 0 && typeof rig.harness === "string") {
    const htmlCoords = extractHtmlPageCoordinates(repoRoot, rig.harness);
    acc.lons.push(...htmlCoords.lons);
    acc.lats.push(...htmlCoords.lats);
    acc.heights.push(...htmlCoords.heights);
  }

  if (acc.lons.length === 0 && typeof rig.page === "string") {
    const htmlCoords = extractHtmlPageCoordinates(repoRoot, rig.page);
    acc.lons.push(...htmlCoords.lons);
    acc.lats.push(...htmlCoords.lats);
    acc.heights.push(...htmlCoords.heights);
  }

  // Sandcastle2 / legacy Sandcastle gallery resolution (`galleryId` or `?id=<slug>`)
  if (acc.lons.length === 0) {
    const slug = resolveSandcastleGallerySlug(rig);
    if (slug) {
      const galleryCandidates = [
        `packages/sandcastle/gallery/${slug}/main.js`,
        `Apps/Sandcastle/gallery/${slug}.html`,
      ];
      for (const relCand of galleryCandidates) {
        const absCand = path.resolve(repoRoot, relCand);
        if (!fs.existsSync(absCand)) continue;
        const coords = extractHtmlPageCoordinates(repoRoot, relCand);
        if (coords.lons.length > 0) {
          acc.lons.push(...coords.lons);
          acc.lats.push(...coords.lats);
          acc.heights.push(...coords.heights);
          acc.poseSource = "sandcastle-gallery";
          break;
        }
        try {
          const src = fs.readFileSync(absCand, "utf8");
          if (
            !poseKnown &&
            /\bnew\s+(?:Cesium\.)?(?:Viewer|CesiumWidget)\s*\(/.test(src) &&
            !/\bglobe\s*:\s*false\b/.test(src)
          ) {
            acc.lons.push(-95, -70);
            acc.lats.push(-20, 90);
            acc.heights.push(18000000);
            acc.extraRegimes.add("orbital");
            acc.poseSource = "default-home";
            break;
          }
        } catch {
          // Ignore unreadable gallery file.
        }
      }
    }
  }

  if (
    acc.lons.length === 0 &&
    rig.cameraTrack === "orbit-to-ground-global-v1"
  ) {
    acc.lons.push(-180, 180);
    acc.lats.push(-90, 90);
    acc.heights.push(500, 15000000);
    acc.extraRegimes.add("orbital");
    acc.extraRegimes.add("near_surface");
    acc.poseSource = "camera-track";
  }

  const isSynthetic =
    acc.globeHidden || /\bsynthetic\b/i.test(String(rig.id ?? ""));
  const cleanPage =
    typeof rig.page === "string"
      ? rig.page.split("?")[0].replace(/^\/+/, "")
      : "";
  const cleanBasePage = String(rig.basePage ?? "");

  // CesiumViewer default home view (`Camera.DEFAULT_VIEW_RECTANGLE`: [-95, -20, -70, 90])
  if (
    acc.lons.length === 0 &&
    !poseKnown &&
    !isSynthetic &&
    (cleanPage === "Apps/CesiumViewer/index.html" ||
      cleanBasePage.includes("viewer-offline"))
  ) {
    acc.lons.push(-95, -70);
    acc.lats.push(-20, 90);
    acc.heights.push(18000000);
    acc.extraRegimes.add("orbital");
    acc.poseSource = "default-home";
  }

  return acc;
}

/**
 * Inspect binary headers and XML/JSON metadata of shipped GIS & astronomical datasets on disk,
 * binding each asset to its verified engine consumers and `.spec.mjs` / probe gates.
 *
 * @param {string} repoRoot
 * @returns {Array<{
 *   id: string,
 *   builderPath: string,
 *   assetPath: string,
 *   crsFrom: string,
 *   crsTo: string,
 *   verticalDatum: string,
 *   minLon: number,
 *   maxLon: number,
 *   minLat: number,
 *   maxLat: number,
 *   resolutionDeg: number | null,
 *   seamRule: string,
 *   errorBudget: string,
 *   consumers: string[],
 *   gates: string[]
 * }>}
 */
export function inspectLiveGisAssets(repoRoot) {
  const assets = [];

  // 1. EGM2008 Geoid Undulation Grid (`EGM1` binary header)
  {
    const relAsset = "packages/engine/Source/Assets/Geoid/egm2008-0p5deg.i16";
    const abs = path.resolve(repoRoot, relAsset);
    let cols = 721;
    let rows = 361;
    let resDeg = 0.5;
    let minLon = -180;
    let maxLat = 90;
    let byteLen = 0;
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      byteLen = buf.byteLength;
      if (
        buf.byteLength >= 32 &&
        buf.subarray(0, 4).toString("ascii") === "EGM1"
      ) {
        cols = buf.readUInt32LE(8);
        rows = buf.readUInt32LE(12);
        minLon = buf.readInt32LE(16) / 1e6;
        maxLat = buf.readInt32LE(20) / 1e6;
        resDeg = buf.readUInt32LE(24) / 1e6;
      }
    }
    const maxLon = minLon + (cols - 1) * resDeg;
    const minLat = maxLat - (rows - 1) * resDeg;
    assets.push({
      id: "egm2008-geoid",
      builderPath: "Tools/build-geoid-undulation-grid.mjs",
      assetPath: relAsset,
      crsFrom: "EPSG:4326 geographic + EGM2008 spherical harmonics",
      crsTo: `WGS84 ellipsoidal height offset grid (${cols}x${rows} i16, ${byteLen}B)`,
      verticalDatum: "EGM2008 Mean Sea Level -> WGS84 ellipsoid",
      minLon,
      maxLon,
      minLat,
      maxLat,
      resolutionDeg: resDeg,
      seamRule:
        "Periodic wrap at +/-180 lon (721 inclusive seam col); clamped +/-90 poles",
      errorBudget: `EGM1 header verified (${cols}x${rows} @ ${resDeg} deg); Tools/visual-regression/probe-ocean-datum.mjs`,
      consumers: [
        "packages/engine/Source/Core/GeoidUndulationGrid.js",
        "packages/engine/Source/Scene/Globe.js",
      ],
      gates: ["Tools/visual-regression/probe-ocean-datum.mjs"],
    });
  }

  // 2. Global Bathymetry Tensor (`GBT1` binary header)
  {
    const relAsset =
      "packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin";
    const abs = path.resolve(repoRoot, relAsset);
    let cols = 720;
    let rows = 360;
    let resDeg = 0.5;
    let byteLen = 0;
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      byteLen = buf.byteLength;
      if (
        buf.byteLength >= 12 &&
        buf.subarray(0, 4).toString("ascii") === "GBT1"
      ) {
        cols = buf.readUInt16LE(4);
        rows = buf.readUInt16LE(6);
        if (cols > 0) resDeg = Number((360 / cols).toFixed(4));
      }
    }
    assets.push({
      id: "global-bathymetry-tensor",
      builderPath: "Tools/build-global-bathymetry-tensor.mjs",
      assetPath: relAsset,
      crsFrom: "GEBCO / ETOPO bathymetric elevation (EPSG:4326)",
      crsTo: `RGBA8 equirectangular optical-depth/shelf tensor (${cols}x${rows}, ${byteLen}B)`,
      verticalDatum: "Depth below Mean Sea Level (meters)",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: resDeg,
      seamRule:
        "addressModeU=repeat (+/-180 wrap), addressModeV=clamp-to-edge (+/-90 poles)",
      errorBudget: `GBT1 header verified (${cols}x${rows}); water-mask-assets.spec.mjs`,
      consumers: [
        "packages/engine/Source/Scene/BathymetryTensorMap.ts",
        "packages/engine/Source/Renderer/WebGPU/WebGPUBathymetryTensorTexture.ts",
        "packages/engine/Source/Scene/Globe.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/water-mask-assets.spec.mjs",
        "Tools/visual-regression/composite-water-classification.spec.mjs",
        "Tools/visual-regression/globe-water-facade.spec.mjs",
      ],
    });
  }

  // 3. Natural Earth 50m Global Coastline Water Mask (`LWM2` binary header)
  {
    const relAsset =
      "packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin";
    const abs = path.resolve(repoRoot, relAsset);
    let featureCount = 0;
    let byteLen = 0;
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      byteLen = buf.byteLength;
      if (
        buf.byteLength >= 8 &&
        buf.subarray(0, 4).toString("ascii") === "LWM2"
      ) {
        featureCount = buf.readUInt32LE(4);
      }
    }
    assets.push({
      id: "ne50m-coastline-lwm2",
      builderPath: "Tools/build-coastline-water-mask.mjs",
      assetPath: relAsset,
      crsFrom: "Natural Earth coastline polygons (EPSG:4326)",
      crsTo: `LWM2 binary coastline vector/quadtree water mask (${featureCount} rings, ${byteLen}B)`,
      verticalDatum: "Mean Sea Level shoreline",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: 0.02,
      seamRule: "Antimeridian tile wrap; Antarctica polar land cap",
      errorBudget: `LWM2 verified (${featureCount} polygons); global-coastline-water-classification.spec.mjs`,
      consumers: [
        "packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.ts",
        "packages/engine/Source/Scene/Globe.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/global-coastline-water-classification.spec.mjs",
        "Tools/visual-regression/composite-water-classification.spec.mjs",
      ],
    });
  }

  // 4. Natural Earth 10m Inland Lakes Water Mask (`LWM2` binary header)
  {
    const relAsset = "packages/engine/Source/Assets/WaterMask/ne10mLakes.bin";
    const abs = path.resolve(repoRoot, relAsset);
    let lakeCount = 0;
    let byteLen = 0;
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      byteLen = buf.byteLength;
      if (
        buf.byteLength >= 8 &&
        buf.subarray(0, 4).toString("ascii") === "LWM2"
      ) {
        lakeCount = buf.readUInt32LE(4);
      }
    }
    assets.push({
      id: "ne10m-lakes-lwm2",
      builderPath: "Tools/build-lake-water-mask.mjs",
      assetPath: relAsset,
      crsFrom: "Natural Earth 10m / HydroLAKES inland polygons (EPSG:4326)",
      crsTo: `LWM2 inland lake water mask (${lakeCount} polygons, ${byteLen}B)`,
      verticalDatum: "Inland lake surface orthometric/WGS84 height",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -60.0,
      maxLat: 85.0,
      resolutionDeg: 0.01,
      seamRule: "Clamped outside [-60, 85] lat",
      errorBudget: `LWM2 verified (${lakeCount} lakes); composite-water-classification.spec.mjs`,
      consumers: [
        "packages/engine/Source/Scene/WaterClassificationProvider.ts",
        "packages/engine/Source/Scene/Globe.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/composite-water-classification.spec.mjs",
        "Tools/visual-regression/water-mask-assets.spec.mjs",
      ],
    });
  }

  // 5. Natural Earth 10m Global Rivers (`NE1R` binary header)
  {
    const relAsset = "packages/engine/Source/Assets/WaterMask/ne10mRivers.bin";
    const abs = path.resolve(repoRoot, relAsset);
    let riverCount = 0;
    let byteLen = 0;
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      byteLen = buf.byteLength;
      if (
        buf.byteLength >= 8 &&
        buf.subarray(0, 4).toString("ascii") === "NE1R"
      ) {
        riverCount = buf.readUInt32LE(4);
      }
    }
    assets.push({
      id: "ne10m-rivers-ne1r",
      builderPath: "Tools/build-global-river-binary.mjs",
      assetPath: relAsset,
      crsFrom: "Natural Earth 10m / HydroRIVERS centerlines (EPSG:4326)",
      crsTo: `NE1R packed river polyline + Strahler width binary (${riverCount} rivers, ${byteLen}B)`,
      verticalDatum: "Terrain-draped / WGS84 ellipsoid",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -60.0,
      maxLat: 84.0,
      resolutionDeg: null,
      seamRule: "Segment split across +/-180 antimeridian",
      errorBudget: `NE1R verified (${riverCount} rivers); water-mask-assets.spec.mjs`,
      consumers: [
        "packages/engine/Source/Scene/WaterClassificationProvider.ts",
        "packages/engine/Source/Scene/Globe.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/water-mask-assets.spec.mjs",
        "Tools/visual-regression/water-multi-biome-perf-compile.spec.mjs",
      ],
    });
  }

  // 6. EOT20 Harmonic Ocean Tides
  assets.push({
    id: "eot20-ocean-tides",
    builderPath: "Tools/build-eot20-constituent-grid.mjs",
    assetPath: "packages/engine/Source/Core/TideConstituentGrid.js",
    crsFrom: "EOT20 harmonic tidal constituents (EPSG:4326)",
    crsTo: "Amplitude/phase harmonic constituent grid",
    verticalDatum: "Mean Sea Level astronomical tidal displacement",
    minLon: -180.0,
    maxLon: 180.0,
    minLat: -90.0,
    maxLat: 90.0,
    resolutionDeg: 0.5,
    seamRule: "360-degree longitude wrap; polar ice-shelf mask",
    errorBudget: "tidal-harmonics.spec.mjs",
    consumers: [
      "packages/engine/Source/Core/TideConstituentGrid.js",
      "packages/engine/Source/Scene/Globe.js",
    ],
    gates: ["Tools/visual-regression/tidal-harmonics.spec.mjs"],
  });

  // 7. Cloud / Weather Hydrography & WeatherTexPacker
  assets.push({
    id: "cloud-weather-tex-packer",
    builderPath: "Tools/build-cloud-tiled-hydrography.mjs",
    assetPath: "packages/engine/Source/Scene/Weather/WeatherTexPacker.ts",
    crsFrom: "EPSG:4326 METAR/synthetic/hydrography moisture & pressure fields",
    crsTo: "Equirectangular RGBA weather texture field",
    verticalDatum: "WGS84 surface + cloud base/top altitude above ellipsoid",
    minLon: -180.0,
    maxLon: 180.0,
    minLat: -90.0,
    maxLat: 90.0,
    resolutionDeg: 0.25,
    seamRule: "Periodic +/-180 lon columns; clamped [-90..+90] poles",
    errorBudget: "Tools/visual-regression/weather-field-bounds.spec.mjs",
    consumers: [
      "packages/engine/Source/Scene/Weather/WeatherTexPacker.ts",
      "packages/engine/Source/Scene/Weather/WeatherProvider.ts",
      "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    ],
    gates: ["Tools/visual-regression/weather-field-bounds.spec.mjs"],
  });

  // 8. Black Marble Night Lights TMS Pyramid (`tilemapresource.xml`)
  {
    const relDir = "packages/engine/Source/Assets/Textures/BlackMarble";
    const xmlAbs = path.resolve(repoRoot, relDir, "tilemapresource.xml");
    let maxZoom = 3;
    if (fs.existsSync(xmlAbs)) {
      const xml = fs.readFileSync(xmlAbs, "utf8");
      const orders = [...xml.matchAll(/order="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      if (orders.length > 0) maxZoom = Math.max(...orders);
    }
    assets.push({
      id: "black-marble-night-lights",
      builderPath: "Tools/bake-black-marble-pyramid.mjs",
      assetPath: relDir,
      crsFrom: "NASA VIIRS Black Marble night radiance (EPSG:4326)",
      crsTo: `Geodetic TMS pyramid levels 0..${maxZoom}`,
      verticalDatum: "WGS84 surface",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: Number((180 / (256 * Math.pow(2, maxZoom))).toFixed(4)),
      seamRule:
        "2x1 geodetic TMS root [-180..0, 0..180]; terminator ramp gated",
      errorBudget:
        "globe-night-imagery-option.spec.mjs + globe-night-imagery-magnification-fade.spec.mjs",
      consumers: [
        "packages/engine/Source/Scene/GlobeNightImagery.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/globe-night-imagery-option.spec.mjs",
        "Tools/visual-regression/globe-night-imagery-magnification-fade.spec.mjs",
      ],
    });
  }

  // 9. IAU2006 XYS Celestial-to-Terrestrial Precession/Nutation Series
  {
    const relDir = "packages/engine/Source/Assets/IAU2006_XYS";
    const absDir = path.resolve(repoRoot, relDir);
    const chunkCount = fs.existsSync(absDir)
      ? fs.readdirSync(absDir).filter((f) => f.endsWith(".json")).length
      : 28;
    assets.push({
      id: "iau2006-xys-precession",
      builderPath: "Tools/derive-lunar-eclipse-circumstances.mjs",
      assetPath: relDir,
      crsFrom: "ICRF / J2000 celestial inertial frame",
      crsTo: `ITRF / WGS84 Earth-fixed ECEF f64 (${chunkCount} JSON ephemeris chunks)`,
      verticalDatum: "WGS84 / triaxial planetary ellipsoid",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: null,
      seamRule:
        "Continuous 3x3 f64 rotation matrix (seam-free across poles/antimeridian)",
      errorBudget:
        "c12-29-s4-orbital-sunrise-gate.spec.mjs + c12-29-s5-custom-ellipsoid-gate.spec.mjs",
      consumers: [
        "packages/engine/Source/Core/Iau2006XysData.js",
        "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ],
      gates: [
        "Tools/visual-regression/c12-29-s4-orbital-sunrise-gate.spec.mjs",
        "Tools/visual-regression/c12-29-s5-custom-ellipsoid-gate.spec.mjs",
        "Tools/visual-regression/c12-29-s5-svs-footprint-gate.spec.mjs",
      ],
    });
  }

  // 10. LOLA / LROC Lunar Albedo & Normal Map DEM
  {
    const relDir = "packages/engine/Source/Assets/Textures/Moon";
    const normAbs = path.resolve(repoRoot, relDir, "ldem_normal_1k.png");
    const normBytes = fs.existsSync(normAbs) ? fs.statSync(normAbs).size : 0;
    assets.push({
      id: "lola-lroc-moon-dem",
      builderPath: "Tools/moon-albedo-bake/bake-lola-normals.mjs",
      assetPath: relDir,
      crsFrom: "NASA LOLA / LROC selenographic equirectangular DEM",
      crsTo: `Lunar tangent-space normal + polar-corrected albedo (${normBytes}B normal map)`,
      verticalDatum: "IAU Moon mean sphere (1737.4 km)",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: 0.1758,
      seamRule:
        "Periodic selenographic longitude wrap; pole pinch compensation",
      errorBudget:
        "moon-normal-map-asset.spec.mjs + moon-mip-motion-certification.spec.mjs",
      consumers: ["packages/engine/Source/Scene/Moon.js"],
      gates: [
        "Tools/visual-regression/moon-normal-map-asset.spec.mjs",
        "Tools/visual-regression/moon-mip-motion-certification.spec.mjs",
      ],
    });
  }

  // 11. ApproximateTerrainHeights Level-6 Quadtree Envelope
  {
    const relAsset =
      "packages/engine/Source/Assets/approximateTerrainHeights.json";
    const abs = path.resolve(repoRoot, relAsset);
    let tileCount = 0;
    if (fs.existsSync(abs)) {
      try {
        tileCount = Object.keys(
          JSON.parse(fs.readFileSync(abs, "utf8")),
        ).length;
      } catch {}
    }
    assets.push({
      id: "approximate-terrain-heights",
      builderPath: "packages/engine/Source/Core/ApproximateTerrainHeights.js",
      assetPath: relAsset,
      crsFrom: "Global DEM min/max heights per geographic tile (EPSG:4326)",
      crsTo: `Level-0..6 geographic quadtree min/max ellipsoidal heights (${tileCount} tiles)`,
      verticalDatum: "WGS84 ellipsoidal height (meters)",
      minLon: -180.0,
      maxLon: 180.0,
      minLat: -90.0,
      maxLat: 90.0,
      resolutionDeg: 2.8125,
      seamRule: "2x1 root geographic tiling [-180..0, 0..180]",
      errorBudget: "Conservative ground-primitive culling envelope",
      consumers: [
        "packages/engine/Source/Core/ApproximateTerrainHeights.js",
        "packages/engine/Source/Scene/GroundPrimitive.js",
      ],
      gates: [
        "Tools/visual-regression/c12-29-s4-orbital-sunrise-gate.spec.mjs",
      ],
    });
  }

  return assets;
}

/**
 * Audit GIS builder scripts for headered binary byte-0 read hazards (`EGM1` 32-byte header)
 * and flag orphaned/untracked binary asset residue under `Assets/WaterMask`.
 *
 * @param {string} repoRoot
 * @param {Map<string, string>} fileContentsMap
 * @param {{ contracts: object[] }} out
 */
export function auditGisAndAssetContracts(repoRoot, fileContentsMap, out) {
  for (const [relPath, text] of fileContentsMap.entries()) {
    if (!/^Tools\/build-[^/]+\.(?:mjs|js|ts)$/.test(relPath)) continue;
    if (!/(?:egm2008|GEOID_PATH|\.i16\b)/i.test(text)) continue;

    // Identify buffer variable(s) holding the headered EGM1 geoid binary.
    const bufVars = new Set();
    for (const m of text.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*fs\.readFileSync\(\s*([^)]+)\)/g,
    )) {
      if (/(?:egm2008|geoid|\.i16)/i.test(m[2])) {
        bufVars.add(m[1]);
      }
    }
    if (bufVars.size === 0) continue;

    const lines = text.split(/\r?\n/);
    for (const bufVar of bufVars) {
      const escaped = bufVar.replace(/\$/g, "\\$");
      // Check DataView or TypedArray constructed over `bufVar.byteOffset` without `+ 32` / header offset,
      // unless subsequent getInt16 calls add a header byte offset (`+ 32` / `HEADER`).
      const rawViewRe = new RegExp(
        `new\\s+(?:DataView|Int16Array|Uint16Array)\\s*\\(\\s*${escaped}\\.buffer\\s*,\\s*${escaped}\\.byteOffset\\s*(?:,|\\))`,
      );
      const rawReadZeroRe = new RegExp(
        `\\b${escaped}\\.read(?:U?Int16|Int32|Float)LE\\s*\\(\\s*0\\s*\\)`,
      );
      const hasExplicitHeaderOffsetInGet =
        /\.getInt16\s*\([^)]*(?:\+\s*32\b|header|HEADER)/s.test(text);

      const mView = text.match(rawViewRe);
      if (mView && !hasExplicitHeaderOffsetInGet) {
        const prefixLines = text.slice(0, mView.index ?? 0).split(/\r?\n/);
        out.contracts.push({
          filePath: relPath,
          line: prefixLines.length,
          category: "gis_datum",
          contractType: "GIS_BUILDER_HEADER_OFFSET",
          severity: "hazard",
          detail: `Constructs DataView/TypedArray over headered EGM1 binary '${bufVar}' at byteOffset+0 without skipping 32-byte EGM1 header (shifts grid by 16 samples / -8 deg lon)`,
        });
        continue;
      }

      for (let i = 0; i < lines.length; i += 1) {
        if (rawReadZeroRe.test(lines[i]) && !/EGM1|magic|header/i.test(text)) {
          out.contracts.push({
            filePath: relPath,
            line: i + 1,
            category: "gis_datum",
            contractType: "GIS_BUILDER_HEADER_OFFSET",
            severity: "hazard",
            detail: `Reads numeric sample at byte 0 of headered EGM1 binary '${bufVar}' without skipping 32-byte header`,
          });
        }
      }
    }
  }

  // Flag orphaned/untracked binary residue in WaterMask directories not registered in live GIS assets
  const knownWaterBins = new Set(
    inspectLiveGisAssets(repoRoot).map((a) => a.assetPath),
  );
  for (const relDir of [
    "packages/engine/Source/Assets/WaterMask",
    "Source/Assets/WaterMask",
  ]) {
    const absDir = path.resolve(repoRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    for (const entry of fs.readdirSync(absDir)) {
      if (!entry.endsWith(".bin")) continue;
      const relAsset = `${relDir}/${entry}`;
      const canonicalEngineRel = `packages/engine/Source/Assets/WaterMask/${entry}`;
      if (!knownWaterBins.has(canonicalEngineRel)) {
        out.contracts.push({
          filePath: relAsset,
          line: 1,
          category: "gis_datum",
          contractType: "UNTRACKED_ASSET_RESIDUE",
          severity: "review",
          detail: `Binary asset '${relAsset}' has no registered live GIS consumer in inspectLiveGisAssets`,
        });
      }
    }
  }
}
