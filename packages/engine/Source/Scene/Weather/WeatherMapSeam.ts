/**
 * Dateline- and pole-safe sampling machinery for the global equirectangular
 * weather map behind the `weatherTex` seam.
 *
 * This module owns one thing: the texel to lon/lat convention shared by every
 * producer of the weather texture and by the WGSL that samples it, plus the two
 * bounded corrections that convention needs in order to be artifact-free:
 *
 *   1. **Antimeridian.** The texture is sampled with `addressModeU: "repeat"`,
 *      so texel `texW-1` and texel `0` are filtered together across
 *      lon = +-180 deg. A repeating sampler cannot make non-periodic source data
 *      seam-free, so any procedural producer has to be exactly periodic in
 *      longitude. {@link periodicFbm2D} is the seam-safe value-noise fBM that
 *      guarantees it, by wrapping the integer noise lattice modulo each octave's
 *      period.
 *   2. **Poles.** An equirectangular grid keeps `texW` distinct longitude
 *      samples at every latitude while the ground circumference collapses as
 *      `cos(lat)`. At the pole all of those samples occupy one point, so the
 *      value read there depends on the azimuth of approach: a pinwheel, and a
 *      genuine discontinuity at the pole itself.
 *      {@link applyEquirectPolarLowPass} removes it by low-passing each row in
 *      longitude with a wrap-aware box whose width tracks `1 / cos(lat)`. The
 *      filter is exactly the identity below ~59 deg, leaving mid-latitude
 *      content byte-for-byte unchanged, and degenerates to the row mean in the
 *      two polar-cap rows, which makes the pole single-valued under the shader's
 *      `addressModeV: "clamp-to-edge"`.
 *
 * This covers the current global map. It does not introduce a globe-quadtree
 * weather tile schema with gutters, per-tile bounds and no-data, an atlas or
 * LOD, and must not be presented as a substitute for one.
 *
 * The field-grid convention is the one {@link WeatherField} declares: row 0 is
 * the north edge and column 0 is the west edge, a node-centred grid whose first
 * and last columns are on one meridian for a global field. Under that convention
 * a wrap-aware bilinear fetch is unreachable, because the resample coordinate
 * never leaves `[0, gridWidth-1]`, so none is added here.
 *
 * {@link WeatherFieldGrid} makes that convention explicit and per-field, and is
 * the single home for the source-grid coordinate reference, regional-bounds
 * placement and no-data semantics. It adds the wrap-aware fetch for the one case
 * that does reach it, a cell-registered full-circle field; the statement above
 * holds for the node-registered default.
 *
 * @module Scene/Weather/WeatherMapSeam
 */

/** Weather-texture longitude origin, RADIANS. Mirrors `cloud.weatherTexBounds.x`. */
export const WEATHER_MAP_MIN_LON = -Math.PI;
/** Weather-texture latitude origin, RADIANS. Mirrors `cloud.weatherTexBounds.y`. */
export const WEATHER_MAP_MIN_LAT = -Math.PI / 2;
/** Weather-texture longitude span, RADIANS. Mirrors `cloud.weatherTexBounds.z`. */
export const WEATHER_MAP_LON_RANGE = 2 * Math.PI;
/** Weather-texture latitude span, RADIANS. Mirrors `cloud.weatherTexBounds.w`. */
export const WEATHER_MAP_LAT_RANGE = Math.PI;

/**
 * The CPU twin of `worldToWeatherUV` in `ProceduralClouds.wgsl`: geodetic-ish
 * lon/lat (radians) to weather-map UV. `v` is flipped so row 0 is the north pole.
 * Kept expression-for-expression identical to the WGSL so the two cannot drift;
 * `Tools/visual-regression/weather-map-seam.spec.mjs` pins both.
 */
export function weatherUVFromLonLat(
  lon: number,
  lat: number,
): [number, number] {
  const u = (lon - WEATHER_MAP_MIN_LON) / WEATHER_MAP_LON_RANGE;
  const v = 1.0 - (lat - WEATHER_MAP_MIN_LAT) / WEATHER_MAP_LAT_RANGE;
  return [u, v];
}

/**
 * Inverse of {@link weatherUVFromLonLat} evaluated at the CENTRE of texel
 * `(tx, ty)` — the longitude/latitude a producer must write into that texel so
 * the GPU's linear filter reconstructs the field at the right place.
 *
 * Texel centres (not edges) are the contract because that is where a `linear`
 * sampler places the stored value. Getting this wrong is what turns the wrap
 * blend at +-180 deg into a smear between the wrong two longitudes.
 *
 * @returns `[lon, lat]` in RADIANS.
 */
export function weatherTexelCenterLonLat(
  tx: number,
  ty: number,
  texW: number,
  texH: number,
): [number, number] {
  const u = (tx + 0.5) / texW;
  const v = (ty + 0.5) / texH;
  const lon = WEATHER_MAP_MIN_LON + u * WEATHER_MAP_LON_RANGE;
  const lat = WEATHER_MAP_MIN_LAT + (1.0 - v) * WEATHER_MAP_LAT_RANGE;
  return [lon, lat];
}

/** Positive integer modulo (JS `%` keeps the sign of the dividend). */
function wrapIndex(i: number, period: number): number {
  return ((i % period) + period) % period;
}

