// polyline-multimaterial-verdicts.spec.mjs — AR-754's negative control.
// @purpose Executes probe-polyline-multimaterial's shipped decision functions against the recorded pre-fix numbers for each of the four materials, and proves that removing any ONE material's assertions makes the probe pass a scene that is visibly wrong for that material.
// @status ACTIVE
//
// WHAT AR-754 ACTUALLY ASKS FOR. Not "the probe is extended" — that is a diff,
// and a diff certifies itself. The acceptance is:
//
//   "Removing any one material's assertion makes the probe exit zero on a
//    scene that is visibly wrong — i.e. the extension is proven by its own
//    negative control."
//
// and the lane card adds: for EACH of the four materials, not once. So section
// C below runs, per material:
//
//   1. the shipped verdicts against a scene where THAT material is broken by
//      the numbers the bug actually produced — and requires RED;
//   2. the shipped verdicts with that one material's assertions REMOVED FROM
//      THE MODULE SOURCE, against the same broken scene — and requires GREEN.
//
// Step 2 is the control. It cuts the real file on the marker pair that
// delimits each material's block and imports the mutated text, so what is
// proven is that the SHIPPED assertions carry the load — not that a
// spec-supplied flag was honoured. A parameter-shaped control (section B) is
// kept alongside it because it localises WHICH checks fired, but it is the
// weaker of the two and is not the one the row is satisfied by.
//
// THE FIXTURES ARE THE RECORDED DEFECT, NOT AN INVENTED ONE. The glow leg uses
// the 3.3x lit-pixel ratio the closure record itself reports; the dash leg uses
// the runsPerRow 1-vs-15 collapse from the same record. Arrow and outline had
// no recorded numbers because the old guard never instantiated them, so their
// fixtures model the same collapse-to-Color failure: the arrow head disappears,
// and the outline's second colour is simply absent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEVICE_SCALE_FACTORS,
  GATED_MATERIALS,
  MATERIALS,
  allChecksPass,
  buildChecks,
  materialChecks,
} from "./lib/polyline-multimaterial-verdicts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS_PATH = path.join(
  here,
  "lib",
  "polyline-multimaterial-verdicts.mjs",
);

/**
 * One hue's measurements.
 *
 * @param {number} colored Lit pixels.
 * @param {number} runs Colored runs.
 * @param {number} coloredRows Rows carrying the hue.
 * @param {number} fwhm Cross-section width at half maximum.
 * @returns {object} The measurement.
 */
function hue(colored, runs, coloredRows, fwhm) {
  return {
    colored,
    runs,
    coloredRows,
    fwhm,
    runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
  };
}

/**
 * A backend's full measurement set at one device scale factor.
 *
 * @param {number} scale Area scale (1 at DPR 1, 4 at DPR 2).
 * @param {number} linear Linear scale (1 at DPR 1, 2 at DPR 2).
 * @returns {object} Per-hue measurements.
 */
function healthyCapture(scale, linear) {
  return {
    solid: hue(4800 * scale, 12 * linear, 12 * linear, 12 * linear),
    dash: hue(2400 * scale, 180 * linear, 12 * linear, 12 * linear),
    glow: hue(6000 * scale, 40 * linear, 40 * linear, 14 * linear),
    arrow: hue(9000 * scale, 26 * linear, 26 * linear, 24 * linear),
    outline: hue(3600 * scale, 10 * linear, 10 * linear, 10 * linear),
    outlineEdge: hue(4200 * scale, 32 * linear, 16 * linear, 6 * linear),
  };
}

/**
 * A run where every material is at parity on both backends.
 *
 * @returns {Array<object>} One leg per device scale factor.
 */
function healthyLegs() {
  return DEVICE_SCALE_FACTORS.map((deviceScaleFactor) => {
    const linear = deviceScaleFactor;
    const scale = deviceScaleFactor * deviceScaleFactor;
    return {
      deviceScaleFactor,
      webgl: healthyCapture(scale, linear),
      webgpu: healthyCapture(scale, linear),
      gateErrors: 0,
      deviceLost: null,
    };
  });
}

/**
 * The recorded failure shape for one material, applied to the WebGPU side of
 * every leg. Each one is the collapse-to-Color the multi-group path produced.
 *
 * @param {string} material Which material to break.
 * @returns {Array<object>} Legs with that material broken on WebGPU.
 */
