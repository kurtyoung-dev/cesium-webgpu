/**
 * @purpose Pixel half of the ring-family estimator: gathers a frame's pixels about the stated disc centre, bins them radially (whole and per octant of azimuth) about any candidate centre, finds a family's own centre by band-passed amplitude, says when that centre ran into the edge of the search, and removes a fitted family from the pixels so the next family can be looked for.
 * @status ACTIVE
 */

import { bandSeries, fittedValue } from "./radial-banding-family-spectrum.mjs";

/** Name a centre carries when the search stopped at its own edge. */
export const CENTRE_AT_SEARCH_BOUNDARY = "CENTRE_AT_SEARCH_BOUNDARY";

const OCTANTS = 8;

/**
 * Sectors of azimuth in the second frame the concentricity test reads. The
 * eight octants put their boundaries on the axes and the diagonals, where an
 * axis-aligned grid or a checkerboard has its stationary directions, so half a
 * stationary lobe lands in every octant and such a lattice reads as
 * concentric there. The sixteen sectors' boundaries include those directions
 * too: the two frames together decline the lattice fundamentals the family
 * spec pins (G17) and only those, and a lattice whose harmonics fall in band
 * can fill all sixteen (WHAT IT CANNOT SEE in `radial-banding-family.mjs`).
 */
export const SECTORS = 16;

/**
 * Pixels within `reach` of a point (every `stride`-th), so each centre
 * candidate re-bins them. The corners of the bounding box lie beyond every
 * candidate's reach and are left out.
 */
export function collectPixels(field, cx, cy, reach, stride = 1) {
  const { width, height, data } = field;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(height - 1, Math.ceil(cy + reach));
  const count =
    Math.ceil((x1 - x0 + 1) / stride) * Math.ceil((y1 - y0 + 1) / stride);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const values = new Float64Array(count);
  const reachSquared = (reach + 1) * (reach + 1);
  let at = 0;
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= reachSquared) {
        xs[at] = x + 0.5;
        ys[at] = y + 0.5;
        values[at] = data[y * width + x];
        at++;
      }
    }
  }
  return { xs, ys, values, count: at };
}

/** Radial sums and counts about one centre at `binPx`, out to `extentPx`. */
export function binSums(pixels, cx, cy, binPx, extentPx) {
  const bins = Math.ceil(extentPx / binPx);
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  const { xs, ys, values, count } = pixels;
  const extentSquared = extentPx * extentPx;
  for (let index = 0; index < count; index++) {
    const dx = xs[index] - cx;
    const dy = ys[index] - cy;
    const squared = dx * dx + dy * dy;
    if (squared < extentSquared) {
      const bin = Math.floor(Math.sqrt(squared) / binPx);
      sums[bin] += values[index];
      counts[bin] += 1;
    }
  }
  return { sums, counts };
}

/**
 * The same sums split into `sectors` equal sectors of azimuth about the
 * centre (eight octants unless stated), the first starting at azimuth -pi.
 */
export function octantSums(pixels, cx, cy, binPx, extentPx, sectors = OCTANTS) {
  const bins = Math.ceil(extentPx / binPx);
  const sums = Array.from({ length: sectors }, () => new Float64Array(bins));
  const counts = Array.from({ length: sectors }, () => new Float64Array(bins));
  const { xs, ys, values, count } = pixels;
  const extentSquared = extentPx * extentPx;
  for (let index = 0; index < count; index++) {
    const dx = xs[index] - cx;
    const dy = ys[index] - cy;
    const squared = dx * dx + dy * dy;
    if (squared < extentSquared) {
      const bin = Math.floor(Math.sqrt(squared) / binPx);
      const sector =
        Math.floor(((Math.atan2(dy, dx) + Math.PI) * sectors) / (2 * Math.PI)) %
        sectors;
      sums[sector][bin] += values[index];
      counts[sector][bin] += 1;
    }
  }
  return { sums, counts };
}

/** The centre objective: a band's RMS about a candidate centre. */
function amplitudeAbout(pixels, cx, cy, band) {
  const extent = band.to + (band.halfBins + 1) * band.binPx;
  const { sums, counts } = binSums(pixels, cx, cy, band.binPx, extent);
  return bandSeries(sums, counts, band).rms;
}

