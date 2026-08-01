/**
 * lunar-landmarks.mjs — shared, dependency-free alignment checker for the
 * bundled lunar albedo equirectangular (C12-24).
 *
 * WHY THIS EXISTS
 * ---------------
 * A texture swap can be silently wrong in four ways that all still "render a
 * moon": longitude shifted by 180 deg (nearside map painted on the farside),
 * longitude mirrored (east/west swapped), latitude mirrored (north/south
 * swapped), or any combination. None of those produce a crash, a missing
 * texture, or an obviously broken frame — they produce a plausible-looking
 * grey ball with the wrong features on it. So the alignment is pinned here
 * COMPUTATIONALLY, against named lunar surface features whose relative
 * albedo is a physical fact, and asserted by
 * `Tools/visual-regression/moon-albedo-asset.spec.mjs`.
 *
 * THE CONVENTION BEING PINNED
 * ---------------------------
 * The engine samples the moon through `czm_ellipsoidTextureCoordinates`
 * (GLSL) / `ellipsoidTexCoords` (WGSL), both of which are:
 *
 *     u = atan2(n.y, n.x) / (2*PI) + 0.5
 *     v = asin(n.z) / PI + 0.5
 *
 * evaluated on the surface normal in the Moon's IAU body-fixed frame, where
 * +X points at 0 deg longitude, +Y at 90 deg EAST, and +Z at the north pole.
 * Therefore:
 *
 *     u = 0.5  <->  longitude   0 deg   (u = 0 and u = 1 are both 180 deg)
 *     u grows with EAST longitude
 *     v = 1.0  <->  latitude  +90 deg   (north pole)
 *
 * so the stored image must be an equirectangular (plate carree) map,
 * CENTERED ON 0 deg LONGITUDE, with EAST to the RIGHT and NORTH AT THE TOP
 * of the image file. "North at the top of the file" is the WebGL upload
 * convention (`Texture` defaults `flipY: true`, so image row 0 lands at
 * t = 1); the WebGPU moon upload passes `flipY: true` explicitly to match.
 *
 * Helper coordinates below are therefore in IMAGE space with row 0 = north,
 * column 0 = 180 deg WEST.
 *
 * Longitudes are IAU planetographic, EAST-positive.
 */

/**
 * Named lunar features with published centres. Radii are in degrees of arc
 * and are deliberately conservative — well inside each feature — so the
 * measurement is insensitive to the exact resampling used to reach 2K.
 */
export const LANDMARKS = Object.freeze({
  // --- Nearside maria (dark basalt, geometric albedo ~0.07) ---
  mareCrisium: { lon: 59.1, lat: 17.0, radius: 4.5, kind: "mare" },
  mareSerenitatis: { lon: 17.5, lat: 28.0, radius: 5.0, kind: "mare" },
  mareTranquillitatis: { lon: 30.4, lat: 8.5, radius: 5.0, kind: "mare" },
  mareImbrium: { lon: -16.0, lat: 33.0, radius: 6.0, kind: "mare" },
  oceanusProcellarum: { lon: -57.4, lat: 18.4, radius: 6.0, kind: "mare" },

  // --- Fresh rayed craters (bright ejecta, albedo ~0.15-0.20) ---
  tycho: { lon: -11.4, lat: -43.3, radius: 2.0, kind: "brightCrater" },
  copernicus: { lon: -20.1, lat: 9.6, radius: 1.6, kind: "brightCrater" },

  // --- Farside highlands (anorthositic crust, bright) ---
  farsideHighlands: { lon: 157.0, lat: -4.0, radius: 8.0, kind: "highland" },
});

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon) {
  let l = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (l === 180) l = -180;
  return l;
}

/** Equirect column for an east-positive longitude (0 deg at image centre). */
export function lonToCol(lon, width) {
  return ((wrapLon(lon) + 180) / 360) * width;
}

/** Equirect row for a latitude (row 0 = +90 deg, north at top of file). */
export function latToRow(lat, height) {
  return ((90 - lat) / 180) * height;
}

/**
 * Mean relative luminance over a spherical cap of `radiusDeg` centred on
 * (lon, lat). The longitude extent is widened by 1/cos(lat) so the sampled
 * region is round ON THE SPHERE rather than round in the distorted image.
 *
 * `pixels` is tightly packed 8-bit with `channels` components per texel
 * (RGB or RGBA); alpha is ignored.
 */
