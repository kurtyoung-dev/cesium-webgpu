/**
 * @purpose Synthetic discs and reductions whose ring families are known by construction, and the banked dense-deck reductions, shared by the ring-family behaviour spec and its mutant spec.
 * @status ACTIVE
 *
 * THE GEOMETRY. A 720 px frame, a disc of radius 340 about (360.3, 356.8), a
 * window of rho 30 to 230 about the family centre and a centre search of
 * 36 px. Planted families sit 33 px from the stated disc centre, as the
 * orbital family sits 36 to 40 px from its disc, at the measured orbital ring
 * RMS of 0.0435 in luminance unless a recipe says otherwise.
 *
 * Every frame is built from a recipe by key and measured once per process, so
 * a behaviour case and the mutant that guards it measure the same pixels.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIT_THRESHOLD,
  ringFamily,
  ringFamilyFromProfile,
} from "./metrics/radial-banding.mjs";
import { syntheticFractionalBrownianField } from "./metrics/spectral-slope.mjs";
import RIG from "../rigs/orbital-fulldisc-6608km.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TILE = 256;
const FAMILY_FRAME = 720;
const FAMILY_DISC = Object.freeze({
  centreX: 360.3,
  centreY: 356.8,
  discRadiusPixels: 340,
  visiblePeriodBand: RIG.disc.visiblePeriodBand,
});
const FAMILY_CENTRE = Object.freeze({ x: 390.9, y: 369.1 });
// A second centre 26 px west of the disc centre, 57 px from the first.
const SECOND_CENTRE = Object.freeze({ x: 335.3, y: 350.0 });
const FAMILY_WINDOW = Object.freeze({
  rhoMinPx: 30,
  rhoMaxPx: 230,
  centreSearchPx: 36,
});
// The orbital family's measured ring RMS in luminance, planted as a sinusoid.
const PLANTED_RMS = 0.0435;
// The per-pixel variance of the banked dense-deck frame over its disc.
const MEASURED_DECK_VARIANCE = 4.0035e-2;
const FAMILY_LAWS = Object.freeze({
  quadratic: { exponent: 2, quantum: 1000 },
  linear: { exponent: 1, quantum: 14 },
  logarithmic: { exponent: 0, quantum: 0.13333 },
});

function boxCoxOf(rho, exponent) {
  return exponent === 0 ? Math.log(rho) : (rho ** exponent - 1) / exponent;
}
function plantedPeriod(law, rho) {
  const { exponent, quantum } = FAMILY_LAWS[law];
  return quantum / rho ** (exponent - 1);
}
const lawPhase = (law) => (rho) =>
  (2 * Math.PI * boxCoxOf(rho, FAMILY_LAWS[law].exponent)) /
  FAMILY_LAWS[law].quantum;
const linearPhase = (periodPx) => (rho) => (2 * Math.PI * rho) / periodPx;
// P = quantum / rho: a quadratic law with its quantum stated.
const quadraticPhase = (quantum) => (rho) =>
  (2 * Math.PI * boxCoxOf(rho, 2)) / quantum;

const FBM = new Map();

/** A seeded fBm tile normalized into [0, 1]. */
function fbmTile(seed) {
  if (!FBM.has(seed)) {
    const raw = syntheticFractionalBrownianField({
      width: TILE,
      height: TILE,
      slope: -5 / 3,
      seed,
    });
    let low = Infinity;
    let high = -Infinity;
    for (const value of raw) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    FBM.set(
      seed,
      Float64Array.from(raw, (value) => (value - low) / (high - low)),
    );
  }
  return FBM.get(seed);
}

/** The tile repeated; DFT synthesis is periodic, so the seams vanish. */
function tiled(seed) {
  const tile = fbmTile(seed);
  return (x, y) => tile[(y % TILE) * TILE + (x % TILE)];
}
function tileQuantile(seed, fraction) {
  const sorted = Float64Array.from(fbmTile(seed)).sort();
  return sorted[Math.floor(fraction * (sorted.length - 1))];
}

