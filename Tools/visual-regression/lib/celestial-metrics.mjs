// celestial-metrics.mjs — Campaign 12 celestial gate metric library (C12-01).
//
// Pure functions over RGBA pixel buffers. NO browser, NO Playwright, NO engine
// imports — every function here is Node-testable in isolation, which is what
// `celestial-metrics.spec.mjs` (node --test) exercises as the trust anchor for
// the whole celestial gate harness.
//
// Metric definitions are the ones ratified in
//   migration_doc/CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md §5
//   migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md §5
// namely M1 (point-source census), M2 (contrast/tail), M2e (sky floor),
// M3 (chroma), M4 (radial falloff), M5 (magnitude fidelity).
//
// IMAGE CONTRACT
// --------------
// Every function accepts an `image` object of the shape
//   { data, width, height }
// where `data` is an RGBA buffer with 4 channels per pixel (row-major, top-left
// origin), length === width * height * 4. Two data domains are supported:
//   • 8-bit sRGB captures  — data is Uint8ClampedArray|Uint8Array|number[] in
//     [0,255]; metrics linearize per the sRGB EOTF before measuring "linear
//     light" quantities. This is the default.
//   • linear-light HDR      — data is Float64Array|Float32Array carrying already
//     -linear radiance (e.g. the C12-02 exposure-bracket composite). Pass
//     `{ alreadyLinear: true }` so no sRGB decode is applied.
//
// All "in linear light" quantities (M1 thresholds, M2 contrast/tail, M2e floor,
// M4 profile) are computed on a Rec.709 luminance of the LINEAR channels:
//   L = 0.2126*R + 0.7152*G + 0.0722*B
// For 8-bit inputs L lands in [0,1]; for HDR inputs L is unbounded linear.

const SRGB_ALPHA = 0.055;
const SRGB_CUTOFF = 0.04045;

/**
 * sRGB electro-optical transfer function (gamma decode) for a single channel
 * normalized to [0,1]. Returns the linear-light value.
 * @param {number} c channel value in [0,1]
 * @returns {number} linear-light value in [0,1]
 */
export function srgbToLinear(c) {
  if (c <= SRGB_CUTOFF) {
    return c / 12.92;
  }
  return Math.pow((c + SRGB_ALPHA) / (1 + SRGB_ALPHA), 2.4);
}

/**
 * Build a per-pixel linear-light luminance buffer from an image.
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean}} [options]
 * @returns {Float64Array} luminance, length width*height
 */
export function computeLinearLuminance(image, options = {}) {
  const { data, width, height } = image;
  const alreadyLinear = options.alreadyLinear === true;
  const n = width * height;
  const lum = new Float64Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (!alreadyLinear) {
      r = srgbToLinear(r / 255);
      g = srgbToLinear(g / 255);
      b = srgbToLinear(b / 255);
    }
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return lum;
}

/**
 * Resolve a luminance buffer, honouring a caller-supplied precomputed one.
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean,lum?:Float64Array}} [options]
 * @returns {Float64Array}
 */
function resolveLuminance(image, options = {}) {
  if (options.lum instanceof Float64Array) {
    return options.lum;
  }
  return computeLinearLuminance(image, options);
}

/**
 * Ascending-sorted percentile with linear interpolation between ranks.
 * @param {ArrayLike<number>} sortedAsc values sorted ascending
 * @param {number} q quantile in [0,1]
 * @returns {number}
 */
