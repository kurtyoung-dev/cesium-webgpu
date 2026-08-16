// star-point-census-live.spec.mjs — C12-STAR-POINT-CENSUS-LIVE-CALIBRATION.
// @purpose Standing discriminator: the star point census was mis-calibrated for live frames (strict local-max tie at the NDC-origin pixel corner).
// @status ACTIVE
//
// The DISCRIMINATOR the DEFERRED_WORK entry specified, kept as a standing spec.
//
// THE QUESTION IT SETTLES. After the DR-01 seam landed (Batch 833) the cube map
// carries diffuse light only, so `probe-stars-catalog.mjs`'s check (G) went
// green — the map alone yields ZERO resolved point sources. But check (A) went
// RED: the point census also returned 0 for the sprites-ON frame, even though
// the sprites were plainly rendering (max luminance 28 -> 180, centre-box bright
// pixels 0 -> 4, and check (D) passing). Two readings were possible — the census
// is mis-calibrated for live frames (it was developed against BAKED 2048-px cube
// faces), or the sprite field genuinely stopped producing isolated point maxima.
// The discriminator: run the SAME census over a synthetic frame containing
// splats of the sprite renderer's ACTUAL on-screen footprint.
//
// THE ANSWER: mis-calibrated, and by a single mechanism — the STRICT
// local-maximum test. `probe-stars-catalog.mjs` aims the camera exactly at
// Sirius, so Sirius projects to NDC (0,0), which for an even-sized viewport is
// exactly a pixel CORNER; its four surrounding pixels are then EQUAL by
// construction and, under a strict test, each disqualifies the others. The
// synthetic frame reproduces the live numbers exactly: four candidate pixels at
// luminance 152.6, all four dropped by the tie, `strongest` 0, census 0 — while
// the probe's own brightness count reports 4. The detector GEOMETRY, by
// contrast, is correct for this footprint and is asserted so below.
//
// WHAT IS DELIBERATELY NOT CHANGED. `minPeak` (40) and `minContrast` (24) stay
// exactly where they were. The entry records why: the metric was made a point
// census precisely because Sirius sits ~9 deg off the galactic plane, where a
// brightness count is dominated by the diffuse band. The off-frame peak
// luminance is 28, so lowering the floor would put candidates back inside the
// band's own 8-bit range. The consequence is a stated SCOPE for check (A) — it
// gates the bright end of the catalogue at a known aim point — not a loosening.
//
// The footprint is DERIVED from the shipped source, never guessed: the shader
// PSF constants are extracted from `StarField.wgsl`, the quad half-angle and
// minimum size from `StarField.js`, and the exposure anchors from
// `StarFieldMath.ts`. If any of them moves, the extraction asserts rather than
// silently modelling a stale sprite.
//
// Pure Node: no browser, no image decode, no network.
// Run: node --test Tools/visual-regression/star-point-census-live.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CENSUS_DEFAULTS,
  pointSourceCensus,
} from "../skybox-bake/starmap-census.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const CENSUS_REL = "Tools/skybox-bake/starmap-census.mjs";

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const wgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl",
);
const starFieldJs = read("packages/engine/Source/Scene/StarField.js");
const mathTs = read("packages/engine/Source/Scene/StarFieldMath.ts");

/** Extract a numeric literal, failing loudly when its declaration moves. */
function num(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `could not extract ${what} — its declaration moved`);
  return Number(m[1]);
}

// ── the sprite's footprint, derived from the shipped source ────────────────
const SIGMA = num(
  wgsl,
  /const STAR_PSF_SIGMA: f32 = ([0-9.]+);/,
  "STAR_PSF_SIGMA",
);
const ALPHA = num(
  wgsl,
  /const STAR_PSF_ALPHA: f32 = ([0-9.]+);/,
  "STAR_PSF_ALPHA",
);
const BETA = num(
  wgsl,
  /const STAR_PSF_BETA: f32 = ([0-9.]+);/,
  "STAR_PSF_BETA",
);
const K_HALO = num(
  wgsl,
  /const STAR_PSF_K_HALO: f32 = ([0-9.]+);/,
  "STAR_PSF_K_HALO",
);