function buildField(width, valueAt) {
  const data = new Float64Array(width * width);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = valueAt(x, y);
    }
  }
  return { width, height: width, data };
}

const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * Rings about a centre, as the luminance they add to an annulus mean: a
 * sinusoid of RMS `rms`, or a pulse train of lit fraction `duty` scaled to
 * the same RMS, optionally only within `sector` (half-angle `half` about the
 * direction `towards`, in radians).
 */
function ring(
  centre,
  phaseAt,
  rms = PLANTED_RMS,
  { duty = null, sector = null } = {},
) {
  return (x, y) => {
    const dx = x + 0.5 - centre.x;
    const dy = y + 0.5 - centre.y;
    if (sector !== null) {
      const off = Math.atan2(dy, dx) - sector.towards;
      if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > sector.half) {
        return 0;
      }
    }
    const phase = phaseAt(Math.hypot(dx, dy));
    if (duty === null) {
      return rms * Math.SQRT2 * Math.sin(phase);
    }
    const lit = (((phase / (2 * Math.PI)) % 1) + 1) % 1 < duty ? 1 : 0;
    return (rms * (lit - duty)) / Math.sqrt(duty * (1 - duty));
  };
}

/**
 * The four regimes of the acceptance, one family per frame. `black`: rings on
 * nothing. `sparse`: the rings ARE the deck, lit bands of duty 0.11 — the
 * checked-in sparse golden's regime. `dense`: a deck lighting 72 % of the disc
 * under a smooth limb brightening. `dense-fbm`: that deck textured to the
 * banked dense frame's per-pixel variance. The planted wave is divided by the
 * deck's duty so every annulus mean carries the same amplitude whatever the
 * background.
 */
function familyField(
  regime,
  law,
  phaseAt = law === null ? null : lawPhase(law),
) {
  return deckField(`${regime}:${law}`, {
    regime,
    rings: phaseAt === null ? [] : [ring(FAMILY_CENTRE, phaseAt)],
    sparsePhase: phaseAt,
  });
}

const FIELDS = new Map();

/**
 * One synthetic disc. `regime` as for {@link familyField}, or `uniform`: a
 * disc lit at 0.4 everywhere with seeded white noise of `sigma`. `rings` add
 * their luminance to every lit pixel; `artifact(x, y)` adds screen-space
 * structure that is not a ring family; `shade(x, y)` multiplies.
 */
