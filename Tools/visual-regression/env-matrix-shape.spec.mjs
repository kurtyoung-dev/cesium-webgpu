// env-matrix-shape.spec.mjs — browser-free trust anchors for the pure decision
// logic inside probe-env-pass-matrix: the SHAPE-based body detector (defects D1
// and D2) and the night source contract (defect D3). All three were found by
// orchestrator pre-fix runs, and all three were INSTRUMENT bugs — the probe
// disagreeing with its own WebGL reference — so each one is pinned here against
// either a synthetic image with known ground truth or the actual measured
// reference numbers, where a browser is not needed to catch a regression.
//
// WHY THIS EXISTS
// ---------------
// D1: the original detector asked `discMax >= ringMean + 20 && litFrac > 0.02`
// — an ABSOLUTE-luminance test. With the TYCHO_T5 skybox (the Batch-742 default
// bright Milky Way render) behind a HIDDEN moon, cubemap pixels inside the 3°
// ROI cleared that bar, so `day skybox-only` and `day skybox+starfield` read
// moon=true on the WebGL reference and tripped the probe's own
// reference-disagreement structural guard.
//
// The replacement is shape-based, and shape claims must be proven on images
// whose ground truth is known. This spec extracts `shapeStatsFromPixels`,
// `presenceOf` and `evaluateNightSourceContract` VERBATIM from the probe source
// (the probe module cannot be imported — its top-level IIFE launches a browser)
// and runs them against synthetic ROIs built from a deterministic PRNG:
//
//   A  hidden body over a TYCHO-like star field           -> moon FALSE (D1)
//   A2 hidden body over a star field + bright Milky Way
//      band crossing BOTH disc and ring                   -> moon FALSE (D1)
//   B  daylight CRESCENT (pf~0.15) over that same field   -> moon TRUE
//   C  night gibbous over a black sky                     -> moon TRUE
//   D  black frame                                        -> moon FALSE
//   E  saturated sun disc, glare flooding the ring        -> sun TRUE
//   E2 alpha-blended sun under a radially-falling glare
//      halo (the profile that broke day sun-only)         -> sun TRUE  (D2)
//   E3 uniformly bright sky, no body at all               -> both FALSE (D2)
//   F  hidden sun over the star field                     -> sun FALSE
//
// ...plus the D3 group, which pins the night source contract to the MEASURED
// reference numbers (WebGL cubemapOnly 1094 / spritesOnly 2) so its
// expectations can never again drift above what WebGL actually delivers.
//
// Case B is the load-bearing one: an opaque crescent is DARKER on average than
// the bright skybox it occludes, so no mean/max test can separate it — only the
// contiguous-lit-component + ring-ratio shape test does.
//
// KNOWN LIMIT (documented, not gated): a bright band crossing the disc but NOT
// the surrounding ring would still read as a body. That geometry is unreachable
// for a full-sky cubemap at a 3° ROI — structure at that angular scale spans the
// disc and the immediately adjacent 1.25-1.55r annulus alike, which is exactly
// what case A2 pins.
//
// Run: node --test Tools/visual-regression/env-matrix-shape.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const probePath = resolve(directory, "probe-env-pass-matrix.mjs");
const probeSource = await readFile(probePath, "utf8");

function extract(name) {
  const begin = `==BEGIN ${name}==`;
  const end = `==END ${name}==`;
  const i = probeSource.indexOf(begin);
  const j = probeSource.indexOf(end);
  assert.ok(i >= 0, `marker ${begin} missing from the probe`);
  assert.ok(j > i, `marker ${end} missing or out of order in the probe`);
  // Start after the marker COMMENT LINE, not just after the marker token, so
  // the trailing text of that comment is not treated as code.
  const bodyStart = probeSource.indexOf("\n", i) + 1;
  return probeSource.slice(bodyStart, j).replace(/\/\/[^\n]*$/, "");
}

