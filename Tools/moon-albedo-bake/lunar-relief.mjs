/**
 * lunar-relief.mjs — shared, dependency-free derivation and verification of
 * the bundled lunar tangent-space NORMAL map (C12-25).
 * @purpose Dependency-free derivation + verification of the lunar tangent-space normal map (east-north-up frame), shared by bake and asset spec.
 * @status ACTIVE
 *
 * WHY THIS EXISTS
 * ---------------
 * NASA ships DISPLACEMENT (the LOLA `ldem_*` height field), not normals, so
 * the normal map is an offline derivation rather than a repackage. A
 * derivation can be silently wrong in ways that still render a plausible
 * moon — a mirrored green channel lights every crater from the wrong side,
 * a mirrored red channel does the same east/west, and a swapped pair rotates
 * the whole relief 90 degrees. None of those crash or look obviously broken
 * at full phase; they are only visible near the terminator, which is
 * precisely where the feature is supposed to earn its keep.
 *
 * So the derivation lives here next to the checks that prove it, exactly as
 * `lunar-landmarks.mjs` does for the albedo's orientation. The checks are
 * asserted by `Tools/visual-regression/moon-normal-map-asset.spec.mjs` and
 * re-run by the bake against the ENCODED bytes before anything installs.
 *
 * THE TANGENT FRAME BEING PINNED
 * ------------------------------
 * The stored normal is tangent-space in a GEOGRAPHIC east-north-up frame at
 * the sampled point:
 *
 *     x  ->  EAST      y  ->  NORTH      z  ->  UP (the geodetic normal)
 *
 * which is exactly the basis `czm_eastNorthUpToEyeCoordinates` builds on the
 * WebGL side (column 0 = east, column 1 = north, column 2 = up) and the basis
 * `Moon.wgsl` rebuilds inline in model space. Encoding is the conventional
 * `stored = n * 0.5 + 0.5`, so a flat surface is (128, 128, 255)-ish and the
 * blue channel is always >= 0.5.
 *
 * Because the frame is GEOGRAPHIC and not image-space, there is no "OpenGL vs
 * DirectX green channel" ambiguity to inherit: +G means the surface tilts
 * toward the lunar north pole, full stop. The image's own row order is
 * reconciled at the upload layer by the same `flipY: true` convention C12-24
 * established for the albedo, and the two maps therefore register texel for
 * texel.
 *
 * THE DERIVATION
 * --------------
 * Heights `h(lon, lat)` sit on a sphere of radius R. Ground distance per
 * texel on an equirectangular grid of W x H covering 360 x 180 degrees:
 *
 *     dNorth = R * (PI / H)                  (constant)
 *     dEast  = R * cos(lat) * (2*PI / W)     (shrinks toward the poles)
 *
 * Central differences give the slopes, and the unnormalized normal is
 *
 *     n = ( -dh/dEast, -dh/dNorth, 1 )
 *
 * The `1 / cos(lat)` in the east step is the whole polar problem: at the top
 * row of a 512-row map `cos(lat)` is 0.0031, so a one-texel east difference
 * is divided by ~33 metres of ground and any noise explodes into a vertical
 * cliff. Rather than clamping the divisor (which fakes the geometry), the
 * east STENCIL widens with latitude — `k = round(1 / cos(lat))` texels — so
 * the east baseline stays ~`R * 2*PI/W` metres of GROUND everywhere, matching
 * the north baseline. With W = 2H the two are equal at the equator, so the
 * derivative stencil is isotropic on the sphere at every latitude. That is
 * the same "sample a constant ground distance, not a constant texel count"
 * convention the weather-map seam handling uses.
 *
 * Rows past the poles wrap ACROSS the pole rather than clamping: the
 * neighbour north of `(x, 0)` is `(x + W/2, 0)`, which is genuinely one
 * latitude step away over the top of the sphere. Clamping instead would
 * halve the baseline and manufacture a ring of false slope around both poles.
 */