const POINT_ANGULAR_SIZE = num(
  starFieldJs,
  /this\._pointAngularSize = ([0-9.]+);/,
  "StarField._pointAngularSize",
);
const MIN_POINT_SIZE = num(
  starFieldJs,
  /this\._minPointSize = ([0-9.]+);/,
  "StarField._minPointSize",
);
const FAINT_ANCHOR_MAG = num(
  mathTs,
  /const FAINT_ANCHOR_MAG = ([0-9.]+);/,
  "FAINT_ANCHOR_MAG",
);
const FAINT_ANCHOR_PEAK = num(
  mathTs,
  /const FAINT_ANCHOR_PEAK = ([0-9.]+);/,
  "FAINT_ANCHOR_PEAK",
);
const GLARE_MAX_DIAMETER_RAD = num(
  mathTs,
  /const GLARE_MAX_DIAMETER_RAD = ([0-9.]+);/,
  "GLARE_MAX_DIAMETER_RAD",
);
const BASE_QUAD_DIAMETER_RAD = num(
  mathTs,
  /const BASE_QUAD_DIAMETER_RAD = ([0-9.]+);/,
  "BASE_QUAD_DIAMETER_RAD",
);
const MAG_CUTOFF = num(mathTs, /const MAG_CUTOFF = ([0-9.]+);/, "MAG_CUTOFF");

const EXPOSURE =
  (FAINT_ANCHOR_PEAK / (1.0 + K_HALO)) * Math.pow(10.0, 0.4 * FAINT_ANCHOR_MAG);
const MAX_QUAD_SCALE = GLARE_MAX_DIAMETER_RAD / BASE_QUAD_DIAMETER_RAD;

// `probe-stars-catalog.mjs` opens a 1024x768 page and uses the Cesium default
// 60-degree frustum, whose `fov` is the HORIZONTAL angle when width > height.
const VIEW_W = 1024;
const VIEW_H = 768;
const FOV = (60 * Math.PI) / 180;
const ASPECT = VIEW_W / VIEW_H;
const FOVY = ASPECT <= 1 ? FOV : 2 * Math.atan(Math.tan(FOV * 0.5) / ASPECT);
// Uniform pack: pointSize.x = angularRadius * |proj[0]|, .y = * |proj[5]|;
// the vertex shader then offsets the clip-space corner by that NDC half-extent.
const PROJ0 = 1 / (ASPECT * Math.tan(FOVY * 0.5));
const PROJ5 = 1 / Math.tan(FOVY * 0.5);
const NDC_HALF_X = POINT_ANGULAR_SIZE * PROJ0;
const NDC_HALF_Y = POINT_ANGULAR_SIZE * PROJ5;
// NDC half-extent -> pixels: NDC spans [-1,1] across the viewport.
const R0_X = Math.max(NDC_HALF_X, MIN_POINT_SIZE) * (VIEW_W / 2);
const R0_Y = Math.max(NDC_HALF_Y, MIN_POINT_SIZE) * (VIEW_H / 2);
const R0 = R0_X;
const CORE_SIGMA_PX = SIGMA * R0;

/** Linear Pogson intensity, exactly as `buildStarInstanceData` computes it. */
function intensityOf(vmag) {
  return vmag > MAG_CUTOFF ? 0 : EXPOSURE * Math.pow(10.0, -0.4 * vmag);
}
/** C12-06 quad growth: glare AREA proportional to flux, capped at 1 degree. */
function quadScaleOf(intensity) {
  return intensity > 1 ? Math.min(Math.sqrt(intensity), MAX_QUAD_SCALE) : 1;
}
/**
 * The fragment profile in PIXEL radius. `core` is coreScale-compensated in the
 * shader, so it is invariant in `s` by construction — that invariance is
 * asserted below rather than assumed.
 */
