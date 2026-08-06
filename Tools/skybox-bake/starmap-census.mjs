// starmap-census.mjs — structural metrics that decide whether a star-map cube
// face carries RESOLVED point sources, DIFFUSE degree-scale light, or both.
//
// This module exists because Campaign-12 DR-01 assigns exactly one physical
// owner to each signal: the cubemap carries diffuse Milky Way light ONLY, and
// every resolved star comes from the sprite catalogue. Proving a bake honours
// that split needs a metric that can tell the two signals apart — and the
// obvious statistics cannot:
//
//   - A whole-face MEAN is blind here. Blurring conserves total energy, so the
//     mean is nearly INVARIANT under the very operation being verified. It is
//     also the trap the Batch-815 census hit from the other side: a faint
//     additive sprite field spread over a large band moves a band mean by less
//     than its own noise.
//   - A VARIANCE or P99 is better but still confounded: a face can lose every
//     star and keep its variance if the diffuse band is strong, or keep stars
//     and lose variance if the band is flattened.
//
// So the two signals get two separate, deliberately ORTHOGONAL metrics:
//
//   pointSourceCensus() — a POINT metric. Counts pixels that are a strict local
//     maximum over their neighbourhood AND rise sharply above the local
//     background measured on a ring outside that neighbourhood. That is the
//     definition of an unresolved source: bright, isolated, and steep. It is
//     insensitive to how bright the surrounding band is, because the background
//     is subtracted locally rather than globally.
//
//   bandStructure() — a SCALE metric. The spread of coarse block means. Degree-
//     scale Milky Way structure survives a ~1 deg low-pass almost untouched, so
//     this stays high on a correct diffuse face and collapses only if the face
//     was actually blacked out or flattened.
//
// The pair is what makes the DR-01 claim falsifiable in both directions:
//   diffuse face  => point census COLLAPSES, band structure SURVIVES
//   blacked face  => point census collapses, band structure ALSO collapses (rejected)
//   unblurred face => point census HIGH (the reversal artifact, still bundled)
//
// Pure and dependency-free by design: it operates on plain typed arrays, so the
// bake can feed it decoded pixels through `sharp` while
// `Tools/visual-regression/skybox-diffuse-seam.spec.mjs` feeds it synthetic
// images with known ground truth and mutates this file to prove the detector
// has teeth. Nothing here imports an image library.

/**
 * Rec.709 luma of an interleaved 8-bit RGB buffer, in the stored (sRGB-encoded)
 * domain — the same domain the probe's `lum` helper and the engine's 8-bit
 * canvas grabs work in, so thresholds are comparable across the two.
 *
 * @param {Uint8Array|Buffer} rgb Interleaved RGB, length >= w*h*3.
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array} Length w*h.
 */
export function toLuminance(rgb, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = 3 * p;
    out[p] = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  }
  return out;
}

/**
 * Default detector geometry. `coreRadius` is the neighbourhood a source must
 * strictly dominate; `ringRadius` sits OUTSIDE it so the background estimate is
 * never contaminated by the source's own wings.
 *
 * The defaults are tied to the physics of the bake, not tuned to an outcome:
 * the DR-01 low-pass is sigma = 20 source-equirect px (FWHM ~1.03 deg), and at
 * 2048/face a pixel spans ~0.044 deg, so a blurred source's energy is smeared
 * over ~23 px FWHM. A core radius of 2 px with the background sampled at 5 px
 * therefore sits entirely INSIDE the blurred profile — where the gradient is
 * almost flat — which is exactly why the census collapses on a diffuse face
 * while an unresolved star (< 0.1 deg, i.e. a couple of px) still towers over
 * its ring.
 *
 * THESE SAME DEFAULTS ARE VALID ON A LIVE FRAME, and the geometry was checked
 * against the sprite renderer rather than assumed (C12-STAR-POINT-CENSUS-LIVE-
 * CALIBRATION). At `probe-stars-catalog.mjs`'s 1024x768 viewport the catalogue
 * sprite's base quad half-extent is 2.660 px and its Gaussian core is
 * sigma = 0.319 px, so `coreRadius` 2 lies inside the quad and `ringRadius` 5
 * lies outside it; even the brightest star's Moffat wing contributes at most
 * 0.16/255 to that ring (0.45/255 for a hypothetical star at the 1-degree
 * glare cap), i.e. below one 8-bit code. What DID have to change for live
 * frames is the tie handling in condition 2 — see `pointSourceCensus`.
 *
 * `minPeak` 40 is deliberately NOT re-derived downward for live frames. It is
 * what makes the metric refuse the diffuse band, and the shipped diffuse faces
 * peak at 8-28 against it. The consequence is a stated SCOPE, not a defect: the
 * sprite exposure anchors a vmag-3.6 star at 15.3/255 (StarFieldMath.ts, tied to
 * the M1 census floor of 12/255), so a 40/255 floor resolves only stars brighter
 * than vmag 2.56 even at the most favourable sub-pixel phase — 98 of the 2,868
 * catalogue rows. A live-frame check built on this census is therefore a gate on
 * the BRIGHT end of the catalogue, and must aim at a known bright star rather
 * than count field stars. Lowering the floor to reach the faint end would put
 * candidates back inside the diffuse band's own 8-bit range and re-create the
 * brightness count this detector replaced.
 */