function legsWithDefect(material) {
  const legs = healthyLegs();
  for (const leg of legs) {
    const linear = leg.deviceScaleFactor;
    const scale = linear * linear;
    switch (material) {
      case "dash":
        // The recorded collapse: runsPerRow 1 against WebGL's 15.
        leg.webgpu.dash = hue(
          2400 * scale,
          12 * linear,
          12 * linear,
          12 * linear,
        );
        break;
      case "glow":
        // The recorded 3.3x lit pixels, and a band instead of a taper.
        leg.webgpu.glow = hue(
          Math.round(6000 * scale * 3.3),
          40 * linear,
          40 * linear,
          42 * linear,
        );
        break;
      case "arrow":
        // The head is gone; only the shaft's pixels remain.
        leg.webgpu.arrow = hue(
          Math.round(9000 * scale * 0.35),
          26 * linear,
          26 * linear,
          12 * linear,
        );
        break;
      case "outline":
        // The core still draws; the outline colour is simply never emitted.
        leg.webgpu.outlineEdge = hue(0, 0, 0, 0);
        break;
      default:
        throw new Error(`no defect fixture for "${material}"`);
    }
  }
  return legs;
}

/**
 * Removes ONE material's assertion block from the shipped module source,
 * leaving the case label so the switch still dispatches. This is the mutation
 * AR-754's negative control is defined over.
 *
 * @param {string} source The module source.
 * @param {string} material Which material's assertions to remove.
 * @returns {string} The mutated source.
 */
export function removeMaterialAssertions(source, material) {
  const open = `/* material-assertions:${material} */`;
  const close = `/* end-material-assertions:${material} */`;
  const from = source.indexOf(open);
  const to = source.indexOf(close);
  assert.ok(
    from >= 0 && to > from,
    `no marker pair for "${material}" — the mutation seam is gone and this control proves nothing`,
  );
  return (
    source.slice(0, from) +
    `case "${material}": {\n      break;\n    }\n    ` +
    source.slice(to + close.length)
  );
}

/**
 * @param {string} source Module source to load.
 * @returns {Promise<object>} The module's exports.
 */
async function importSource(source) {
  return import(
    `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`
  );
}

const verdictsSource = fs.readFileSync(VERDICTS_PATH, "utf8");

// ---------------------------------------------------------------------------
// A. The scene the probe measures, and the shape of a healthy run.
// ---------------------------------------------------------------------------

test("A1: the probe instantiates all four gated materials and a Color anchor", async () => {
  const probe = fs.readFileSync(
    path.join(here, "probe-polyline-multimaterial.mjs"),
    "utf8",
  );
  for (const type of [
    "PolylineDash",
    "PolylineGlow",
    "PolylineArrow",
    "PolylineOutline",
  ]) {
    assert.ok(
      probe.includes(`Material.fromType("${type}"`),
      `the scene never builds a ${type} polyline, so its group is not in the multi-material loop`,
    );
  }
});

test("A2: the run repeats at a device scale factor other than 1", () => {
  assert.ok(
    DEVICE_SCALE_FACTORS.includes(1) &&
      DEVICE_SCALE_FACTORS.some((d) => d !== 1),
    `AR-754 requires a DPR != 1 leg; got ${DEVICE_SCALE_FACTORS.join(",")}`,
  );
});

test("A3: a run at parity on every material passes", () => {
  assert.equal(allChecksPass(healthyLegs()), true);
});

test("A4: probe-path-portions.mjs is absent, as the row states", () => {
  // The closure record names it as the second standing guard. Pinned here so
  // the ledger correction cannot silently rot back.
  assert.equal(
    fs.existsSync(path.join(here, "probe-path-portions.mjs")),
    false,
    "probe-path-portions.mjs now exists — the ledger amendment must be revisited",
  );
});

// ---------------------------------------------------------------------------
// B. Each material's defect is caught, and caught by ITS OWN checks.
// ---------------------------------------------------------------------------

for (const material of GATED_MATERIALS) {
  test(`B1 ${material}: the recorded defect makes the probe RED`, () => {
    assert.equal(
      allChecksPass(legsWithDefect(material)),
      false,
      `a broken ${material} passed every check — the probe would have closed the bug again`,
    );
  });

  test(`B2 ${material}: only ${material}'s checks fire, in BOTH device scale legs`, () => {
    const failing = buildChecks(legsWithDefect(material)).filter(
      (c) => !c.pass,
    );
    assert.ok(failing.length > 0, "no check fired");
    const others = failing.filter((c) => c.material !== material);
    assert.deepEqual(
      others.map((c) => c.label),
      [],
      `a broken ${material} also tripped another material's checks; the hues are not separable`,
    );
    for (const scale of DEVICE_SCALE_FACTORS) {
      assert.ok(
        failing.some((c) => c.label.includes(`dpr${scale}`)),
        `no check fired in the dpr${scale} leg`,
      );
    }
  });

  test(`B3 ${material}: dropping it from the asserted set makes the run GREEN`, () => {
    const others = MATERIALS.filter((m) => m !== material);
    assert.equal(
      allChecksPass(legsWithDefect(material), others),
      true,
      `${material} is still being asserted from somewhere else; the control is not isolating it`,
    );
  });
}