function profile(dPx, s) {
  const r = dPx / (R0 * s);
  if (r >= 1) {
    return 0;
  }
  const core = Math.exp(-((dPx / R0) * (dPx / R0)) / (2 * SIGMA * SIGMA));
  const hb = r / ALPHA;
  const halo = Math.pow(1 + hb * hb, -BETA);
  // smoothstep(1.0, 0.92, r)
  let t = (r - 1.0) / (0.92 - 1.0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (core + K_HALO * halo) * (t * t * (3 - 2 * t));
}

/** Ballesteros B-V -> blackbody -> Planckian RGB, mirroring `bvToRgb`. */
function bvToRgb(bv) {
  const dA = 0.92 * bv + 1.7;
  const dB = 0.92 * bv + 0.62;
  const t =
    4600 *
    (1 / (Math.abs(dA) < 1e-3 ? 1e-3 : dA) +
      1 / (Math.abs(dB) < 1e-3 ? 1e-3 : dB));
  const T = Math.min(40000, Math.max(1500, t)) / 100;
  let r;
  let g;
  let b;
  if (T <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(T) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(T - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(T - 60, -0.0755148492);
  }
  if (T >= 66) {
    b = 255;
  } else if (T <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(T - 10) - 305.0447927307;
  }
  r = Math.min(255, Math.max(0, r)) / 255;
  g = Math.min(255, Math.max(0, g)) / 255;
  b = Math.min(255, Math.max(0, b)) / 255;
  const peak = Math.max(r, g, b, 1e-3);
  return [r / peak, g / peak, b / peak];
}

const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * Render a luminance plane containing star splats.
 *
 * The sprite is additively blended into an `rgba8unorm` scene target, so each
 * channel is clamped to [0,1] and quantised to 8 bits BEFORE the probe's `lum`
 * helper weights it — modelling the quantisation is the whole point, since ties
 * are what the census mishandles. Samples are taken at pixel CENTRES: MSAA runs
 * the fragment shader once per covered pixel at the centre, and every pixel that
 * carries the core of a 5.3-px-wide quad is fully covered.
 */
function renderPlane(w, h, splats, backgroundByte = 0) {
  const ch = [0, 1, 2].map(() =>
    new Float32Array(w * h).fill(backgroundByte / 255),
  );
  for (const sp of splats) {
    const s = quadScaleOf(sp.intensity);
    const reach = R0 * s + 1;
    const x0 = Math.max(0, Math.floor(sp.cx - reach));
    const x1 = Math.min(w - 1, Math.ceil(sp.cx + reach));
    const y0 = Math.max(0, Math.floor(sp.cy - reach));
    const y1 = Math.min(h - 1, Math.ceil(sp.cy + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = profile(Math.hypot(x + 0.5 - sp.cx, y + 0.5 - sp.cy), s);
        if (p <= 0) {
          continue;
        }
        for (let c = 0; c < 3; c++) {
          ch[c][y * w + x] += sp.intensity * sp.rgb[c] * p;
        }
      }
    }
  }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let l = 0;
    for (let c = 0; c < 3; c++) {
      l += LUMA[c] * Math.round(255 * Math.min(1, Math.max(0, ch[c][i])));
    }
    lum[i] = l;
  }
  return lum;
}

// The probe's centre box: half-width fraction 0.12 of a 1024x768 frame.
const BOX_F = 0.12;
const BOX_X0 = Math.floor(VIEW_W * (0.5 - BOX_F));
const BOX_Y0 = Math.floor(VIEW_H * (0.5 - BOX_F));
const BOX_W = Math.floor(VIEW_W * (0.5 + BOX_F)) - BOX_X0;
const BOX_H = Math.floor(VIEW_H * (0.5 + BOX_F)) - BOX_Y0;
// Aiming the camera AT the star puts it at NDC (0,0) = continuous pixel
// coordinate (w/2, h/2). Pixel centres sit at i + 0.5, so that is a pixel
// CORNER — the four surrounding pixels are equidistant, hence equal.
const AIM_CX = VIEW_W / 2 - BOX_X0;
const AIM_CY = VIEW_H / 2 - BOX_Y0;

const SIRIUS_VMAG = -1.46;
const SIRIUS_BV = 0.0;
const SIRIUS_I = intensityOf(SIRIUS_VMAG);
const SIRIUS_RGB = bvToRgb(SIRIUS_BV);

function boxWith(cx, cy, intensity, rgb, backgroundByte = 0) {
  return renderPlane(
    BOX_W,
    BOX_H,
    [{ cx, cy, intensity, rgb }],
    backgroundByte,
  );
}
/**
 * A diffuse Milky Way band with a drifting centre, slow along-band modulation
 * and a couple of LSBs of deterministic dither — the shape
 * `skybox-diffuse-seam.spec.mjs` uses. The dither is load-bearing: without it
 * the quantised field is flat integer plateaus with no local maxima at all, the
 * isolation test alone suppresses everything, and the local-background
 * subtraction is never exercised. With it the band carries MANY tiny maxima —
 * exactly the false positives `minContrast` exists to reject.
 */
function synthDiffuseBand(w, h, amplitude) {
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const along = x / w;
      const centre = h * (0.5 + 0.18 * Math.sin(along * Math.PI * 2));
      const d = (y - centre) / (h * 0.22);
      const along2 = 0.65 + 0.35 * Math.sin(along * Math.PI * 6);
      const dither = ((x * 7 + y * 13) % 5) - 2;
      const v = Math.round(amplitude * Math.exp(-d * d) * along2) + dither;
      lum[y * w + x] = Math.max(0, Math.min(255, v));
    }
  }
  return lum;
}