export function percentile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) {
    return NaN;
  }
  if (n === 1) {
    return sortedAsc[0];
  }
  const clamped = Math.min(1, Math.max(0, q));
  const idx = clamped * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sortedAsc[lo];
  }
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Least-squares slope + intercept of y over x (both arrays, equal length).
 * Returns { slope: NaN } when x has zero variance.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {{slope:number,intercept:number}}
 */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) {
    return { slope: NaN, intercept: NaN };
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (den === 0) {
    return { slope: NaN, intercept: my };
  }
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

/**
 * Fractional ranks (average ties) of an array, for Spearman correlation.
 * @param {number[]} values
 * @returns {number[]}
 */
function rankValues(values) {
  const n = values.length;
  const order = new Array(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
  }
  order.sort((a, b) => values[a] - values[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[order[k]] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Pearson correlation of two equal-length arrays.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function pearson(a, b) {
  const n = a.length;
  if (n < 2) {
    return NaN;
  }
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : NaN;
}

/**
 * Spearman rank correlation of two equal-length arrays.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function spearman(a, b) {
  if (a.length !== b.length || a.length < 2) {
    return NaN;
  }
  return pearson(rankValues(a), rankValues(b));
}

/**
 * Convert a single RGB triple (0..255, or 0..max for HDR) to HSV.
 * Saturation is the classic S = (max-min)/max; hue in degrees [0,360).
 * When max===0 or the pixel is achromatic, hue is reported as 0 and
 * saturation as 0.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{h:number,s:number,v:number}}
 */
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const s = max <= 0 ? 0 : delta / max;
  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return { h, s, v: max };
}

// ---------------------------------------------------------------------------
// M1 — point-source census
// ---------------------------------------------------------------------------
//
// For every interior pixel that is a STRICT 3×3 local maximum of linear
// luminance, estimate a local background B as the MEDIAN of the linear
// luminances in the annulus 3 ≤ euclidean-radius ≤ 5 (an 11×11 window centred
// on the candidate, with the star's own core excluded). The pixel is counted as
// a source when both
//   (P − B) ≥ threshold          (default 12/255, "in linear light")
//   P ≥ peakRatio · B            (default 1.6)
// hold, where P is the candidate's linear luminance.
//
// Being differential (P vs local B) the census is immune to a uniform
// multiplicative fade or global exposure shift — the discriminator a
// fade-vs-brightness gate needs.

/**
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean,lum?:Float64Array,threshold?:number,
 *          peakRatio?:number,innerRadius?:number,outerRadius?:number,
 *          border?:number}} [options]
 * @returns {{count:number,sources:{x:number,y:number,peak:number,background:number}[]}}
 */
export function m1PointSourceCensus(image, options = {}) {
  const { width, height } = image;
  const lum = resolveLuminance(image, options);
  const threshold = options.threshold ?? 12 / 255;
  const peakRatio = options.peakRatio ?? 1.6;
  const inner = options.innerRadius ?? 3;
  const outer = options.outerRadius ?? 5;
  const border = options.border ?? outer;

  // Precompute the annulus offset stencil once.
  const annulus = [];
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= inner && d <= outer) {
        annulus.push([dx, dy]);
      }
    }
  }

  const sources = [];
  const ring = new Float64Array(annulus.length);
  for (let y = border; y < height - border; y++) {
    for (let x = border; x < width - border; x++) {
      const p = y * width + x;
      const v = lum[p];
      // Strict 3×3 local maximum test.
      let isMax = true;
      for (let ny = -1; ny <= 1 && isMax; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          if (nx === 0 && ny === 0) {
            continue;
          }
          if (lum[(y + ny) * width + (x + nx)] >= v) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) {
        continue;
      }
      // Median of the annulus = local background.
      for (let k = 0; k < annulus.length; k++) {
        const ax = x + annulus[k][0];
        const ay = y + annulus[k][1];
        ring[k] = lum[ay * width + ax];
      }
      const sorted = Array.prototype.slice.call(ring).sort((a, b) => a - b);
      const bg = percentile(sorted, 0.5);
      if (v - bg >= threshold && v >= peakRatio * bg) {
        sources.push({ x, y, peak: v, background: bg });
      }
    }
  }
  return { count: sources.length, sources };
}

// ---------------------------------------------------------------------------
// M2 — contrast / tail shape
// ---------------------------------------------------------------------------
//
// (a) RMS contrast σ(L)/mean(L)
// (b) P99.9(L) − P50(L)
// (c) log-slope of the upper-1% histogram tail (least-squares slope of
//     log10(count) vs log10(binCentre) over the pixels brighter than P99,
//     binned into `tailBins` bins across [P99, Lmax]). Null when the tail is
//     degenerate (Lmax === P99 or fewer than 2 populated bins).
// (d) hard-clip census — count of pixels with any 8-bit channel ≥ clipLevel
//     (default 250). Computed on the RAW channels, since clipping is an
//     8-bit-target concept; skipped (returns 0) for HDR/linear inputs.
//
// A FADED field: low (a), low (b), same mean. A BLOBBY field: high (d),
// collapsed (c). (c)+(d) separate the two symptoms.