/**
 * Radius of the sphere the LOLA LDEM products are referenced to, in metres.
 * SVS documents the float32 `ldem_*.tif` members as kilometres relative to a
 * 1737.4 km sphere.
 */
export const LUNAR_RADIUS_M = 1737400;

/**
 * Named craters used as relief discriminators, with published centres and
 * rim radii. These are BOWLS: the floor is low, the rim is high, so on the
 * inner wall the surface normal tilts INWARD, toward the centre. That single
 * physical fact is what the checks below test, and it is independently
 * signed in east/west and in north/south — so a mirrored red channel and a
 * mirrored green channel each fail their own named check.
 *
 * `radiusDeg` is the rim radius in degrees of arc (1 deg ~ 30.32 km on the
 * Moon). Tycho is 85 km across, Copernicus 93 km.
 */
export const CRATERS = Object.freeze({
  tycho: { lon: -11.4, lat: -43.3, radiusDeg: 1.4, depthKm: 4.8 },
  copernicus: { lon: -20.1, lat: 9.6, radiusDeg: 1.53, depthKm: 3.8 },
});

/**
 * Fraction of the rim radius that bounds the sampled inner-wall annulus.
 * The floor (inside `INNER`) is flat and the ejecta blanket (outside `OUTER`)
 * is not reliably signed, so both are excluded.
 */
export const WALL_INNER_FRACTION = 0.35;
export const WALL_OUTER_FRACTION = 1.0;

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon) {
  let l = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (l === 180) l = -180;
  return l;
}

/** Latitude at the CENTRE of equirect row `row`, in degrees (row 0 = north). */
export function rowToLat(row, height) {
  return 90 - ((row + 0.5) / height) * 180;
}