/**
 * The hash the historical procedural weather map used. Preserved verbatim so the
 * seam repair changes WHERE the lattice wraps, not what the map looks like.
 */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Value noise that is EXACTLY periodic in `x` with lattice period `periodX`
 * (`y` is intentionally NOT periodic — latitude does not wrap). Periodicity comes
 * from wrapping the integer lattice index before hashing, so the cell straddling
 * `x = periodX` interpolates hash(periodX-1) -> hash(0), which is the same pair
 * the cell at `x = 0` sees from the other side.
 */
export function periodicValueNoise2D(
  x: number,
  y: number,
  periodX: number,
): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = wrapIndex(ix, periodX);
  const x1 = wrapIndex(ix + 1, periodX);
  const a = hash2(x0, iy);
  const b = hash2(x1, iy);
  const c = hash2(x0, iy + 1);
  const d = hash2(x1, iy + 1);
  return (
    a * (1 - ux) * (1 - uy) +
    b * ux * (1 - uy) +
    c * (1 - ux) * uy +
    d * ux * uy
  );
}

/**
 * Seam-safe fBM. `x` must already be scaled so one longitude wrap spans
 * `periodX` lattice cells (i.e. `x = u * periodX` with `u` in `[0,1)`); octave
 * `i` then wraps at `periodX * 2^i`, which is an integer whenever `periodX` is,
 * so every octave is individually periodic and so is their sum.
 *
 * @param periodX Base-octave lattice period. MUST be a positive integer.
 */
export function periodicFbm2D(
  x: number,
  y: number,
  periodX: number,
  octaves: number = 5,
): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * periodicValueNoise2D(x * f, y * f, periodX * f);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

/**
 * Longitudinal box-filter width, in TEXELS, for equirectangular row `ty`.
 *
 * The width tracks `1 / cos(lat)` so the filtered longitudinal resolution never
 * exceeds the equatorial one — the standard equirectangular pole filter. Widths
 * are forced ODD so the kernel is symmetric (no half-texel shift), which makes
 * the result `1` (exact identity) for every row below ~59 deg. `lat` is taken at
 * the row's HIGHEST-|latitude| EDGE, not its centre, so the two polar-cap rows —
 * whose edge is the pole itself — return `texW` and collapse to the row mean.
 * That is what makes the pole single-valued.
 */
export function polarLowPassWidth(
  ty: number,
  texH: number,
  texW: number,
): number {
  const dLat = WEATHER_MAP_LAT_RANGE / texH;
  const latTop = WEATHER_MAP_MIN_LAT + WEATHER_MAP_LAT_RANGE - ty * dLat;
  const latBottom = latTop - dLat;
  const edgeLat = Math.max(Math.abs(latTop), Math.abs(latBottom));
  const cosLat = Math.cos(edgeLat);
  if (!(cosLat > 1e-6)) {
    return texW;
  }
  const scale = 1 / cosLat;
  if (!(scale < texW)) {
    return texW;
  }
  const odd = 2 * Math.round((scale - 1) / 2) + 1;
  return Math.min(texW, Math.max(1, odd));
}

/**
 * Pole-safe + wrap-aware low-pass of a packed rgba8 equirectangular weather map,
 * IN PLACE. All four channels are filtered: R (coverage), B (base) and A
 * (density bias) are continuous fields, and G is decoded by the shader as a
 * continuous SHAPE bias (`decodeWeatherChannels`), not as a hard genus index, so
 * averaging it is well defined.
 *
 * The filter is circular in longitude, so it can neither create nor widen an
 * antimeridian seam, and it is an exact no-op wherever
 * {@link polarLowPassWidth} returns 1 — mid-latitude bytes are unchanged.
 *
 * @param rgba `texW * texH * 4` bytes, row 0 = north.
 * @returns the same array, filtered in place.
 */
export function applyEquirectPolarLowPass(
  rgba: Uint8Array,
  texW: number,
  texH: number,
): Uint8Array {
  if (texW < 2) {
    return rgba;
  }
  // One reused prefix-sum scratch keeps the filter O(texW) per row+channel
  // regardless of kernel width (the polar rows want the whole row). It also
  // snapshots the PRE-filter values, so writing the result back in place cannot
  // feed filtered samples into later windows of the same row.
  const prefix = new Float64Array(texW + 1);
  for (let ty = 0; ty < texH; ty++) {
    const width = polarLowPassWidth(ty, texH, texW);
    if (width <= 1) {
      continue;
    }
    const rowStart = ty * texW * 4;
    for (let channel = 0; channel < 4; channel++) {
      let total = 0;
      prefix[0] = 0;
      for (let tx = 0; tx < texW; tx++) {
        total += rgba[rowStart + tx * 4 + channel];
        prefix[tx + 1] = total;
      }
      if (width >= texW) {
        // Polar cap: one value for the whole row -> the pole is single-valued.
        const mean = Math.round(total / texW);
        for (let tx = 0; tx < texW; tx++) {
          rgba[rowStart + tx * 4 + channel] = mean;
        }
        continue;
      }
      const radius = (width - 1) / 2;
      for (let tx = 0; tx < texW; tx++) {
        const lo = tx - radius;
        const hi = tx + radius;
        let sum: number;
        if (lo < 0) {
          sum = total - prefix[lo + texW] + prefix[hi + 1];
        } else if (hi >= texW) {
          sum = total - prefix[lo] + prefix[hi + 1 - texW];
        } else {
          sum = prefix[hi + 1] - prefix[lo];
        }
        const mean = Math.round(sum / width);
        rgba[rowStart + tx * 4 + channel] =
          mean < 0 ? 0 : mean > 255 ? 255 : mean;
      }
    }
  }
  return rgba;
}