function brightPixels(lum, thresh = 40) {
  let n = 0;
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] > thresh) {
      n++;
    }
  }
  return n;
}

// ─── group 1: the derived footprint ────────────────────────────────────────

test("footprint — the sprite quad is isotropic and its scale is what the census assumes", () => {
  assert.ok(
    Math.abs(R0_X - R0_Y) < 1e-9,
    `the aspect-corrected quad must be round: ${R0_X} vs ${R0_Y} px`,
  );
  assert.ok(
    NDC_HALF_X > MIN_POINT_SIZE,
    `the minPointSize floor (${MIN_POINT_SIZE}) must NOT bind at this viewport ` +
      `(base half-extent ${NDC_HALF_X}); if it starts binding the model below ` +
      `silently switches to a different footprint`,
  );
  assert.ok(
    Math.abs(R0 - 2.66043) < 5e-4,
    `base quad half-extent drifted: ${R0.toFixed(5)} px (recorded 2.66043)`,
  );
  assert.ok(
    Math.abs(CORE_SIGMA_PX - 0.31925) < 5e-4,
    `core sigma drifted: ${CORE_SIGMA_PX.toFixed(5)} px (recorded 0.31925)`,
  );
  // C12-06's invariant: quad growth is halo extent, never core size. The
  // profile at 0.5 px must therefore be dominated by a term that does not move
  // with `s` — checked by differencing the full profile against the halo share.
  const coreAt = (dPx, s) => profile(dPx, s) - K_HALO * haloOnly(dPx, s);
  for (const s of [1, 1.237, 2.4231, MAX_QUAD_SCALE]) {
    assert.ok(
      Math.abs(coreAt(0.5, s) - coreAt(0.5, 1)) < 1e-9,
      `the core must be invariant under the C12-06 quad boost (s = ${s})`,
    );
  }
  function haloOnly(dPx, s) {
    const r = dPx / (R0 * s);
    let t = (r - 1.0) / (0.92 - 1.0);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const hb = r / ALPHA;
    return Math.pow(1 + hb * hb, -BETA) * (t * t * (3 - 2 * t));
  }
});