/**
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean,lum?:Float64Array,clipLevel?:number,
 *          tailBins?:number}} [options]
 * @returns {{mean:number,stddev:number,rmsContrast:number,p50:number,
 *            p999:number,p999MinusP50:number,tailLogSlope:number|null,
 *            clipCount:number}}
 */
export function m2ContrastTail(image, options = {}) {
  const lum = resolveLuminance(image, options);
  const n = lum.length;
  const clipLevel = options.clipLevel ?? 250;
  const tailBins = options.tailBins ?? 16;
  const alreadyLinear = options.alreadyLinear === true;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += lum[i];
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = lum[i] - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / n);
  const rmsContrast = mean > 0 ? stddev / mean : 0;

  const sorted = Float64Array.from(lum).sort();
  const p50 = percentile(sorted, 0.5);
  const p999 = percentile(sorted, 0.999);
  const p99 = percentile(sorted, 0.99);
  const lmax = sorted[n - 1];

  // (c) upper-1% tail log-log slope.
  let tailLogSlope = null;
  if (lmax > p99) {
    const bins = new Array(tailBins).fill(0);
    const span = lmax - p99;
    for (let i = 0; i < n; i++) {
      const v = lum[i];
      if (v > p99) {
        let b = Math.floor(((v - p99) / span) * tailBins);
        if (b >= tailBins) {
          b = tailBins - 1;
        }
        bins[b]++;
      }
    }
    const xs = [];
    const ys = [];
    for (let b = 0; b < tailBins; b++) {
      if (bins[b] > 0) {
        const centre = p99 + ((b + 0.5) / tailBins) * span;
        if (centre > 0) {
          xs.push(Math.log10(centre));
          ys.push(Math.log10(bins[b]));
        }
      }
    }
    if (xs.length >= 2) {
      const fit = linearFit(xs, ys);
      tailLogSlope = Number.isFinite(fit.slope) ? fit.slope : null;
    }
  }

  // (d) hard-clip census on raw 8-bit channels.
  let clipCount = 0;
  if (!alreadyLinear) {
    const { data } = image;
    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i] >= clipLevel ||
        data[i + 1] >= clipLevel ||
        data[i + 2] >= clipLevel
      ) {
        clipCount++;
      }
    }
  }

  return {
    mean,
    stddev,
    rmsContrast,
    p50,
    p999,
    p999MinusP50: p999 - p50,
    tailLogSlope,
    clipCount,
  };
}

// ---------------------------------------------------------------------------
// M2e — sky-floor luminance
// ---------------------------------------------------------------------------
//
// The minimum sky luminance over the star-field region. Reported as the 0.5th
// percentile (P0.5) rather than the raw min so a handful of dead/black pixels
// (a stuck 0, or the UI-free crop still clipping a widget edge) don't drive the
// floor to a meaningless 0. The robust floor is the single most direct
// discriminator for a veil/pedestal mechanism. The raw min is also returned for
// reference.

/**
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean,lum?:Float64Array,floorPercentile?:number}} [options]
 * @returns {{skyFloor:number,percentileUsed:number,rawMin:number}}
 */
export function m2eSkyFloor(image, options = {}) {
  const lum = resolveLuminance(image, options);
  const q = options.floorPercentile ?? 0.005;
  const sorted = Float64Array.from(lum).sort();
  return {
    skyFloor: percentile(sorted, q),
    percentileUsed: q,
    rawMin: sorted[0],
  };
}