export const CENSUS_DEFAULTS = Object.freeze({
  coreRadius: 2,
  ringRadius: 5,
  minPeak: 40,
  minContrast: 24,
});

/**
 * Count resolved point sources in a luminance image.
 *
 * A pixel counts when all three hold:
 *   1. `lum >= minPeak`                       — it is actually bright;
 *   2. it is the UNIQUE local maximum of its (2*coreRadius+1)^2 neighbourhood —
 *      it is isolated, not a bright band interior. "Unique" rather than
 *      "strict": see the plateau rule below;
 *   3. `lum - ringMean >= minContrast`        — it rises steeply above the LOCAL
 *      background sampled on the square ring at `ringRadius`.
 *
 * Condition 3 is what makes the metric orthogonal to diffuse brightness: a star
 * sitting on the bright Milky Way band still passes, and a smooth band interior
 * never does no matter how bright it gets.
 *
 * ── The plateau rule (C12-STAR-POINT-CENSUS-LIVE-CALIBRATION, 2026-08-06) ──
 *
 * Condition 2 used to be a STRICT maximum: any neighbour with `lum >= v`
 * disqualified the candidate. That is only sound when exact ties are
 * impossible, which holds for a 2048-px baked cube face (where this detector
 * was developed — stars land at arbitrary sub-pixel phases) and FAILS on a live
 * rendered frame, where a source symmetric about a pixel boundary produces a
 * plateau of bit-identical pixels and every member of that plateau then
 * disqualifies every other. The census returned ZERO for the plateau instead of
 * one, and it did so for the one star a probe is most likely to measure: aiming
 * a camera AT a star puts it at NDC (0,0), which for an even-sized viewport is
 * exactly a pixel CORNER, so its four surrounding pixels are equal by
 * construction. Measured: a Sirius sprite at that phase (1024x768, the probe's
 * viewport) yields four candidate pixels at luminance 152.6, all four dropped by
 * the tie, `strongest` 0 — reproducing `probe-stars-catalog.mjs`'s live
 * "0 resolved sources, 4 bright pixels" exactly.
 *
 * So a tie no longer disqualifies: a plateau of equal-valued pixels is counted
 * ONCE, at its scan-order-first member (`dy < 0`, or `dy === 0 && dx < 0`). This
 * is NOT a loosening of the metric — every threshold is unchanged, and a
 * candidate must still clear `minPeak` and out-rise its ring by `minContrast`.
 * It can only ever turn a plateau's 0 into a 1, never admit a smooth region: a
 * smooth band has no `minContrast` rise, and a face whose peak luminance is
 * below `minPeak` (all six shipped diffuse faces peak at 8-28 against the 40
 * floor) produces no candidate at all, so `DR01_LIMITS.diffuseMaxPointSources`
 * is untouched by construction. The un-blurred reversal faces can only census
 * slightly HIGHER, and their bound is a minimum.
 *
 * Border pixels within `ringRadius` of an edge are skipped rather than clamped.
 * Clamping would fabricate a background from duplicated edge texels and could
 * invent or suppress sources exactly at the cube seams.
 *
 * @param {Float32Array} lum
 * @param {number} w
 * @param {number} h
 * @param {object} [opts] Overrides for {@link CENSUS_DEFAULTS}, plus
 *   `collectSources` (default false) which additionally returns each accepted
 *   source's pixel coordinate. Off by default so the bake's per-face pass over
 *   ~10k sources stays allocation-free.
 * @returns {{count:number, peakMax:number, strongest:number,
 *   sources:Array<{x:number,y:number,peak:number,contrast:number}>|undefined}}
 *   `count` of sources, the brightest luminance seen anywhere, the largest
 *   peak-minus-ring contrast found, and — only when `collectSources` is set —
 *   the accepted sources.
 */