export function sampleCap(
  pixels,
  width,
  height,
  channels,
  lon,
  lat,
  radiusDeg,
) {
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const lonHalf = radiusDeg / cosLat;
  const rowC = latToRow(lat, height);
  const r0 = Math.max(0, Math.floor(latToRow(lat + radiusDeg, height)));
  const r1 = Math.min(height - 1, Math.ceil(latToRow(lat - radiusDeg, height)));
  const colHalfPx = (lonHalf / 360) * width;
  const colC = lonToCol(lon, width);

  let sum = 0;
  let n = 0;
  for (let row = r0; row <= r1; row++) {
    const dLatDeg = ((rowC - row) / height) * 180;
    for (let d = -Math.ceil(colHalfPx); d <= Math.ceil(colHalfPx); d++) {
      const dLonDeg = (d / width) * 360 * cosLat;
      // Elliptical (great-circle-approximate) cap test.
      if (dLatDeg * dLatDeg + dLonDeg * dLonDeg > radiusDeg * radiusDeg)
        continue;
      let col = Math.round(colC + d) % width;
      if (col < 0) col += width;
      const i = (row * width + col) * channels;
      sum +=
        0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/**
 * Mean luminance of an annulus around (lon, lat) — used to measure a
 * feature's LOCAL contrast against whatever surrounds it. This is the test
 * that separates "compact dark oval ringed by bright highlands" (Mare
 * Crisium, at +59 deg E) from "interior of a broad dark plain" (Oceanus
 * Procellarum, at its longitude mirror). A pure point sample cannot tell
 * those apart; the ring can.
 */
export function sampleRing(
  pixels,
  width,
  height,
  channels,
  lon,
  lat,
  rInner,
  rOuter,
) {
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const rowC = latToRow(lat, height);
  const r0 = Math.max(0, Math.floor(latToRow(lat + rOuter, height)));
  const r1 = Math.min(height - 1, Math.ceil(latToRow(lat - rOuter, height)));
  const colHalfPx = (rOuter / cosLat / 360) * width;
  const colC = lonToCol(lon, width);

  let sum = 0;
  let n = 0;
  for (let row = r0; row <= r1; row++) {
    const dLatDeg = ((rowC - row) / height) * 180;
    for (let d = -Math.ceil(colHalfPx); d <= Math.ceil(colHalfPx); d++) {
      const dLonDeg = (d / width) * 360 * cosLat;
      const rr = Math.hypot(dLatDeg, dLonDeg);
      if (rr < rInner || rr > rOuter) continue;
      let col = Math.round(colC + d) % width;
      if (col < 0) col += width;
      const i = (row * width + col) * channels;
      sum +=
        0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/** Mean luminance over a longitude band, |lat| <= latLimit. */
export function sampleLonBand(
  pixels,
  width,
  height,
  channels,
  lonLo,
  lonHi,
  latLimit,
) {
  const r0 = Math.max(0, Math.floor(latToRow(latLimit, height)));
  const r1 = Math.min(height - 1, Math.ceil(latToRow(-latLimit, height)));
  let sum = 0;
  let n = 0;
  for (let row = r0; row <= r1; row++) {
    for (let col = 0; col < width; col++) {
      const lon = ((col + 0.5) / width) * 360 - 180;
      const a = Math.abs(lon);
      if (a < lonLo || a > lonHi) continue;
      const i = (row * width + col) * channels;
      sum +=
        0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/**
 * Run every alignment check against a decoded equirectangular albedo map.
 *
 * Returns `{ ok, checks: [{ name, pass, value, threshold, detail }] }`.
 * Each check is written so that ONE specific mis-orientation flips it:
 *
 *   nearsideDarkerThanFarside  -> fails on a 180 deg longitude shift
 *   crisiumRingContrast        -> fails on a longitude (east/west) mirror
 *   tychoBrighterThanMirror    -> fails on a latitude (north/south) mirror
 *   copernicusLocalContrast    -> fails on gross longitude drift near 20W
 *   mariaDarkerThanHighlands   -> fails on any of the above (global sanity)
 */
export function runAlignmentChecks(pixels, width, height, channels) {
  const cap = (lon, lat, r) =>
    sampleCap(pixels, width, height, channels, lon, lat, r);
  const ring = (lon, lat, ri, ro) =>
    sampleRing(pixels, width, height, channels, lon, lat, ri, ro);
  const band = (lo, hi, lim) =>
    sampleLonBand(pixels, width, height, channels, lo, hi, lim);

  const checks = [];
  const add = (name, pass, value, threshold, detail) =>
    checks.push({ name, pass, value: round(value), threshold, detail });

  // 1) 180 deg PHASE. The nearside carries almost every mare; the farside is
  //    nearly all highland crust. Nearside must be measurably darker.
  const nearside = band(0, 60, 50);
  const farside = band(120, 180, 50);
  add(
    "nearsideDarkerThanFarside",
    farside - nearside >= 12,
    farside - nearside,
    ">= 12",
    `nearside(|lon|<=60) mean ${round(nearside)} vs farside(|lon|>=120) mean ${round(farside)}`,
  );

  // 2) EAST/WEST MIRROR. Mare Crisium is a compact dark oval completely
  //    ringed by bright highlands near the EAST limb. Its longitude mirror
  //    (-59 deg) lands inside Oceanus Procellarum — dark, but NOT ringed by
  //    highlands. So the ring-minus-centre contrast is strongly positive at
  //    +59 and much weaker at -59.
  const crisium = cap(
    LANDMARKS.mareCrisium.lon,
    LANDMARKS.mareCrisium.lat,
    4.5,
  );
  const crisiumRing = ring(
    LANDMARKS.mareCrisium.lon,
    LANDMARKS.mareCrisium.lat,
    9,
    13,
  );
  const mirrorLon = -LANDMARKS.mareCrisium.lon;
  const mirror = cap(mirrorLon, LANDMARKS.mareCrisium.lat, 4.5);
  const mirrorRing = ring(mirrorLon, LANDMARKS.mareCrisium.lat, 9, 13);
  const crisiumContrast = crisiumRing - crisium;
  const mirrorContrast = mirrorRing - mirror;
  add(
    "crisiumRingContrast",
    crisiumContrast >= 25 && crisiumContrast - mirrorContrast >= 15,
    crisiumContrast,
    ">= 25 and >= mirror+15",
    `Crisium(+59E) ring-centre ${round(crisiumContrast)} vs mirror(-59E) ${round(mirrorContrast)}`,
  );

  // 3) NORTH/SOUTH MIRROR. Tycho is the brightest large feature of the
  //    southern highlands. Reflected across the equator (-11W, +43N) it
  //    lands in Mare Imbrium — one of the darkest places on the nearside.
  const tycho = cap(LANDMARKS.tycho.lon, LANDMARKS.tycho.lat, 2.0);
  const tychoMirror = cap(LANDMARKS.tycho.lon, -LANDMARKS.tycho.lat, 2.0);
  add(
    "tychoBrighterThanMirror",
    tycho - tychoMirror >= 40,
    tycho - tychoMirror,
    ">= 40",
    `Tycho(-11E,-43) ${round(tycho)} vs N/S mirror(-11E,+43) ${round(tychoMirror)}`,
  );

  // 4) Copernicus — bright rayed crater sitting in dark mare. Local
  //    contrast against its own surroundings, independent of the global
  //    exposure of the map.
  const copernicus = cap(
    LANDMARKS.copernicus.lon,
    LANDMARKS.copernicus.lat,
    1.6,
  );
  const copernicusRing = ring(
    LANDMARKS.copernicus.lon,
    LANDMARKS.copernicus.lat,
    6,
    10,
  );
  add(
    "copernicusLocalContrast",
    copernicus - copernicusRing >= 15,
    copernicus - copernicusRing,
    ">= 15",
    `Copernicus ${round(copernicus)} vs surround ${round(copernicusRing)}`,
  );

  // 5) Global sanity — every named mare must be darker than every named
  //    bright feature. Catches scrambles the directional tests miss.
  const mariaNames = Object.keys(LANDMARKS).filter(
    (k) => LANDMARKS[k].kind === "mare",
  );
  const brightNames = Object.keys(LANDMARKS).filter(
    (k) => LANDMARKS[k].kind !== "mare",
  );
  const mariaMax = Math.max(
    ...mariaNames.map((k) =>
      cap(LANDMARKS[k].lon, LANDMARKS[k].lat, LANDMARKS[k].radius),
    ),
  );
  const brightMin = Math.min(
    ...brightNames.map((k) =>
      cap(LANDMARKS[k].lon, LANDMARKS[k].lat, LANDMARKS[k].radius),
    ),
  );
  add(
    "mariaDarkerThanHighlands",
    brightMin - mariaMax >= 10,
    brightMin - mariaMax,
    ">= 10",
    `darkest bright feature ${round(brightMin)} vs brightest mare ${round(mariaMax)}`,
  );

  return { ok: checks.every((c) => c.pass), checks };
}

/** Per-landmark luminances, for the checked-in manifest. */
export function measureLandmarks(pixels, width, height, channels) {
  const out = {};
  for (const [name, m] of Object.entries(LANDMARKS)) {
    out[name] = round(
      sampleCap(pixels, width, height, channels, m.lon, m.lat, m.radius),
    );
  }
  return out;
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}