test("footprint — the census GEOMETRY is right for it (this half needed no change)", () => {
  const { coreRadius, ringRadius } = CENSUS_DEFAULTS;
  assert.ok(
    coreRadius < R0,
    `coreRadius ${coreRadius} must sit inside the base quad (${R0.toFixed(3)} px)`,
  );
  assert.ok(
    ringRadius > R0,
    `ringRadius ${ringRadius} must sit outside the base quad (${R0.toFixed(3)} px)`,
  );
  // Bright stars grow their quad past the ring; what matters is that the Moffat
  // wing they leave ON the ring is below one 8-bit code, so the local background
  // estimate is never contaminated by the source's own light.
  const worstIntensity = MAX_QUAD_SCALE * MAX_QUAD_SCALE;
  for (const intensity of [SIRIUS_I, worstIntensity]) {
    const s = quadScaleOf(intensity);
    const ringByte = 255 * Math.min(1, intensity * profile(ringRadius, s));
    assert.ok(
      ringByte < 1,
      `a sprite of intensity ${intensity.toFixed(3)} puts ${ringByte.toFixed(3)}/255 ` +
        `on the census ring — the background estimate would be self-contaminated`,
    );
  }
});

// ─── group 2: THE DISCRIMINATOR ────────────────────────────────────────────

test("DISCRIMINATOR — the probe's own aim geometry produces a 2x2 tie plateau", () => {
  const lum = boxWith(AIM_CX, AIM_CY, SIRIUS_I, SIRIUS_RGB);
  const bright = brightPixels(lum);
  assert.equal(
    bright,
    4,
    "aiming at the star must leave exactly the four equidistant pixels above " +
      "the 40/255 threshold — this is the live probe's reported count",
  );
  const vals = new Set();
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      vals.add(lum[(AIM_CY + dy) * BOX_W + (AIM_CX + dx)]);
    }
  }
  assert.equal(vals.size, 1, "the four pixels must be bit-identical");
  const only = [...vals][0];
  assert.ok(
    Math.abs(only - 152.6) < 0.2,
    `plateau luminance drifted: ${only.toFixed(2)} (recorded 152.6)`,
  );
});

test("DISCRIMINATOR — the census ACCEPTS that plateau, counting it exactly once", () => {
  const lum = boxWith(AIM_CX, AIM_CY, SIRIUS_I, SIRIUS_RGB);
  const res = pointSourceCensus(lum, BOX_W, BOX_H, { collectSources: true });
  assert.equal(
    res.count,
    1,
    "a plateau is ONE source: zero would be the pre-fix defect, four would be " +
      "double-counting",
  );
  assert.equal(res.sources.length, 1);
  const s = res.sources[0];
  assert.equal(
    s.x,
    AIM_CX - 1,
    "the representative is the scan-order-first member",
  );
  assert.equal(s.y, AIM_CY - 1);
  assert.ok(
    s.contrast > 100,
    `the accepted source must tower over its ring; contrast ${s.contrast}`,
  );
});

test("DISCRIMINATOR — acceptance holds across EVERY sub-pixel phase", () => {
  const N = 33;
  let accepted = 0;
  let total = 0;
  const rejected = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const ox = i / (N - 1);
      const oy = j / (N - 1);
      const lum = boxWith(AIM_CX + ox, AIM_CY + oy, SIRIUS_I, SIRIUS_RGB);
      total++;
      if (pointSourceCensus(lum, BOX_W, BOX_H).count >= 1) {
        accepted++;
      } else {
        rejected.push([ox.toFixed(3), oy.toFixed(3)]);
      }
    }
  }
  assert.equal(
    accepted,
    total,
    `the census must resolve the brightest catalogue star at every sub-pixel ` +
      `phase; it missed ${rejected.length} of ${total}: ` +
      `${JSON.stringify(rejected.slice(0, 8))}`,
  );
});