export function pointSourceCensus(lum, w, h, opts) {
  const { coreRadius, ringRadius, minPeak, minContrast, collectSources } = {
    ...CENSUS_DEFAULTS,
    collectSources: false,
    ...(opts ?? {}),
  };

  let count = 0;
  let peakMax = 0;
  let strongest = 0;
  const sources = collectSources ? [] : undefined;

  for (let p = 0; p < lum.length; p++) {
    if (lum[p] > peakMax) {
      peakMax = lum[p];
    }
  }

  for (let y = ringRadius; y < h - ringRadius; y++) {
    for (let x = ringRadius; x < w - ringRadius; x++) {
      const v = lum[y * w + x];
      if (v < minPeak) {
        continue;
      }

      // 2. unique local maximum over the core neighbourhood (plateau rule above)
      let isMax = true;
      for (let dy = -coreRadius; dy <= coreRadius && isMax; dy++) {
        for (let dx = -coreRadius; dx <= coreRadius; dx++) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const neighbor = lum[(y + dy) * w + (x + dx)];
          // A strictly brighter neighbour means this is not a maximum at all.
          const dominated = neighbor > v;
          // An EQUAL neighbour earlier in scan order means this pixel is a
          // later member of a plateau that has already been counted.
          const earlierInPlateau =
            neighbor === v && (dy < 0 || (dy === 0 && dx < 0));
          if (dominated || earlierInPlateau) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) {
        continue;
      }

      // 3. local background from the square ring OUTSIDE the core
      let sum = 0;
      let m = 0;
      for (let d = -ringRadius; d <= ringRadius; d++) {
        sum += lum[(y - ringRadius) * w + (x + d)];
        sum += lum[(y + ringRadius) * w + (x + d)];
        m += 2;
      }
      for (let d = -ringRadius + 1; d <= ringRadius - 1; d++) {
        sum += lum[(y + d) * w + (x - ringRadius)];
        sum += lum[(y + d) * w + (x + ringRadius)];
        m += 2;
      }
      const contrast = v - sum / m;
      if (contrast > strongest) {
        strongest = contrast;
      }
      if (contrast >= minContrast) {
        count++;
        if (sources !== undefined) {
          sources.push({ x, y, peak: v, contrast });
        }
      }
    }
  }

  return { count, peakMax, strongest, sources };
}

/**
 * Degree-scale structure metric: the population standard deviation of block
 * means over a `block`-by-`block` grid, plus the overall mean.
 *
 * Averaging inside each block destroys point sources by construction, so this
 * responds to the diffuse band and essentially nothing else — the property that
 * lets it certify "the Milky Way is still there" independently of the point
 * census. Partial blocks at the right/bottom edge are ignored so every sample
 * carries the same weight.
 *
 * @param {Float32Array} lum
 * @param {number} w
 * @param {number} h
 * @param {number} [block=128] Block edge in pixels. At 2048/face, 128 px spans
 *   ~5.6 deg — comfortably coarser than the ~1 deg diffuse low-pass, so the
 *   metric measures the band rather than the blur kernel.
 * @returns {{blocks:number, mean:number, stdDev:number}}
 */