/** Longitude at the CENTRE of equirect column `col`, in degrees. */
export function colToLon(col, width) {
  return ((col + 0.5) / width) * 360 - 180;
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
 * Exact area-weighted downsample of an equirectangular scalar field.
 *
 * Every output texel is the mean of the source texels its footprint covers,
 * weighted by the covered fraction — i.e. the mean elevation of the ground
 * the output texel represents. For a height field that is the physically
 * meaningful low-pass: it is the only filter that cannot ring, and ringing
 * matters more here than anywhere else because the very next step
 * DIFFERENTIATES the result. (A Lanczos downsample would put over/undershoot
 * next to every crater rim, and differentiation would turn each into a false
 * slope reversal.)
 *
 * Downsampling BEFORE differentiating — rather than differentiating at source
 * resolution and averaging the slopes — is deliberate: it makes the shipped
 * normals the exact normals of the shipped-resolution surface, so the
 * derivation has one defensible answer instead of a filter-order argument.
 *
 * @param {Float64Array|Float32Array} src Source field, row-major, `sw * sh`.
 * @returns {Float64Array} `dw * dh` output field.
 */
export function areaDownsample(src, sw, sh, dw, dh) {
  const out = new Float64Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let oy = 0; oy < dh; oy++) {
    const y0 = oy * sy;
    const y1 = y0 + sy;
    const r0 = Math.floor(y0);
    const r1 = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let ox = 0; ox < dw; ox++) {
      const x0 = ox * sx;
      const x1 = x0 + sx;
      const c0 = Math.floor(x0);
      const c1 = Math.min(sw - 1, Math.ceil(x1) - 1);
      let sum = 0;
      let wsum = 0;
      for (let r = r0; r <= r1; r++) {
        const wy = Math.min(r + 1, y1) - Math.max(r, y0);
        if (wy <= 0) continue;
        const rowBase = r * sw;
        for (let c = c0; c <= c1; c++) {
          const wx = Math.min(c + 1, x1) - Math.max(c, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += src[rowBase + c] * w;
          wsum += w;
        }
      }
      out[oy * dw + ox] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return out;
}

/**
 * Height sample with the sphere's own topology: longitude wraps, and a row
 * index past either pole reflects ACROSS the pole to the antipodal longitude
 * on the same row — which is exactly one latitude step away over the top.
 */
function sampleHeight(h, W, H, col, row) {
  let c = col % W;
  if (c < 0) c += W;
  let r = row;
  if (r < 0) {
    r = -r - 1;
    c = (c + (W >> 1)) % W;
  } else if (r >= H) {
    r = 2 * H - r - 1;
    c = (c + (W >> 1)) % W;
  }
  if (r < 0) r = 0;
  if (r >= H) r = H - 1;
  return h[r * W + c];
}

/**
 * Derive tangent-space (east, north, up) normals from an equirectangular
 * height field.
 *
 * @param {Float64Array|Float32Array} heights Heights in METRES above the
 *        reference sphere, row-major `W * H`, row 0 = north.
 * @param {number} W
 * @param {number} H
 * @param {number} [radiusM] Reference-sphere radius in metres.
 * @returns {{nx: Float32Array, ny: Float32Array, nz: Float32Array, stats: object}}
 */
export function heightsToNormals(heights, W, H, radiusM = LUNAR_RADIUS_M) {
  const nx = new Float32Array(W * H);
  const ny = new Float32Array(W * H);
  const nz = new Float32Array(W * H);

  // North step is latitude-independent: R * (PI / H) metres per texel.
  const dNorth = radiusM * (Math.PI / H);
  // East step at the equator: R * (2*PI / W). With W = 2H this equals dNorth.
  const dEastEquator = radiusM * ((2 * Math.PI) / W);
  // Widest east stencil allowed. At the top row 1/cos(lat) is ~652 for
  // H = 1024; capping at W/4 keeps the stencil a proper local difference
  // (it never wraps onto itself) while still holding the ground baseline
  // within ~25% of the equatorial one at the very last row.
  const kMax = Math.max(1, Math.floor(W / 4));

  let maxSlope = 0;
  let sumSlope = 0;
  const slopes = new Float64Array(W * H);

  for (let row = 0; row < H; row++) {
    const lat = (rowToLat(row, H) * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    // Isotropic-on-the-ground east stencil: k texels of longitude span
    // k * dEastEquator * cos(lat) metres, so k ~ 1/cos(lat) holds that at
    // dEastEquator regardless of latitude.
    const k = Math.min(
      kMax,
      Math.max(1, Math.round(1 / Math.max(cosLat, 1e-9))),
    );
    const dEast = dEastEquator * cosLat * k;

    for (let col = 0; col < W; col++) {
      const i = row * W + col;

      const hE = sampleHeight(heights, W, H, col + k, row);
      const hW = sampleHeight(heights, W, H, col - k, row);
      const hN = sampleHeight(heights, W, H, col, row - 1);
      const hS = sampleHeight(heights, W, H, col, row + 1);

      // d(h)/d(east) and d(h)/d(north). Row index grows SOUTHWARD, so the
      // north derivative is (north sample - south sample).
      const dhdE = (hE - hW) / (2 * dEast);
      const dhdN = (hN - hS) / (2 * dNorth);

      const vx = -dhdE;
      const vy = -dhdN;
      const inv = 1 / Math.sqrt(vx * vx + vy * vy + 1);
      nx[i] = vx * inv;
      ny[i] = vy * inv;
      nz[i] = inv;

      const s = Math.sqrt(dhdE * dhdE + dhdN * dhdN);
      slopes[i] = s;
      sumSlope += s;
      if (s > maxSlope) maxSlope = s;
    }
  }

  const sorted = Float64Array.from(slopes).sort();
  const pct = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

  return {
    nx,
    ny,
    nz,
    stats: {
      meanSlope: round6(sumSlope / (W * H)),
      medianSlope: round6(pct(0.5)),
      p90Slope: round6(pct(0.9)),
      p99Slope: round6(pct(0.99)),
      maxSlope: round6(maxSlope),
      meanTiltDeg: round6((Math.atan(sumSlope / (W * H)) * 180) / Math.PI),
      p99TiltDeg: round6((Math.atan(pct(0.99)) * 180) / Math.PI),
      maxTiltDeg: round6((Math.atan(maxSlope) * 180) / Math.PI),
      dNorthMetersPerTexel: round6(dNorth),
      dEastEquatorMetersPerTexel: round6(dEastEquator),
    },
  };
}

/** Encode normals to tightly packed 8-bit RGB (`n * 0.5 + 0.5`). */
export function encodeNormalsRGB8(nx, ny, nz) {
  const n = nx.length;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3 + 0] = quant8(nx[i]);
    out[i * 3 + 1] = quant8(ny[i]);
    out[i * 3 + 2] = quant8(nz[i]);
  }
  return out;
}

/** Encode normals to tightly packed 16-bit RGB, big-endian (PNG order). */
export function encodeNormalsRGB16(nx, ny, nz) {
  const n = nx.length;
  const out = new Uint8Array(n * 6);
  for (let i = 0; i < n; i++) {
    write16(out, i * 6 + 0, quant16(nx[i]));
    write16(out, i * 6 + 2, quant16(ny[i]));
    write16(out, i * 6 + 4, quant16(nz[i]));
  }
  return out;
}

function write16(buf, off, v) {
  buf[off] = (v >> 8) & 0xff;
  buf[off + 1] = v & 0xff;
}

function quant8(v) {
  return Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
}

function quant16(v) {
  return Math.max(0, Math.min(65535, Math.round(v * 32767.5 + 32767.5)));
}

/**
 * Decode an 8-bit RGB(A) normal map back to unit-ish vectors. The spec runs
 * every check through this, on the ENCODED bytes, so quantization is inside
 * the measurement rather than outside it.
 */
export function decodeNormalsRGB8(pixels, width, height, channels) {
  const n = width * height;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * channels;
    nx[i] = (pixels[p] - 127.5) / 127.5;
    ny[i] = (pixels[p + 1] - 127.5) / 127.5;
    nz[i] = (pixels[p + 2] - 127.5) / 127.5;
  }
  return { nx, ny, nz };
}