// ---------------------------------------------------------------------------
// M3 — chroma over detected sources
// ---------------------------------------------------------------------------
//
// Over the M1-detected pixel positions, report the median HSV saturation and
// the hue inter-quartile range (Q3 − Q1). A monochrome field is a defect: the
// fork computes per-star blackbody RGB from B−V, so a correct field is visibly
// bimodal in hue. Hue IQR is computed on the linear ordering of hue in degrees;
// it is a spread indicator, not a circular statistic (documented caveat — a
// field split hard across the 0°/360° red wrap could over-report, which the
// catalogue's blue-to-red span does not trigger in practice).

/**
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{x:number,y:number}[]} sources
 * @returns {{medianSaturation:number,hueIQR:number,sampleCount:number}}
 */
export function m3Chroma(image, sources) {
  const { data, width } = image;
  const sats = [];
  const hues = [];
  for (const s of sources) {
    const i = (s.y * width + s.x) * 4;
    const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    sats.push(hsv.s);
    hues.push(hsv.h);
  }
  if (sats.length === 0) {
    return { medianSaturation: 0, hueIQR: 0, sampleCount: 0 };
  }
  const satSorted = sats.slice().sort((a, b) => a - b);
  const hueSorted = hues.slice().sort((a, b) => a - b);
  return {
    medianSaturation: percentile(satSorted, 0.5),
    hueIQR: percentile(hueSorted, 0.75) - percentile(hueSorted, 0.25),
    sampleCount: sats.length,
  };
}

// ---------------------------------------------------------------------------
// M4 — radial falloff profile
// ---------------------------------------------------------------------------
//
// Azimuthally-average linear luminance in integer-radius bins out to `maxRadius`
// (default 40 px) around a given source centre. From the profile report:
//   r_core   — HWHM: first radius where I(r) falls to 0.5·peak
//   r_1e-2   — first radius where I(r) falls to 1e-2·peak
//   r_1e-3   — first radius where I(r) falls to 1e-3·peak
//   ratio    — r_1e-3 / r_core  (the blob-vs-star discriminator)
//   slopeInner — log-log slope of I(r) over [2·r_core, 5·r_core]
//   slopeOuter — log-log slope of I(r) over [5·r_core, 15·r_core]
//
// A Gaussian's log-log slope steepens without bound (s(r) ∝ −r²), and a Gaussian
// truncated at its quad edge cannot reach 1e-3 far out, so its r_1e-3/r_core is
// small (<2). A Moffat power-law wing has a constant log-log slope and a wide
// halo, so its ratio is large (≥8). This single ratio separates blob from star.

/**
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{x:number,y:number}} source
 * @param {{alreadyLinear?:boolean,lum?:Float64Array,maxRadius?:number}} [options]
 * @returns {{profile:number[],peak:number,rCore:number,r1e2:number,
 *            r1e3:number,ratio1e3:number,slopeInner:number,slopeOuter:number}}
 */
export function m4RadialFalloff(image, source, options = {}) {
  const { width, height } = image;
  const lum = resolveLuminance(image, options);
  const maxRadius = options.maxRadius ?? 40;
  const cx = source.x;
  const cy = source.y;

  const sums = new Float64Array(maxRadius + 1);
  const counts = new Float64Array(maxRadius + 1);
  const x0 = Math.max(0, cx - maxRadius);
  const x1 = Math.min(width - 1, cx + maxRadius);
  const y0 = Math.max(0, cy - maxRadius);
  const y1 = Math.min(height - 1, cy + maxRadius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.round(Math.sqrt(dx * dx + dy * dy));
      if (r <= maxRadius) {
        sums[r] += lum[y * width + x];
        counts[r] += 1;
      }
    }
  }
  const profile = new Array(maxRadius + 1);
  for (let r = 0; r <= maxRadius; r++) {
    profile[r] = counts[r] > 0 ? sums[r] / counts[r] : NaN;
  }
  const peak = profile[0];

  // First-crossing radius (linearly interpolated) where I(r) drops to `frac`.
  const crossing = (frac) => {
    const target = peak * frac;
    for (let r = 1; r <= maxRadius; r++) {
      const cur = profile[r];
      if (!Number.isFinite(cur)) {
        continue;
      }
      const prev = profile[r - 1];
      if (cur <= target) {
        if (Number.isFinite(prev) && prev > target && prev !== cur) {
          return r - 1 + (prev - target) / (prev - cur);
        }
        return r;
      }
    }
    return NaN;
  };

  const rCore = crossing(0.5);
  const r1e2 = crossing(1e-2);
  const r1e3 = crossing(1e-3);

  // Log-log slope of I(r) vs r over [loMul*rCore, hiMul*rCore].
  const windowSlope = (loMul, hiMul) => {
    if (!Number.isFinite(rCore) || rCore <= 0) {
      return NaN;
    }
    const lo = loMul * rCore;
    const hi = hiMul * rCore;
    const xs = [];
    const ys = [];
    for (let r = 1; r <= maxRadius; r++) {
      if (r >= lo && r <= hi && Number.isFinite(profile[r]) && profile[r] > 0) {
        xs.push(Math.log10(r));
        ys.push(Math.log10(profile[r]));
      }
    }
    if (xs.length < 2) {
      return NaN;
    }
    return linearFit(xs, ys).slope;
  };

  return {
    profile,
    peak,
    rCore,
    r1e2,
    r1e3,
    ratio1e3: Number.isFinite(r1e3) && rCore > 0 ? r1e3 / rCore : NaN,
    slopeInner: windowSlope(2, 5),
    slopeOuter: windowSlope(5, 15),
  };
}