test("SCOPE — minPeak 40 reaches only the bright end of the catalogue", () => {
  // Best possible phase: the sample lands on the profile centre, peak = 1.08*I.
  // Solving 255*(1+K_HALO)*EXPOSURE*10^(-0.4 m) = minPeak gives the reach.
  const reach =
    -Math.log10(CENSUS_DEFAULTS.minPeak / (255 * (1 + K_HALO) * EXPOSURE)) /
    0.4;
  assert.ok(
    Math.abs(reach - 2.5566) < 5e-3,
    `census reach drifted: vmag ${reach.toFixed(4)} (recorded 2.5566). The ` +
      `probe's (A) SCOPE note quotes this number; update both together.`,
  );
  // The reach must stay brighter than the exposure anchor, otherwise the census
  // would be claiming to see stars the exposure never intended to be detectable
  // by THIS floor, and (A) would silently become a faint-end test.
  assert.ok(
    reach < FAINT_ANCHOR_MAG,
    `the census floor (${CENSUS_DEFAULTS.minPeak}/255) must sit above the ` +
      `sprite exposure anchor (vmag ${FAINT_ANCHOR_MAG} at ` +
      `${(255 * FAINT_ANCHOR_PEAK).toFixed(1)}/255)`,
  );
  const anchorPeakByte = 255 * FAINT_ANCHOR_PEAK;
  assert.ok(
    anchorPeakByte < CENSUS_DEFAULTS.minPeak,
    `the anchor star (${anchorPeakByte.toFixed(1)}/255) is below the census ` +
      `floor by design — counting field stars with this census is not a gate`,
  );
});

test("SCOPE — the census stays blind to a diffuse face's own brightness", () => {
  // Every shipped diffuse face peaks at 8-28 (skybox-manifest.json), and the
  // probe's sprites-OFF frame peaks at 28. Below minPeak there is no candidate
  // at all, so the plateau rule cannot move check (G) in any direction.
  const w = 192;
  const h = 192;
  const faint = synthDiffuseBand(w, h, 28);
  assert.equal(
    pointSourceCensus(faint, w, h).count,
    0,
    "below minPeak there is no candidate at all",
  );
  // ...and a band that IS bright still yields nothing, because it is smooth:
  // the plateau rule did not weaken the local-background test. This band
  // carries dither, so it DOES contain local maxima — only `minContrast`
  // rejects them, which is exactly the guarantee (G) depends on.
  const bright = synthDiffuseBand(w, h, 200);
  const res = pointSourceCensus(bright, w, h);
  assert.equal(
    res.count,
    0,
    `a dithered 200-luminance band must still census 0 (got ${res.count}); the ` +
      `plateau rule must not have opened a path for diffuse light`,
  );
  assert.ok(res.peakMax >= 200, "the band really is bright");
});

test("SCOPE — a flat saturated plateau counts once, not once per pixel", () => {
  // The generalisation of the fix: any equal-valued blob inside the core
  // neighbourhood collapses to one source. Guards against the opposite error
  // (turning the tie into an inflated count).
  const w = 64;
  const h = 64;
  const img = new Float32Array(w * h);
  for (let y = 30; y <= 33; y++) {
    for (let x = 30; x <= 33; x++) {
      img[y * w + x] = 255;
    }
  }
  const res = pointSourceCensus(img, w, h, { collectSources: true });
  assert.equal(res.count, 1, `a 4x4 saturated blob must be ONE source`);
  assert.deepEqual(
    { x: res.sources[0].x, y: res.sources[0].y },
    { x: 30, y: 30 },
  );
});

// ─── group 3: MUTATION — prove the fix is load-bearing ─────────────────────

/**
 * Import a MUTATED copy of the census from a temp dir, so nothing under Tools/
 * is touched. CRLF is normalised first: on a Windows checkout the multi-line
 * targets below would otherwise silently fail to match and every assertion here
 * would pass vacuously — the notEqual guard is what catches that.
 */