/** Separable box blur of radius `r`, edge-clamped. */
function boxBlur(source, width, height, r) {
  const across = new Float64Array(width * height);
  const out = new Float64Array(width * height);
  const n = 2 * r + 1;
  const clampX = (x) => Math.min(width - 1, Math.max(0, x));
  const clampY = (y) => Math.min(height - 1, Math.max(0, y));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let k = -r; k <= r; k++) {
      acc += source[row + clampX(k)];
    }
    for (let x = 0; x < width; x++) {
      across[row + x] = acc / n;
      acc += source[row + clampX(x + r + 1)] - source[row + clampX(x - r)];
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) {
      acc += across[clampY(k) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = acc / n;
      acc +=
        across[clampY(y + r + 1) * width + x] -
        across[clampY(y - r) * width + x];
    }
  }
  return out;
}

/**
 * The point every coherent fringe normal points at, by weighted least squares.
 *
 * A band-passed copy (box 2 minus box 6) is differentiated and its structure
 * tensor smoothed over a box of 4; each pixel between `rhoMinPx` and
 * `rhoMaxPx` of the stated centre whose orientation coherence is at least 0.55
 * contributes the line through it along its dominant gradient, weighted by
 * the eigenvalue gap. Closed form: no search.
 */
export function fringeNormalCentre(field, settings) {
  const { discCentreX, discCentreY, rhoMinPx, rhoMaxPx } = settings;
  const reach = rhoMaxPx + settings.centreSearchPx + 8;
  const x0 = Math.max(0, Math.floor(discCentreX - reach));
  const y0 = Math.max(0, Math.floor(discCentreY - reach));
  const width =
    Math.min(field.width - 1, Math.ceil(discCentreX + reach)) - x0 + 1;
  const height =
    Math.min(field.height - 1, Math.ceil(discCentreY + reach)) - y0 + 1;
  const crop = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      crop[y * width + x] = field.data[(y + y0) * field.width + x + x0];
    }
  }
  const coarse = boxBlur(crop, width, height, 6);
  const band = boxBlur(crop, width, height, 2).map((v, i) => v - coarse[i]);
  const jxx = new Float64Array(width * height);
  const jxy = new Float64Array(width * height);
  const jyy = new Float64Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (band[i + 1] - band[i - 1]) * 0.5;
      const gy = (band[i + width] - band[i - width]) * 0.5;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }
  const [sxx, sxy, syy] = [jxx, jxy, jyy].map((j) =>
    boxBlur(j, width, height, 4),
  );
  // Normal equations of sum w |(I - n n^T)(c - p)|^2: [a11 a12; a12 a22] c = b.
  const a = [0, 0, 0, 0, 0];
  let voters = 0;
  for (let y = 8; y < height - 8; y++) {
    for (let x = 8; x < width - 8; x++) {
      const px = x + x0 + 0.5;
      const py = y + y0 + 0.5;
      const rho = Math.hypot(px - discCentreX, py - discCentreY);
      const i = y * width + x;
      const trace = sxx[i] + syy[i];
      const xy = sxy[i];
      const gap = Math.sqrt(Math.max(0, (sxx[i] - syy[i]) ** 2 + 4 * xy * xy));
      if (rho < rhoMinPx || rho > rhoMaxPx || !(gap >= 0.55 * trace)) {
        continue;
      }
      const tilted = Math.abs(xy) > 1e-30;
      let ex = tilted ? 0.5 * (trace + gap) - syy[i] : sxx[i] >= syy[i] ? 1 : 0;
      let ey = tilted ? xy : sxx[i] >= syy[i] ? 0 : 1;
      const length = Math.hypot(ex, ey);
      ex /= length;
      ey /= length;
      const [p11, p12, p22] = [1 - ex * ex, -ex * ey, 1 - ey * ey];
      a[0] += gap * p11;
      a[1] += gap * p12;
      a[2] += gap * p22;
      a[3] += gap * (p11 * px + p12 * py);
      a[4] += gap * (p12 * px + p22 * py);
      voters++;
    }
  }
  const determinant = a[0] * a[2] - a[1] * a[1];
  if (voters < 64 || !(Math.abs(determinant) > 0)) {
    return { x: null, y: null, coherentPixels: voters };
  }
  return {
    x: (a[2] * a[3] - a[1] * a[4]) / determinant,
    y: (a[0] * a[4] - a[1] * a[3]) / determinant,
    coherentPixels: voters,
  };
}