/**
 * Mean of (nx, ny) over one angular sector of a crater's inner wall.
 *
 * `bearingDeg` is measured from NORTH, clockwise through EAST, and the
 * sector is `+/- halfWidthDeg` about it. Radii are fractions of the crater's
 * rim radius. Distances are computed in the LOCAL TANGENT PLANE (longitude
 * offsets scaled by cos(lat)) so the sector is a real quadrant on the ground
 * rather than a distorted wedge in image space.
 */
export function sampleWallSector(
  nx,
  ny,
  W,
  H,
  crater,
  bearingDeg,
  halfWidthDeg = 45,
) {
  const { lon, lat, radiusDeg } = crater;
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const rIn = radiusDeg * WALL_INNER_FRACTION;
  const rOut = radiusDeg * WALL_OUTER_FRACTION;

  const rowC = latToRow(lat, H);
  const colC = lonToCol(lon, W);
  const rowSpan = Math.ceil((rOut / 180) * H) + 2;
  const colSpan = Math.ceil((rOut / cosLat / 360) * W) + 2;

  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let dr = -rowSpan; dr <= rowSpan; dr++) {
    const row = Math.round(rowC + dr);
    if (row < 0 || row >= H) continue;
    // Degrees NORTH of the crater centre.
    const dLatDeg = ((rowC - row) / H) * 180;
    for (let dc = -colSpan; dc <= colSpan; dc++) {
      // Degrees EAST of the crater centre, on the ground.
      const dLonDeg = (dc / W) * 360 * cosLat;
      const r = Math.hypot(dLatDeg, dLonDeg);
      if (r < rIn || r > rOut) continue;
      // Bearing from north, clockwise through east.
      const bearing = (Math.atan2(dLonDeg, dLatDeg) * 180) / Math.PI;
      let delta = bearing - bearingDeg;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (Math.abs(delta) > halfWidthDeg) continue;
      let col = Math.round(colC + dc) % W;
      if (col < 0) col += W;
      const i = row * W + col;
      sx += nx[i];
      sy += ny[i];
      count++;
    }
  }
  return {
    meanNx: count ? sx / count : NaN,
    meanNy: count ? sy / count : NaN,
    count,
  };
}