async function importMutatedCensus(mutate, label) {
  const file = path.join(root, CENSUS_REL);
  const original = (await readFile(file, "utf8")).split("\r\n").join("\n");
  const mutated = mutate(original);
  assert.notEqual(
    mutated,
    original,
    `the ${label} mutation did not change ${CENSUS_REL} — its target text has ` +
      `moved, so this MUTATION test would pass vacuously`,
  );
  const dir = await mkdtemp(path.join(tmpdir(), "cesium-live-census-"));
  const out = path.join(dir, "Mutant.mjs");
  await writeFile(out, mutated, "utf8");
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("MUTATION — restoring the STRICT maximum reproduces the original 0-source defect", async () => {
  const mutant = await importMutatedCensus(
    (src) =>
      src.replace(
        "neighbor === v && (dy < 0 || (dy === 0 && dx < 0));",
        "neighbor === v;",
      ),
    "plateau-rule removal",
  );
  const lum = boxWith(AIM_CX, AIM_CY, SIRIUS_I, SIRIUS_RGB);
  const before = mutant.pointSourceCensus(lum, BOX_W, BOX_H);
  assert.equal(
    before.count,
    0,
    "with the strict test back, the aimed star must vanish from the census — " +
      "if it does not, the plateau rule is not what fixed check (A)",
  );
  assert.equal(
    before.strongest,
    0,
    "no candidate should even reach the contrast test, matching the live run",
  );
  assert.equal(
    pointSourceCensus(lum, BOX_W, BOX_H).count,
    1,
    "the shipped census must still see it",
  );
});

test("MUTATION — dropping the strictly-brighter test inflates the census", async () => {
  const mutant = await importMutatedCensus(
    (src) =>
      src.replace(
        "const dominated = neighbor > v;",
        "const dominated = false;",
      ),
    "dominance removal",
  );
  // A field of splats at generic phases: without the dominance test the wings
  // of each splat become sources of their own.
  const splats = [];
  for (let k = 0; k < 12; k++) {
    splats.push({
      cx: 20 + 17 * (k % 4) + 0.31 * k,
      cy: 20 + 19 * Math.floor(k / 4) + 0.17 * k,
      intensity: SIRIUS_I,
      rgb: SIRIUS_RGB,
    });
  }
  const lum = renderPlane(BOX_W, BOX_H, splats);
  const honest = pointSourceCensus(lum, BOX_W, BOX_H).count;
  const inflated = mutant.pointSourceCensus(lum, BOX_W, BOX_H).count;
  assert.ok(
    inflated > honest,
    `without the dominance test the census (${inflated}) must exceed the ` +
      `honest count (${honest}) — isolation is not being enforced`,
  );
});

test("MUTATION — dropping the local-background test lets the diffuse band through", async () => {
  const mutant = await importMutatedCensus(
    (src) => src.replace("if (contrast >= minContrast) {", "if (true) {"),
    "local-background removal",
  );
  const w = 192;
  const h = 192;
  const band = synthDiffuseBand(w, h, 200);
  assert.ok(
    mutant.pointSourceCensus(band, w, h).count > 0,
    "with the local-background test removed the smooth band MUST register " +
      "phantom sources — that condition is what keeps (A) a POINT test",
  );
});

test("MUTATION — collectSources must report real coordinates, not indices", async () => {
  const mutant = await importMutatedCensus(
    (src) =>
      src.replace(
        "sources.push({ x, y, peak: v, contrast });",
        "sources.push({ x: 0, y: 0, peak: v, contrast });",
      ),
    "source-coordinate neutering",
  );
  const lum = boxWith(AIM_CX, AIM_CY, SIRIUS_I, SIRIUS_RGB);
  const bad = mutant.pointSourceCensus(lum, BOX_W, BOX_H, {
    collectSources: true,
  });
  assert.deepEqual(
    { x: bad.sources[0].x, y: bad.sources[0].y },
    { x: 0, y: 0 },
    "the neutered build should report the origin",
  );
  const good = pointSourceCensus(lum, BOX_W, BOX_H, { collectSources: true });
  assert.notDeepEqual(
    { x: good.sources[0].x, y: good.sources[0].y },
    { x: 0, y: 0 },
    "the shipped build must report the source's real pixel — probe check (A) " +
      "asserts the resolved source lands on the aim point",
  );
});