function deckField(
  key,
  {
    regime,
    rings = [],
    sparsePhase = null,
    sigma = 0,
    artifact = null,
    shade = null,
  },
) {
  if (FIELDS.has(key)) {
    return FIELDS.get(key);
  }
  const coverage = tiled(4);
  const texture = tiled(5);
  const denseLevel = tileQuantile(4, 0.28);
  const sparseLevel = tileQuantile(4, 0.89);
  const { centreX, centreY, discRadiusPixels } = FAMILY_DISC;
  let seed = 12345;
  const uniform = () =>
    (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = () =>
    Math.sqrt(-2 * Math.log(uniform() + 1e-12)) *
    Math.cos(2 * Math.PI * uniform());
  const field = buildField(FAMILY_FRAME, (x, y) => {
    const discRho = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
    if (discRho > discRadiusPixels) {
      return 0;
    }
    const wave = rings.reduce((sum, at) => sum + at(x, y), 0);
    const limb = 0.8 + 0.4 * (discRho / discRadiusPixels) ** 2;
    let value;
    if (regime === "black") {
      value = rings.length === 0 ? 0 : PLANTED_RMS * Math.SQRT2 + wave;
    } else if (regime === "sparse") {
      const rho = Math.hypot(
        x + 0.5 - FAMILY_CENTRE.x,
        y + 0.5 - FAMILY_CENTRE.y,
      );
      const lit =
        sparsePhase === null
          ? coverage(x, y) > sparseLevel
          : (((sparsePhase(rho) / (2 * Math.PI)) % 1) + 1) % 1 < 0.11;
      value = lit ? (0.35 + 0.3 * texture(x, y)) * limb : 0;
    } else if (regime === "uniform") {
      value = clamp(0.4 + wave + sigma * gauss());
    } else {
      const deck =
        regime === "dense"
          ? 0.3 * limb
          : (0.3 + 1.35 * (texture(x, y) - 0.5)) * limb;
      value = coverage(x, y) > denseLevel ? clamp(deck + wave / 0.72) : 0;
    }
    if (artifact !== null && value > 0) {
      value = clamp(value + artifact(x, y));
    }
    return shade === null ? value : value * shade(x, y);
  });
  FIELDS.set(key, field);
  return field;
}

const RESULTS = new Map();

/** `ringFamily` over one synthetic frame, measured once and shared by cases. */
function measured(key) {
  if (!RESULTS.has(key)) {
    RESULTS.set(key, ringFamily(frame(key), FAMILY_DISC, FAMILY_WINDOW));
  }
  return RESULTS.get(key);
}
function familyResult(regime, law, phaseAt) {
  RECIPES[`${regime}:${law}`] ??= () => familyField(regime, law, phaseAt);
  return measured(`${regime}:${law}`);
}

const STATED = Object.freeze({
  x: FAMILY_DISC.centreX,
  y: FAMILY_DISC.centreY,
});
// The family 2 px past a 36 px search, along the planted family's direction.
const OUTSIDE = (() => {
  const scale =
    38 / Math.hypot(FAMILY_CENTRE.x - STATED.x, FAMILY_CENTRE.y - STATED.y);
  return Object.freeze({
    x: STATED.x + scale * (FAMILY_CENTRE.x - STATED.x),
    y: STATED.y + scale * (FAMILY_CENTRE.y - STATED.y),
  });
})();

// A second family 40 px from the stated centre towards SECOND_CENTRE: 4 px
// past the 36 px search, so the further-centre search stops at its edge.
const PAST_SECOND = (() => {
  const scale =
    40 / Math.hypot(SECOND_CENTRE.x - STATED.x, SECOND_CENTRE.y - STATED.y);
  return Object.freeze({
    x: STATED.x + scale * (SECOND_CENTRE.x - STATED.x),
    y: STATED.y + scale * (SECOND_CENTRE.y - STATED.y),
  });
})();

/** Two plane waves along the axes, each of amplitude `amplitude`. */
const plaid = (periodPx, amplitude) => (x, y) =>
  amplitude *
  (Math.cos((2 * Math.PI * (x + 0.5)) / periodPx) +
    Math.cos((2 * Math.PI * (y + 0.5)) / periodPx));
// Three 12 px waves 60 degrees apart, turned 7 degrees off the axes.
const hexagonal = (x, y) =>
  [0, 1, 2].reduce((sum, k) => {
    const angle = 0.1222 + (k * Math.PI) / 3;
    const along =
      Math.cos(angle) * (x + 0.5 - 360) + Math.sin(angle) * (y + 0.5 - 357);
    return sum + 0.09 * Math.cos((2 * Math.PI * along) / 12);
  }, 0);

/**
 * Screen-space lattices strong enough to clear the SNR threshold and the
 * amplitude floor: only the concentricity test can decline them.
 */
const LATTICES = Object.freeze([
  "plaid 24 0.2",
  "plaid 12 0.1",
  "plaid 16 0.1",
  "plaid 24 0.1",
  "hexagonal",
  "checkerboard 0.3",
]);

/** Every synthetic frame a case measures, by key, so any case can rebuild it. */
const RECIPES = {
  "chirp-4000": {
    regime: "dense",
    rings: [ring(FAMILY_CENTRE, quadraticPhase(4000))],
  },
  "same-centre": {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, quadraticPhase(1000)),
      ring(FAMILY_CENTRE, linearPhase(9)),
    ],
  },
  "two-centres": {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, quadraticPhase(1000)),
      ring(SECOND_CENTRE, linearPhase(9)),
    ],
  },
  "beside-2": {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, quadraticPhase(1000)),
      ring(FAMILY_CENTRE, linearPhase(2), 0.06),
    ],
  },
  "beside-50": {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, quadraticPhase(1000)),
      ring(FAMILY_CENTRE, linearPhase(50), 0.06),
    ],
  },
  "duty-25": {
    regime: "dense-fbm",
    rings: [ring(FAMILY_CENTRE, linearPhase(25), PLANTED_RMS, { duty: 0.2 })],
  },
  "duty-36": {
    regime: "dense-fbm",
    rings: [ring(FAMILY_CENTRE, linearPhase(36), PLANTED_RMS, { duty: 0.2 })],
  },
  stripes: {
    regime: "uniform",
    sigma: 0.02,
    artifact: (x) => 0.03 * Math.sin((2 * Math.PI * x) / 12),
  },
  checkerboard: {
    regime: "uniform",
    sigma: 0.02,
    artifact: (x, y) => ((x + y) % 2 === 0 ? 0.03 : -0.03),
  },
  "deck checkerboard": {
    regime: "dense",
    artifact: (x, y) => ((x + y) % 2 === 0 ? 0.15 : -0.15),
  },
  vignette: {
    regime: "uniform",
    shade: (x, y) =>
      1.25 *
      Math.cos(Math.atan(Math.hypot(x + 0.5 - 400, y + 0.5 - 380) / 500)) ** 4,
  },
  faint: {
    regime: "black",
    rings: [ring(FAMILY_CENTRE, quadraticPhase(1000), 0.005)],
  },
  sector: {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, linearPhase(12), 4 * PLANTED_RMS, {
        sector: { towards: 0, half: Math.PI / 4 },
      }),
    ],
  },
  outside: { regime: "dense", rings: [ring(OUTSIDE, linearPhase(30))] },
  // 1.4 px folds to 3.5 px at one-pixel bins. At the stated centre, so the
  // search measures the fold about the family's own centre.
  alias: {
    regime: "dense",
    rings: [ring(STATED, linearPhase(1.4), 2 * PLANTED_RMS)],
  },
  "past-fastest": {
    regime: "black",
    rings: [ring(FAMILY_CENTRE, linearPhase(1.22), 0.3)],
  },
  "past-second": {
    regime: "dense",
    rings: [
      ring(FAMILY_CENTRE, quadraticPhase(1000)),
      ring(PAST_SECOND, linearPhase(30)),
    ],
  },
  "plaid 24 0.2": { regime: "uniform", sigma: 0.02, artifact: plaid(24, 0.2) },
  "plaid 12 0.1": { regime: "uniform", sigma: 0.02, artifact: plaid(12, 0.1) },
  "plaid 16 0.1": { regime: "uniform", sigma: 0.02, artifact: plaid(16, 0.1) },
  "plaid 24 0.1": { regime: "uniform", sigma: 0.02, artifact: plaid(24, 0.1) },
  hexagonal: { regime: "uniform", sigma: 0.02, artifact: hexagonal },
  "checkerboard 0.3": {
    regime: "uniform",
    sigma: 0.02,
    artifact: (x, y) => ((x + y) % 2 === 0 ? 0.3 : -0.3),
  },
};