/**
 * Mean Lambert shade over one sector, lit by a direction given in the SAME
 * tangent frame the map is stored in. This is the end-to-end form of the
 * check: it composes the stored normal exactly as the shaders do, so it
 * fails for any error that would show up as "the crater is lit from the
 * wrong side" — which is the only symptom a user would ever report.
 */
export function sampleWallShade(nx, ny, nz, W, H, crater, bearingDeg, light) {
  const { lon, lat, radiusDeg } = crater;
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const rIn = radiusDeg * WALL_INNER_FRACTION;
  const rOut = radiusDeg * WALL_OUTER_FRACTION;
  const rowC = latToRow(lat, H);
  const colC = lonToCol(lon, W);
  const rowSpan = Math.ceil((rOut / 180) * H) + 2;
  const colSpan = Math.ceil((rOut / cosLat / 360) * W) + 2;

  let sum = 0;
  let count = 0;
  for (let dr = -rowSpan; dr <= rowSpan; dr++) {
    const row = Math.round(rowC + dr);
    if (row < 0 || row >= H) continue;
    const dLatDeg = ((rowC - row) / H) * 180;
    for (let dc = -colSpan; dc <= colSpan; dc++) {
      const dLonDeg = (dc / W) * 360 * cosLat;
      const r = Math.hypot(dLatDeg, dLonDeg);
      if (r < rIn || r > rOut) continue;
      const bearing = (Math.atan2(dLonDeg, dLatDeg) * 180) / Math.PI;
      let delta = bearing - bearingDeg;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (Math.abs(delta) > 45) continue;
      let col = Math.round(colC + dc) % W;
      if (col < 0) col += W;
      const i = row * W + col;
      sum += Math.max(
        0,
        nx[i] * light[0] + ny[i] * light[1] + nz[i] * light[2],
      );
      count++;
    }
  }
  return count ? sum / count : NaN;
}

/**
 * Grazing test light in tangent space, `azimuthDeg` measured from north
 * clockwise through east, at `elevationDeg` above the local horizon. A LOW
 * elevation is the point: it is the terminator geometry, where the normal
 * map is supposed to be visible at all.
 */
export function tangentLight(azimuthDeg, elevationDeg = 10) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return [
    Math.cos(el) * Math.sin(az), // east
    Math.cos(el) * Math.cos(az), // north
    Math.sin(el), // up
  ];
}

/**
 * Run every relief check against decoded normals.
 *
 * Returns `{ ok, checks: [{ name, pass, value, threshold, detail }] }`.
 * Each check is written so that ONE specific derivation error flips it:
 *
 *   normalsAreUnitAndOutward   -> fails on a corrupt/zero/inward encode
 *   reliefIsPresent            -> fails on a flat (all-(128,128,255)) map
 *   craterEastWestPolarity     -> fails on a mirrored RED channel / lon flip
 *   craterNorthSouthPolarity   -> fails on a mirrored GREEN channel / lat flip
 *   craterLitFromTestAzimuth   -> fails on either, end-to-end through shading
 *   channelsAreNotSwapped      -> fails on an x/y transpose
 */