export function bandStructure(lum, w, h, block = 128) {
  const bx = Math.floor(w / block);
  const by = Math.floor(h / block);
  const means = [];

  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let sum = 0;
      for (let y = j * block; y < (j + 1) * block; y++) {
        const row = y * w;
        for (let x = i * block; x < (i + 1) * block; x++) {
          sum += lum[row + x];
        }
      }
      means.push(sum / (block * block));
    }
  }

  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance =
    means.reduce((a, b) => a + (b - mean) * (b - mean), 0) / means.length;

  return { blocks: means.length, mean, stdDev: Math.sqrt(variance) };
}

/**
 * DR-01 acceptance thresholds for a SHIPPED face set, evaluated per face.
 *
 * These are contract limits, not descriptive statistics: they are the loosest
 * values that still separate the three outcomes the seam can produce (diffuse,
 * unblurred, blacked-out). The measured values are recorded in
 * `skybox-manifest.json` and sit far from every bound.
 */
export const DR01_LIMITS = Object.freeze({
  // A diffuse face must retain no resolved sources at all. Zero is the honest
  // bound: the low-pass FWHM is an order of magnitude wider than the detector
  // core, so a single survivor means the blur did not run on that face.
  diffuseMaxPointSources: 0,
  // The diffuse face must KEEP the degree-scale band it was low-passed from.
  // The test is RELATIVE to the same face's un-blurred twin, because band
  // strength is a property of where the face points, not of the bake: `px`/`mx`
  // look away from the galactic centre and legitimately carry ~2.5x less
  // structure than `mz`. An absolute floor tuned to `mz` would reject a correct
  // `px`; one tuned to `px` would accept a half-wiped `mz`. The ratio is the
  // quantity the blur is actually supposed to preserve, and the shipped set
  // measures 0.83-0.95 against this 0.60 bound.
  diffuseMinBandRatio: 0.6,
  // Absolute backstop so a pair of blacked-out sets cannot satisfy the ratio
  // vacuously (0/0). Every shipped face is far above it.
  diffuseMinBandStdDev: 0.25,
  // The retained reversal artifact must still be unmistakably a resolved-star
  // map, otherwise the two variants are not actually different assets and the
  // "reversal without a re-bake" promise in DR-01 is empty.
  unblurredMinPointSources: 200,
});

/**
 * Evaluate one face pair against {@link DR01_LIMITS}.
 *
 * @param {{points:number, bandStdDev:number}} diffuse
 * @param {{points:number, bandStdDev:number}} unblurred The same face's
 *   un-blurred twin, which supplies the band-preservation reference.
 * @returns {{pass:boolean, failures:string[], bandRatio:number}}
 */
export function checkDr01(diffuse, unblurred) {
  const failures = [];
  const bandRatio =
    unblurred.bandStdDev > 0 ? diffuse.bandStdDev / unblurred.bandStdDev : 0;

  if (diffuse.points > DR01_LIMITS.diffuseMaxPointSources) {
    failures.push(
      `diffuse face retains ${diffuse.points} resolved point source(s); DR-01 allows ${DR01_LIMITS.diffuseMaxPointSources}`,
    );
  }
  if (diffuse.bandStdDev < DR01_LIMITS.diffuseMinBandStdDev) {
    failures.push(
      `diffuse face band structure ${diffuse.bandStdDev.toFixed(3)} < ${DR01_LIMITS.diffuseMinBandStdDev} — the Milky Way was destroyed, not low-passed`,
    );
  }
  if (bandRatio < DR01_LIMITS.diffuseMinBandRatio) {
    failures.push(
      `diffuse face kept only ${(bandRatio * 100).toFixed(1)}% of its un-blurred band structure ` +
        `(${diffuse.bandStdDev.toFixed(3)} vs ${unblurred.bandStdDev.toFixed(3)}); DR-01 requires >= ` +
        `${(DR01_LIMITS.diffuseMinBandRatio * 100).toFixed(0)}%`,
    );
  }
  if (unblurred.points < DR01_LIMITS.unblurredMinPointSources) {
    failures.push(
      `reversal (un-blurred) face has only ${unblurred.points} resolved point source(s); expected >= ${DR01_LIMITS.unblurredMinPointSources}`,
    );
  }
  return { pass: failures.length === 0, failures, bandRatio };
}