/** The synthetic frame a key names, built once. */
function frame(key) {
  const recipe = RECIPES[key];
  if (recipe === undefined) {
    throw new Error(`no recipe for ${key}`);
  }
  return typeof recipe === "function" ? recipe() : deckField(key, recipe);
}

/** Lit fraction and per-pixel variance over the synthetic disc. */
function discStatistics(field) {
  let count = 0;
  let lit = 0;
  let sum = 0;
  let squares = 0;
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const inside =
        Math.hypot(
          x + 0.5 - FAMILY_DISC.centreX,
          y + 0.5 - FAMILY_DISC.centreY,
        ) <= FAMILY_DISC.discRadiusPixels;
      if (inside) {
        const value = field.data[y * field.width + x];
        count++;
        lit += value > DEFAULT_LIT_THRESHOLD ? 1 : 0;
        sum += value;
        squares += value * value;
      }
    }
  }
  return { duty: lit / count, variance: squares / count - (sum / count) ** 2 };
}

function distance(point, to = FAMILY_CENTRE) {
  return Math.hypot(point.x - to.x, point.y - to.y);
}

const RADII = Object.freeze({
  atRhoMin: FAMILY_WINDOW.rhoMinPx,
  atMid: Math.sqrt(FAMILY_WINDOW.rhoMinPx * FAMILY_WINDOW.rhoMaxPx),
  atRhoMax: FAMILY_WINDOW.rhoMaxPx,
});