export function runReliefChecks(nx, ny, nz, W, H) {
  const checks = [];
  const add = (name, pass, value, threshold, detail) =>
    checks.push({ name, pass, value: round6(value), threshold, detail });

  // 1) The encode must be a plausible unit normal field with z > 0
  //    everywhere (a tangent-space normal can never point into the surface).
  let minZ = Infinity;
  let sumLenErr = 0;
  let maxLenErr = 0;
  for (let i = 0; i < nx.length; i++) {
    if (nz[i] < minZ) minZ = nz[i];
    const len = Math.sqrt(nx[i] * nx[i] + ny[i] * ny[i] + nz[i] * nz[i]);
    const e = Math.abs(len - 1);
    sumLenErr += e;
    if (e > maxLenErr) maxLenErr = e;
  }
  const meanLenErr = sumLenErr / nx.length;
  add(
    "normalsAreUnitAndOutward",
    minZ > 0 && meanLenErr < 0.01 && maxLenErr < 0.05,
    meanLenErr,
    "minZ > 0, mean |len-1| < 0.01, max < 0.05",
    `minZ ${round6(minZ)}, mean |len-1| ${round6(meanLenErr)}, max ${round6(maxLenErr)}`,
  );

  // 2) There must actually BE relief. A map that survived every polarity
  //    test by being uniformly flat is worthless, and this is the check
  //    that a broken height decode (all zeros) trips.
  let sumSq = 0;
  for (let i = 0; i < nx.length; i++) {
    sumSq += nx[i] * nx[i] + ny[i] * ny[i];
  }
  const rmsTangent = Math.sqrt(sumSq / nx.length);
  add(
    "reliefIsPresent",
    rmsTangent > 0.01,
    rmsTangent,
    "> 0.01",
    `RMS tangential component ${round6(rmsTangent)} (mean tilt ${round6((Math.asin(Math.min(1, rmsTangent)) * 180) / Math.PI)} deg)`,
  );

  // 3) EAST/WEST polarity. On a crater's inner wall the normal tilts INWARD.
  //    The wall EAST of the centre therefore faces WEST (nx < 0) and the
  //    wall WEST of the centre faces EAST (nx > 0). A mirrored red channel
  //    swaps them; so does an east/west mirror of the whole map.
  const ewParts = [];
  let ewMin = Infinity;
  for (const [name, crater] of Object.entries(CRATERS)) {
    const east = sampleWallSector(nx, ny, W, H, crater, 90);
    const west = sampleWallSector(nx, ny, W, H, crater, 270);
    const sep = west.meanNx - east.meanNx;
    ewParts.push(
      `${name}: W-wall nx ${round6(west.meanNx)} vs E-wall nx ${round6(east.meanNx)} (sep ${round6(sep)}, n=${west.count}/${east.count})`,
    );
    if (sep < ewMin) ewMin = sep;
  }
  add(
    "craterEastWestPolarity",
    ewMin >= EW_MIN_SEPARATION,
    ewMin,
    `>= ${EW_MIN_SEPARATION}`,
    ewParts.join("; "),
  );

  // 4) NORTH/SOUTH polarity. Same argument rotated 90 degrees: the wall
  //    NORTH of the centre faces SOUTH (ny < 0), the wall SOUTH of it faces
  //    NORTH (ny > 0). A mirrored GREEN channel is the classic normal-map
  //    error and this is the check written for it.
  const nsParts = [];
  let nsMin = Infinity;
  for (const [name, crater] of Object.entries(CRATERS)) {
    const north = sampleWallSector(nx, ny, W, H, crater, 0);
    const south = sampleWallSector(nx, ny, W, H, crater, 180);
    const sep = south.meanNy - north.meanNy;
    nsParts.push(
      `${name}: S-wall ny ${round6(south.meanNy)} vs N-wall ny ${round6(north.meanNy)} (sep ${round6(sep)}, n=${south.count}/${north.count})`,
    );
    if (sep < nsMin) nsMin = sep;
  }
  add(
    "craterNorthSouthPolarity",
    nsMin >= NS_MIN_SEPARATION,
    nsMin,
    `>= ${NS_MIN_SEPARATION}`,
    nsParts.join("; "),
  );

  // 5) END-TO-END ILLUMINATION. Compose the stored normals exactly as the
  //    shaders do — Lambert against a grazing light — and require that the
  //    wall facing the light is the brighter one, for lights from all four
  //    cardinal azimuths. This is the check that speaks the language of the
  //    bug: "the craters are lit from the wrong side".
  const illumParts = [];
  let illumMin = Infinity;
  for (const [name, crater] of Object.entries(CRATERS)) {
    for (const [azName, az, litBearing, darkBearing] of [
      // Light FROM the east illuminates the east-facing wall, which is the
      // wall on the WEST side of the crater.
      ["E", 90, 270, 90],
      ["W", 270, 90, 270],
      ["N", 0, 180, 0],
      ["S", 180, 0, 180],
    ]) {
      const L = tangentLight(az, TEST_LIGHT_ELEVATION_DEG);
      const lit = sampleWallShade(nx, ny, nz, W, H, crater, litBearing, L);
      const dark = sampleWallShade(nx, ny, nz, W, H, crater, darkBearing, L);
      const ratio = dark > 1e-6 ? lit / dark : Infinity;
      illumParts.push(`${name}/${azName} ${round6(lit)}:${round6(dark)}`);
      if (ratio < illumMin) illumMin = ratio;
    }
  }
  add(
    "craterLitFromTestAzimuth",
    illumMin >= ILLUM_MIN_RATIO,
    illumMin,
    `>= ${ILLUM_MIN_RATIO}`,
    `worst lit:unlit wall ratio at ${TEST_LIGHT_ELEVATION_DEG} deg elevation — ${illumParts.join(", ")}`,
  );

  // 6) X/Y SWAP. The polarity checks above are each blind to a pure
  //    transpose (it moves the signal into the other channel rather than
  //    inverting it), so pin that the east/west signal really does live in
  //    the RED channel: the crater's east-west wall pair must separate more
  //    in nx than the same pair separates in ny.
  const swapParts = [];
  let swapMin = Infinity;
  for (const [name, crater] of Object.entries(CRATERS)) {
    const east = sampleWallSector(nx, ny, W, H, crater, 90);
    const west = sampleWallSector(nx, ny, W, H, crater, 270);
    const inChannel = Math.abs(west.meanNx - east.meanNx);
    const crossChannel = Math.abs(west.meanNy - east.meanNy);
    const margin = inChannel - crossChannel;
    swapParts.push(
      `${name}: E/W separation in nx ${round6(inChannel)} vs in ny ${round6(crossChannel)}`,
    );
    if (margin < swapMin) swapMin = margin;
  }
  add(
    "channelsAreNotSwapped",
    swapMin >= SWAP_MIN_MARGIN,
    swapMin,
    `>= ${SWAP_MIN_MARGIN}`,
    swapParts.join("; "),
  );

  return { ok: checks.every((c) => c.pass), checks };
}