// The extracted regions declare `const shapeStatsFromPixels = ...` /
// `function presenceOf(...)`; evaluate them and hand back the bindings.
// eslint-disable-next-line no-new-func -- in-page snippet compiled from source text; that is the probe harness contract
const shapeStatsFromPixels = new Function(
  `${extract("shapeStatsFromPixels")}\nreturn shapeStatsFromPixels;`,
)();
// eslint-disable-next-line no-new-func -- in-page snippet compiled from source text; that is the probe harness contract
const presenceOf = new Function(
  `${extract("presenceOf")}\nreturn presenceOf;`,
)();
// eslint-disable-next-line no-new-func -- in-page snippet compiled from source text; that is the probe harness contract
const evaluateNightSourceContract = new Function(
  `${extract("evaluateNightSourceContract")}\nreturn evaluateNightSourceContract;`,
)();
// eslint-disable-next-line no-new-func -- in-page snippet compiled from source text; that is the probe harness contract
const starCensusFromBand = new Function(
  `${extract("starCensusFromBand")}\nreturn starCensusFromBand;`,
)();

// ── Deterministic PRNG (mulberry32) — no Math.random, so runs are identical ──
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R_DEV = 110; // the moon/sun disc radius at fov 3 deg on a 1280-wide canvas
const HALF = Math.ceil(R_DEV * 1.7);
const SIZE = 2 * HALF + 1;