// ---------------------------------------------------------------------------
// M5 — magnitude fidelity
// ---------------------------------------------------------------------------
//
// Cross-match catalogue expectations {screenX, screenY, vmag} against M1
// detections by screen position (≤ maxDistance px, nearest wins). For the
// matched set report:
//   spearman — rank correlation of log10(peak) against −0.4·vmag
//              (−0.4·vmag === log10(relative flux), Pogson 1856)
//   exponent — least-squares slope of log10(peak) vs (−0.4·vmag), i.e. the
//              fitted power relating rendered peak to true flux
//   brightestFaintestRatio — max(peak)/min(peak) over matched detections
//
// A faithful renderer preserves flux ordering (spearman → 1) and delivers a
// wide brightest:faintest span; the C12 "white blob" defect collapses that span
// to ~4:1 by construction.

/**
 * @param {{screenX:number,screenY:number,vmag:number}[]} expectations
 * @param {{x:number,y:number,peak:number}[]} detections
 * @param {{maxDistance?:number}} [options]
 * @returns {{matched:{vmag:number,peak:number,dist:number}[],
 *            spearman:number,exponent:number,brightestFaintestRatio:number}}
 */
export function m5MagnitudeFidelity(expectations, detections, options = {}) {
  const maxDistance = options.maxDistance ?? 3;
  const matched = [];
  const used = new Set();
  for (const e of expectations) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i)) {
        continue;
      }
      const dx = detections[i].x - e.screenX;
      const dy = detections[i].y - e.screenY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= maxDistance) {
      used.add(best);
      matched.push({ vmag: e.vmag, peak: detections[best].peak, dist: bestD });
    }
  }

  if (matched.length < 2) {
    return {
      matched,
      spearman: NaN,
      exponent: NaN,
      brightestFaintestRatio: NaN,
    };
  }

  const logFlux = matched.map((m) => -0.4 * m.vmag);
  const logPeak = matched.map((m) => Math.log10(Math.max(m.peak, 1e-12)));
  let maxPeak = -Infinity;
  let minPeak = Infinity;
  for (const m of matched) {
    if (m.peak > maxPeak) {
      maxPeak = m.peak;
    }
    if (m.peak < minPeak && m.peak > 0) {
      minPeak = m.peak;
    }
  }
  return {
    matched,
    spearman: spearman(logFlux, logPeak),
    exponent: linearFit(logFlux, logPeak).slope,
    brightestFaintestRatio: minPeak > 0 ? maxPeak / minPeak : NaN,
  };
}

export default {
  srgbToLinear,
  computeLinearLuminance,
  percentile,
  linearFit,
  pearson,
  spearman,
  rgbToHsv,
  m1PointSourceCensus,
  m2ContrastTail,
  m2eSkyFloor,
  m3Chroma,
  m4RadialFalloff,
  m5MagnitudeFidelity,
};