// Thresholds. Set from the MEASURED values on the shipped map with a wide
// margin, and validated adversarially — the spec re-runs the whole battery
// against deliberately corrupted maps (flipped red, flipped green, swapped
// channels, flattened) and requires every one to be REJECTED. A threshold
// loose enough to accept a mirror would fail that, so these cannot silently
// rot into vacuous checks.
export const EW_MIN_SEPARATION = 0.08;
export const NS_MIN_SEPARATION = 0.08;
export const ILLUM_MIN_RATIO = 1.3;
export const SWAP_MIN_MARGIN = 0.04;
export const TEST_LIGHT_ELEVATION_DEG = 10;

/** Per-crater relief measurements, for the checked-in manifest. */
export function measureCraters(nx, ny, nz, W, H) {
  const out = {};
  for (const [name, crater] of Object.entries(CRATERS)) {
    const east = sampleWallSector(nx, ny, W, H, crater, 90);
    const west = sampleWallSector(nx, ny, W, H, crater, 270);
    const north = sampleWallSector(nx, ny, W, H, crater, 0);
    const south = sampleWallSector(nx, ny, W, H, crater, 180);
    out[name] = {
      eastWallNx: round6(east.meanNx),
      westWallNx: round6(west.meanNx),
      northWallNy: round6(north.meanNy),
      southWallNy: round6(south.meanNy),
      wallTexels: east.count + west.count + north.count + south.count,
    };
  }
  return out;
}

function round6(v) {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}