function withinPercent(value, truth, percent) {
  return Math.abs(value / truth - 1) < percent / 100;
}

const DENSE = JSON.parse(
  readFileSync(
    path.join(HERE, "..", "fixtures", "radial-banding-dense-deck.golden.json"),
    "utf8",
  ),
);
const M0 = DENSE.frames.find((frame) => frame.id === "M0");

/** A banked reduction with concentric rings added about its own centre. */
function withRings(profile, periodPx, rms) {
  const add = (sums, counts) =>
    sums.map(
      (sum, bin) =>
        sum +
        counts[bin] *
          rms *
          Math.SQRT2 *
          Math.sin((2 * Math.PI * (bin + 0.5)) / periodPx),
    );
  return {
    ...profile,
    sums: add(profile.sums, profile.counts),
    octantSums: profile.octantSums.map((row, k) =>
      add(row, profile.octantCounts[k]),
    ),
  };
}

/**
 * A reduction on the rig's window with rings written straight into its
 * annulus sums: a flat 0.3 deck plus `wave(rho)`, over M0's real bin and
 * octant counts, with seeded per-pixel noise of 0.1. Band-edge questions on
 * the rig's own window are asked here without a 2048 px frame.
 */
function riggedReduction(wave) {
  let seed = 7;
  const uniform = () =>
    (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = () =>
    Math.sqrt(-2 * Math.log(uniform() + 1e-12)) *
    Math.cos(2 * Math.PI * uniform());
  const octantSums = M0.profile.octantCounts.map((row) =>
    row.map(
      (count, bin) =>
        count * (0.3 + wave(bin + 0.5)) + 0.1 * Math.sqrt(count) * gauss(),
    ),
  );
  return {
    centreX: M0.profile.centreX,
    centreY: M0.profile.centreY,
    binPx: 1,
    sums: M0.profile.counts.map((_, bin) =>
      octantSums.reduce((sum, row) => sum + row[bin], 0),
    ),
    counts: M0.profile.counts,
    octantSums,
    octantCounts: M0.profile.octantCounts,
  };
}
const sinusoid = (periodPx, rms) => (rho) =>
  rms * Math.SQRT2 * Math.sin((2 * Math.PI * rho) / periodPx);
const pulseTrain = (periodPx, duty, rms) => (rho) => {
  const lit = (((rho / periodPx) % 1) + 1) % 1 < duty ? 1 : 0;
  return (rms * (lit - duty)) / Math.sqrt(duty * (1 - duty));
};
// P = 6800 / rho: 170 px at rho 40, 17 px at rho 400.
const chirp6800 = (rho) =>
  PLANTED_RMS * Math.SQRT2 * Math.sin((2 * Math.PI * boxCoxOf(rho, 2)) / 6800);
const RIGGED = {
  "slow-90": riggedReduction(sinusoid(90, PLANTED_RMS)),
  "past-reach-150": riggedReduction(sinusoid(150, 0.2)),
  "pulse-130": riggedReduction(pulseTrain(130, 0.2, 0.1)),
  "chirp-6800": riggedReduction(chirp6800),
};
const rigged = (key, metric = { ringFamilyFromProfile }) =>
  metric.ringFamilyFromProfile(RIGGED[key], RIG.disc, DENSE.options);

export {
  DENSE,
  FAMILY_CENTRE,
  FAMILY_DISC,
  FAMILY_WINDOW,
  LATTICES,
  M0,
  MEASURED_DECK_VARIANCE,
  PAST_SECOND,
  PLANTED_RMS,
  RADII,
  SECOND_CENTRE,
  discStatistics,
  distance,
  familyField,
  familyResult,
  frame,
  linearPhase,
  measured,
  plantedPeriod,
  rigged,
  withRings,
  withinPercent,
};