/**
 * Find a band's family centre. The stated centre, the fringe-normal point and
 * the best cell of a 3 px grid over the whole search disc (scored on every
 * second pixel) are scored at full resolution; the best is refined by a
 * shrinking pattern search and a parabola on each axis. The grid is what keeps
 * a fringe-normal point dragged off by a patchy deck's coverage edges from
 * choosing the basin.
 *
 * A centre within one pixel of the search disc's edge is named
 * `CENTRE_AT_SEARCH_BOUNDARY`: the objective was still rising where the
 * search had to stop, so the family's centre may lie outside it and neither
 * the centre nor an amplitude read about it is the family's.
 */
export function locateCentre(pixels, sparse, settings, band, fringe) {
  const { discCentreX, discCentreY, centreSearchPx } = settings;
  const allowed = (x, y) =>
    Math.hypot(x - discCentreX, y - discCentreY) <= centreSearchPx;
  const score = (x, y, from = pixels) => amplitudeAbout(from, x, y, band);
  let grid = null;
  for (let dy = -centreSearchPx; dy <= centreSearchPx; dy += 3) {
    for (let dx = -centreSearchPx; dx <= centreSearchPx; dx += 3) {
      const x = discCentreX + dx;
      const y = discCentreY + dy;
      if (allowed(x, y)) {
        const value = score(x, y, sparse);
        if (grid === null || value > grid.value) {
          grid = { x, y, value };
        }
      }
    }
  }
  const candidates = [
    { x: discCentreX, y: discCentreY, from: "stated" },
    { x: grid.x, y: grid.y, from: "grid" },
  ];
  if (fringe.x !== null && allowed(fringe.x, fringe.y)) {
    candidates.push({ x: fringe.x, y: fringe.y, from: "fringe-normal" });
  }
  let best = null;
  for (const candidate of candidates) {
    const value = score(candidate.x, candidate.y);
    if (best === null || value > best.value) {
      best = { ...candidate, value };
    }
  }
  for (const [step, span] of [
    [1, 4],
    [0.25, 1],
    [0.0625, 0.25],
  ]) {
    const { x: fromX, y: fromY } = best;
    for (let dy = -span; dy <= span + 1e-9; dy += step) {
      for (let dx = -span; dx <= span + 1e-9; dx += step) {
        const x = fromX + dx;
        const y = fromY + dy;
        if (allowed(x, y)) {
          const value = score(x, y);
          if (value > best.value) {
            best = { ...best, x, y, value };
          }
        }
      }
    }
  }
  const h = 0.0625;
  const polish = (ox, oy) => {
    const left = score(best.x - ox, best.y - oy);
    const right = score(best.x + ox, best.y + oy);
    const denominator = left - 2 * best.value + right;
    const shift = denominator < 0 ? (0.5 * (left - right)) / denominator : 0;
    return Math.abs(shift) <= 1 ? shift * h : 0;
  };
  const shiftX = polish(h, 0);
  const shiftY = polish(0, h);
  const x = best.x + shiftX;
  const y = best.y + shiftY;
  const atEdge =
    Math.hypot(x - discCentreX, y - discCentreY) >= centreSearchPx - 1;
  return {
    x,
    y,
    source: "refined",
    refinedFrom: best.from,
    grid: { x: grid.x, y: grid.y },
    boundary: atEdge ? CENTRE_AT_SEARCH_BOUNDARY : null,
  };
}

/**
 * A copy of the pixels with fitted lines about one centre subtracted, so a
 * second family is looked for without the first one's rings. The fitted
 * sinusoids are extended over every pixel whose radius lies past half the
 * window's inner edge, since the family does not stop at the window.
 */
export function withoutFamily(pixels, cx, cy, fits, innerPx) {
  const values = Float64Array.from(pixels.values);
  for (let index = 0; index < pixels.count; index++) {
    const rho = Math.hypot(pixels.xs[index] - cx, pixels.ys[index] - cy);
    if (rho >= innerPx) {
      for (const fit of fits) {
        values[index] -= fittedValue(rho, fit);
      }
    }
  }
  return { ...pixels, values };
}