// ---------------------------------------------------------------------------
// C. THE NEGATIVE CONTROL — over the shipped source, once per material.
// ---------------------------------------------------------------------------

for (const material of GATED_MATERIALS) {
  test(`C1 ${material}: removing its assertions FROM THE MODULE makes the probe exit zero on a visibly wrong scene`, async () => {
    const legs = legsWithDefect(material);

    // The shipped module rejects this scene.
    assert.equal(
      allChecksPass(legs),
      false,
      `precondition: the shipped verdicts must reject a broken ${material}`,
    );

    const mutated = removeMaterialAssertions(verdictsSource, material);
    assert.notEqual(
      mutated,
      verdictsSource,
      `the mutation changed nothing for ${material}`,
    );
    const mutant = await importSource(mutated);

    // And with only that material's block gone, it accepts it.
    assert.equal(
      mutant.allChecksPass(legs),
      true,
      `removing ${material}'s assertions did NOT make the probe pass the broken scene — something else is still asserting it, so the row's control is not satisfied`,
    );
  });

  test(`C2 ${material}: the mutation removes assertions rather than the whole case`, async () => {
    const mutant = await importSource(
      removeMaterialAssertions(verdictsSource, material),
    );
    const leg = healthyLegs()[0];
    const before = materialChecks(material, leg).length;
    const after = mutant.materialChecks(material, leg).length;
    assert.ok(
      after < before,
      `${material}: mutant kept ${after} of ${before} checks — nothing was removed`,
    );
    assert.ok(
      after > 0,
      `${material}: the mutant lost the whole case, so C1 would pass for the wrong reason`,
    );
    // The switch must still dispatch every material, or the mutant is broken
    // rather than weakened.
    for (const other of MATERIALS) {
      assert.doesNotThrow(() => mutant.materialChecks(other, leg));
    }
  });
}

test("C3: removing a material's assertions does NOT hide another material's defect", () => {
  // The control must be surgical: with glow's assertions gone, a broken dash is
  // still caught. Otherwise C1's green could come from a blanket failure.
  const withoutGlow = MATERIALS.filter((m) => m !== "glow");
  assert.equal(allChecksPass(legsWithDefect("dash"), withoutGlow), false);
  const withoutDash = MATERIALS.filter((m) => m !== "dash");
  assert.equal(allChecksPass(legsWithDefect("glow"), withoutDash), false);
});

// ---------------------------------------------------------------------------
// D. The old guard's weaknesses, pinned so they cannot come back.
// ---------------------------------------------------------------------------

test("D1: glow is not gated by a bare lit-pixel threshold", () => {
  // The guard this replaces asserted glow with `colored > 200`. The recorded
  // 3.3x defect clears that threshold comfortably, which is exactly why the
  // bug closed with a guard that could not see it.
  const legs = legsWithDefect("glow");
  for (const leg of legs) {
    assert.ok(
      leg.webgpu.glow.colored > 200,
      "fixture does not reproduce the old guard's blind spot",
    );
  }
  assert.equal(allChecksPass(legs), false);
});

test("D2: a glow whose count is at parity but whose profile is a band is still caught", () => {
  // The FWHM half of the glow gate, isolated: same pixel count, wrong shape.
  const legs = healthyLegs();
  for (const leg of legs) {
    const linear = leg.deviceScaleFactor;
    leg.webgpu.glow = {
      ...leg.webgpu.glow,
      fwhm: 40 * linear,
    };
  }
  assert.equal(
    allChecksPass(legs),
    false,
    "a count-at-parity band passed — the FWHM gate is inert",
  );
});

test("D3: two materials at zero on both backends do not read as agreement", () => {
  // A ratio of 0/0 must not be mistaken for 1. Every material carries a
  // minimum-pixel check ahead of its ratio for exactly this reason.
  const legs = healthyLegs();
  for (const leg of legs) {
    leg.webgl.arrow = hue(0, 0, 0, 0);
    leg.webgpu.arrow = hue(0, 0, 0, 0);
  }
  assert.equal(allChecksPass(legs), false);
});