// Builds one ROI. `body(dx, dy, r)` returns the OPAQUE body luminance at a
// pixel inside the limb, or null when the body is absent/transparent there.
// `radial(r)` supplies a radius-dependent background (a glare halo) instead of
// the flat `background` level.
function buildRoi({
  seed = 1,
  background = 0,
  radial = null,
  band = null,
  stars = 0,
  body = null,
}) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - HALF;
      const dy = y - HALF;
      const r = Math.hypot(dx, dy);
      let l = radial
        ? radial(r) + (rand() - 0.5) * 6
        : background > 0
          ? background + (rand() - 0.5) * 12
          : 0;
      // Diffuse Milky Way band across the whole ROI (disc AND ring alike).
      if (band && Math.abs(dx + dy) < band.halfWidth) {
        l = band.level + (rand() - 0.5) * 10;
      }
      // Sparse bright cubemap stars.
      if (stars > 0 && rand() < stars) {
        l = 120 + rand() * 80;
      }
      // Opaque body occludes everything behind it.
      if (body && r <= R_DEV) {
        const bodyLum = body(dx, dy, r);
        if (bodyLum !== null) {
          l = bodyLum;
        }
      }
      const v = Math.max(0, Math.min(255, Math.round(l)));
      const i = 4 * (y * SIZE + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

const stats = (data) => shapeStatsFromPixels(data, SIZE, SIZE, HALF, R_DEV);
const moonPresent = (s) =>
  presenceOf({ moonROI: s, sunROI: s, sky: null }).moon;
const sunPresent = (s) => presenceOf({ moonROI: s, sunROI: s, sky: null }).sun;

// A daylight crescent: opaque disc, black except the outer ~15% on one side.
// Area fraction of {x > 0.7R} inside the circle is ~0.094 — the pf 0.10-0.20
// day lane. Everything else inside the limb is the unlit (occluding) face.
const crescent = (dx, dy, r) => (dx > 0.7 * R_DEV ? 220 : 3);
// A night gibbous: opaque disc, ~60% lit.
const gibbous = (dx, dy, r) => (dx > -0.2 * R_DEV ? 200 : 4);

const STARFIELD = { seed: 7, background: 18, stars: 0.003 };
const STARFIELD_BAND = {
  seed: 11,
  background: 15,
  stars: 0.003,
  band: { halfWidth: 0.55 * SIZE * 0.5, level: 90 },
};

test("A — hidden body over a TYCHO-like star field reads ABSENT (the D1 bug)", () => {
  const s = stats(buildRoi(STARFIELD));
  assert.equal(moonPresent(s), false);
  // The old absolute test would have fired here: bright stars inside the disc
  // do clear `discMax >= ringMean + 20`. Pin that, so the regression is named.
  assert.ok(
    s.discMax >= s.ringMean + 20,
    "precondition: the ROI really does contain the bright pixels that fooled the old test",
  );
  // Disc and ring sample the same background, which is what the fix keys on.
  assert.ok(s.litFrac < 0.02, `litFrac ${s.litFrac} must stay under the floor`);
});

test("A2 — star field plus a bright band crossing disc AND ring reads ABSENT", () => {
  const s = stats(buildRoi(STARFIELD_BAND));
  assert.equal(moonPresent(s), false);
  // The band raises the ring's own tail, so the threshold rises with it.
  assert.ok(
    s.ringP99 >= 80,
    `ringP99 ${s.ringP99} should track the band level`,
  );
  assert.ok(
    s.litThreshold > 90,
    `litThreshold ${s.litThreshold} should clear the band`,
  );
  // The decisive fact: with NO body present the band alone produces a disc/ring
  // mean step of ~+37 — comfortably past the +20 any mean- or max-based test
  // would use. Absolute luminance cannot separate this case; shape can.
  assert.ok(
    s.discMean >= s.ringMean + 20,
    `no-body mean step ${s.discMean - s.ringMean} should exceed the +20 an absolute test would use`,
  );
  assert.ok(
    s.maxLitComponentPx < 200,
    `band pixels are not a blob: ${s.maxLitComponentPx}`,
  );
});

test("B — daylight crescent over the SAME star field reads PRESENT", () => {
  const s = stats(buildRoi({ ...STARFIELD, body: crescent }));
  assert.equal(moonPresent(s), true);
  assert.ok(
    s.litFrac >= 0.05 && s.litFrac <= 0.15,
    `crescent litFrac ${s.litFrac}`,
  );
  assert.ok(
    s.maxLitComponentPx > 2000,
    `crescent is one blob: ${s.maxLitComponentPx}`,
  );
  assert.ok(
    s.maxLitComponentFrac >= 0.9,
    `and essentially all of it: ${s.maxLitComponentFrac}`,
  );
  // The load-bearing property: because the crescent's own disc is mostly the
  // UNLIT face occluding a bright skybox, the disc/ring MEAN step is ~1 LSB —
  // nowhere near the +20 margin a mean- or max-based test needs. Only the
  // contiguous-component + ring-ratio shape test can see this body.
  assert.ok(
    s.discMean < s.ringMean + 20,
    `crescent disc/ring mean step ${s.discMean - s.ringMean} must stay far below the +20 a mean test needs`,
  );
});

test("B2 — daylight crescent over star field + band reads PRESENT", () => {
  const s = stats(buildRoi({ ...STARFIELD_BAND, body: crescent }));
  assert.equal(moonPresent(s), true);
  // The mirror image of A2, and the reason no absolute test can work in EITHER
  // direction: here a real body is present while its disc is ~20 LSB DARKER
  // than the ring it occludes (the opaque unlit face blocks the bright band).
  assert.ok(
    s.discMean < s.ringMean,
    `present-body disc ${s.discMean} should sit BELOW ring ${s.ringMean}`,
  );
});

test("C — night gibbous over a black sky reads PRESENT", () => {
  const s = stats(buildRoi({ seed: 3, background: 0, body: gibbous }));
  assert.equal(moonPresent(s), true);
  assert.ok(s.litFrac > 0.4, `gibbous litFrac ${s.litFrac}`);
});

test("D — a black frame reads ABSENT (no vacuous pass)", () => {
  const s = stats(buildRoi({ seed: 5, background: 0 }));
  assert.equal(moonPresent(s), false);
  assert.equal(s.litPx, 0);
});

test("E — saturated sun disc with glare flooding the ring reads PRESENT", () => {
  const s = stats(
    buildRoi({ seed: 9, background: 120, body: () => 255 }), // saturated disc, bright glare ring
  );
  assert.equal(sunPresent(s), true);
  assert.ok(s.absLitFrac >= 0.95, `sun absLitFrac ${s.absLitFrac}`);
  // The sun's own glare fills the ring, which is exactly why the sun predicate
  // cannot use the moon's ring-ratio arm.
  assert.ok(s.ringLitFrac > 0.0 || s.ringMean > 100);
});

// D2 — WebGL draws the sun ALPHA-BLENDED: its disc is bright but NOT saturated,
// and its glare drives the surrounding annulus to near-saturation. This is the
// exact profile that made `day sun-only` read gl=false / gpu=true.
test("E2 — alpha-blended sun (bright, non-saturated) over near-saturated glare reads PRESENT", () => {
  const s = stats(
    buildRoi({
      seed: 13,
      // A real sun's glare HALO falls off with radius: ~219 at the inner edge of
      // the 1.25-1.55r annulus down to ~181 at its outer edge. That gives the
      // ring a high P99 (the D2 trap: the bar is set by the tail) while its MEAN
      // still sits well below the disc (which is why the mean arm survives).
      radial: (r) =>
        250 - 100 * Math.min(1, Math.max(0, r / R_DEV - 1.0) / 0.8),
      // Disc bright but alpha-blended — 250 at the core easing to ~217 at the
      // limb, never saturating.
      body: (dx, dy, r) => 250 - 35 * (r / R_DEV),
    }),
  );
  assert.equal(sunPresent(s), true, "the alpha-blended sun must be detected");
  // Pin the D2 mechanism: the ring-relative bar really does climb above most of
  // the disc here, so the OLD sun predicate would have said ABSENT.
  assert.ok(s.ringP99 >= 200, `ringP99 ${s.ringP99} tracks the glare tail`);
  assert.ok(
    s.litThreshold > s.discMean,
    `ring-relative bar ${s.litThreshold} must exceed discMean ${s.discMean} — the self-defeating threshold`,
  );
  assert.ok(
    s.litFrac < 0.5,
    `ring-relative litFrac ${s.litFrac} collapses (this is what broke day sun-only)`,
  );
  // ...while every arm the sun predicate actually uses holds comfortably.
  assert.ok(
    s.discMean >= s.ringMean + 20,
    `mean step ${s.discMean - s.ringMean}`,
  );
  assert.ok(s.discMax >= 200, `discMax ${s.discMax}`);
  assert.ok(s.absLitFrac >= 0.9, `absLitFrac ${s.absLitFrac}`);
  assert.ok(
    s.absMaxComponentFrac >= 0.9,
    `absMaxComponentFrac ${s.absMaxComponentFrac}`,
  );
});

test("E3 — the absolute sun bar does not leak into the MOON predicate", () => {
  // A bright uniform sky (above the sun's fixed bar) with NO body must not read
  // as a moon: the moon stays ring-relative, so disc and ring cancel.
  const s = stats(buildRoi({ seed: 17, background: 210 }));
  assert.equal(moonPresent(s), false);
  assert.ok(
    s.absLitFrac > 0.9,
    `precondition: the field IS above the sun bar (${s.absLitFrac})`,
  );
  // And it is not a sun either — no disc-over-ring step exists.
  assert.equal(sunPresent(s), false);
});

test("F — hidden sun over the star field reads ABSENT", () => {
  const s = stats(buildRoi(STARFIELD));
  assert.equal(sunPresent(s), false);
});

// ── E2: the star census must count STARS, not a lit sky's dither ────────────
//
// The census originally used a whole-band `median + 25` bar with no PROMINENCE
// arm, so on an atmosphere-only NIGHT sky it counted the twilight gradient's
// dither as star sources (expected=false, webgl=true, webgpu=true — parity
// intact, i.e. an instrument artifact, not a render). `SkyAtmosphere.wgsl`
// contains no star/twinkle feature whatsoever, so those points had no
// legitimate source. The census is now the fleet's trust-anchored
// m1PointSourceCensus algorithm (annulus-median background + 1.6x peak ratio).
const BAND_W = 320;
const BAND_H = 160;

// Builds a sky band: uniform `level`, +/-`ditherAmp` LSB of deterministic
// noise, and `starCount` bright isolated peaks at `starLevel`.
function buildBand({
  seed = 21,
  level = 0,
  ditherAmp = 0,
  starCount = 0,
  starLevel = 200,
}) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(BAND_W * BAND_H * 4);
  for (let p = 0; p < BAND_W * BAND_H; p++) {
    const v = Math.max(
      0,
      Math.min(255, Math.round(level + (rand() - 0.5) * 2 * ditherAmp)),
    );
    const i = 4 * p;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  // Well-separated single-pixel peaks (a star's PSF core), inset from the edge
  // so the census's 5 px border never clips them.
  for (let s = 0; s < starCount; s++) {
    const x = 12 + ((s * 37) % (BAND_W - 24));
    const y = 12 + ((s * 53) % (BAND_H - 24));
    const i = 4 * (y * BAND_W + x);
    data[i] = starLevel;
    data[i + 1] = starLevel;
    data[i + 2] = starLevel;
  }
  return data;
}
const censusOf = (cfg) => starCensusFromBand(buildBand(cfg), BAND_W, BAND_H);

test("E2 — a lit, dithered twilight sky censuses ZERO stars", () => {
  // The atmosphere-only night lane: a lit sky with 8-bit dither and no stars.
  for (const level of [30, 60, 120]) {
    const c = censusOf({ level, ditherAmp: 2 });
    assert.equal(
      c.brightPoints,
      0,
      `level ${level} dither must not read as stars`,
    );
  }
  // Even aggressive dither stays under the prominence bar.
  assert.equal(censusOf({ level: 60, ditherAmp: 5 }).brightPoints, 0);
});

test("E2 — real stars are still counted, on black AND over a lit sky", () => {
  assert.equal(censusOf({ starCount: 25, level: 0 }).brightPoints, 25);
  // Over a dithered twilight sky the same stars must survive: prominence is
  // measured against the LOCAL annulus, not an absolute bar.
  assert.equal(
    censusOf({ starCount: 25, level: 60, ditherAmp: 2 }).brightPoints,
    25,
  );
  // A star that fails the 1.6x peak ratio against a bright background is
  // correctly rejected — that is the arm which kills dither.
  assert.equal(
    censusOf({ starCount: 25, level: 150, starLevel: 170 }).brightPoints,
    0,
  );
});

test("E2 — the census is the m1 algorithm, not a re-invention", () => {
  const c = censusOf({ starCount: 5 });
  assert.equal(c.minProminence, 12, "m1's 12/255 threshold on the 0-255 scale");
  assert.equal(c.peakRatio, 1.6, "m1's peakRatio");
});

// ── D3: the night source contract, pinned to MEASURED reference values ──────
//
// The contract's first revision demanded `spritesOnly >= 3` and structurally
// failed the WebGL reference itself: WebGL's catalog star field registers only
// TWO census points at this vantage, because at default brightness the
// Yale-catalog sprites sit below the census bar (pointThreshold = median + 25) —
// the known t3/t5 star-brightness behavior, expected rather than an error.
// These cases hard-code the orchestrator's actual pre-fix measurements so no
// future tightening can drift the expectations back above what WebGL delivers.
// They pin the predicate's SHAPE, not the census output: the E2 census change
// shifts the absolute counts, which is why the floor carries a wide margin and
// why `spritesOnly` is swept rather than asserted at one value.
const MEASURED_PRE_FIX = {
  webgl: { cubemapOnly: 1094, spritesOnly: 2, both: 1094 },
  webgpu: { cubemapOnly: 0, spritesOnly: 2, both: 1094 },
};

test("D3 — the measured PRE-fix reference is SANE and the gate is RED", () => {
  const c = evaluateNightSourceContract(MEASURED_PRE_FIX);
  assert.equal(
    c.referenceOk,
    true,
    "WebGL's own numbers must never read as structural",
  );
  assert.equal(
    c.gateOk,
    false,
    "WebGPU cubemapOnly 0 is the G1F1 kill — must gate RED",
  );
  assert.equal(c.cubemapOnlyRatio_webgpu_over_webgl, 0);
});

test("D3 — spritesOnly = 2 must NOT be able to fail the reference", () => {
  // The exact regression that produced the structural exit. Sweep the sprite
  // count across the whole plausible range: none of it may move referenceOk.
  for (const spritesOnly of [0, 1, 2, 3, 50]) {
    const c = evaluateNightSourceContract({
      webgl: { ...MEASURED_PRE_FIX.webgl, spritesOnly },
      webgpu: { ...MEASURED_PRE_FIX.webgpu, spritesOnly },
    });
    assert.equal(
      c.referenceOk,
      true,
      `spritesOnly ${spritesOnly} must stay informational`,
    );
  }
  // And it is still RECORDED, so the sprite census remains visible evidence.
  const c = evaluateNightSourceContract(MEASURED_PRE_FIX);
  assert.equal(c.spritesOnly_INFORMATIONAL.webgl, 2);
  assert.equal(c.spritesOnly_INFORMATIONAL.webgpu, 2);
});

test("D3 — the expected POST-fix numbers pass the gate", () => {
  const c = evaluateNightSourceContract({
    webgl: MEASURED_PRE_FIX.webgl,
    webgpu: { cubemapOnly: 1094, spritesOnly: 2, both: 1094 },
  });
  assert.equal(c.referenceOk, true);
  assert.equal(c.gateOk, true);
  assert.equal(c.cubemapOnlyRatio_webgpu_over_webgl, 1);
  // A partial recovery still fails: the cubemap must come back, not flicker.
  const partial = evaluateNightSourceContract({
    webgl: MEASURED_PRE_FIX.webgl,
    webgpu: { cubemapOnly: 300, spritesOnly: 2, both: 1094 },
  });
  assert.equal(partial.gateOk, false, "ratio 0.27 is below the 0.5 floor");
});

test("D3 — a genuinely broken reference is STRUCTURAL, not a gate failure", () => {
  const tooFew = evaluateNightSourceContract({
    webgl: { cubemapOnly: 5, spritesOnly: 2, both: 5 },
    webgpu: { cubemapOnly: 5, spritesOnly: 2, both: 5 },
  });
  assert.equal(
    tooFew.referenceOk,
    false,
    "below the census floor — the instrument is wrong",
  );
  // Adding sprites must never REMOVE cubemap sources; that is the ordering claim.
  const wentBackwards = evaluateNightSourceContract({
    webgl: { cubemapOnly: 1094, spritesOnly: 2, both: 900 },
    webgpu: MEASURED_PRE_FIX.webgpu,
  });
  assert.equal(wentBackwards.referenceOk, false);
  // Missing/NaN counts cannot silently pass either.
  const missing = evaluateNightSourceContract({ webgl: {}, webgpu: {} });
  assert.equal(missing.referenceOk, false);
  assert.equal(missing.gateOk, false);
  assert.equal(missing.cubemapOnlyRatio_webgpu_over_webgl, null);
});

test("the extracted regions are self-contained (no closure leaks)", () => {
  // If either region ever grows a reference to an outer binding, `new Function`
  // above would have thrown at construction time; assert the bindings are real
  // functions so a silently-empty extraction cannot pass this file.
  assert.equal(typeof shapeStatsFromPixels, "function");
  assert.equal(typeof presenceOf, "function");
  assert.equal(typeof evaluateNightSourceContract, "function");
  assert.equal(shapeStatsFromPixels.length, 5);
});
