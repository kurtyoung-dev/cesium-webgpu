// polyline-multimaterial-verdicts.mjs — AR-754's decision functions.
// @purpose The pass/fail logic of probe-polyline-multimaterial.mjs, pure over measurements and free of imports, so a browser-free spec can execute it against recorded defect numbers and against its own mutation.
// @status ACTIVE
//
// WHY THIS IS A SEPARATE MODULE. AR-754's acceptance is not "the probe passes";
// it is "removing any ONE material's assertion makes the probe exit zero on a
// scene that is visibly wrong" — for each of the four materials. Proving that
// means running the SHIPPED decision logic with one material's block removed,
// and a module with no imports can be mutated as text and imported from a
// `data:` URL, which a file with relative imports cannot. So the decision
// functions live here and the probe consumes them.
//
// Every material's block below is delimited by a marker pair. The markers are
// the mutation seam the spec cuts on; they are load-bearing, not decoration.

/** The device pixel ratios the run repeats at. AR-754 requires DPR != 1. */
export const DEVICE_SCALE_FACTORS = Object.freeze([1, 2]);

/** Every hue measured. `solid` is the scene anchor, not a subject. */
export const MATERIALS = Object.freeze([
  "solid",
  "dash",
  "glow",
  "arrow",
  "outline",
]);

/** The four materials AR-754's acceptance names. */
export const GATED_MATERIALS = Object.freeze([
  "dash",
  "glow",
  "arrow",
  "outline",
]);

/** Ratio band for a lit-pixel or run-count comparison. */
export const RATIO_BAND = Object.freeze({ low: 0.75, high: 1.25 });

/** Ratio band for the glow cross-section width. */
export const FWHM_BAND = Object.freeze({ low: 0.8, high: 1.2 });

/**
 * Fraction of its own bounding box that the arrow head fills.
 * `PolylineArrowMaterial.glsl` cuts the head with two half-planes meeting at
 * the tip, so a correct head is a triangle and fills ~0.5. A head that paints
 * as a filled rectangle fills ~0.9 — measured 0.892 on WebGPU and 0.548 on
 * WebGL in Éowyn's job-11 leg 5, on the same run whose lit-pixel ratio was
 * 1.145 and inside the count band. The upper bound is what a count cannot see.
 */
export const HEAD_FILL_BAND = Object.freeze({ low: 0.35, high: 0.7 });

/** Ratio band for the head fill fraction and the head's length in pixels. */
export const HEAD_RATIO_BAND = Object.freeze({ low: 0.8, high: 1.25 });

/** A material must clear this many pixels on a backend before a ratio means anything. */
export const MINIMUM_LIT_PIXELS = 200;

/**
 * @param {number|null} value The ratio.
 * @param {{low: number, high: number}} band Acceptable range.
 * @returns {boolean} Whether the ratio is inside the band.
 */
export function withinBand(value, band) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= band.low &&
    value <= band.high
  );
}

/**
 * @param {object|undefined} webgl WebGL measurement for one hue.
 * @param {object|undefined} webgpu WebGPU measurement for one hue.
 * @returns {number|null} WebGPU / WebGL lit-pixel ratio, or null.
 */
export function litRatio(webgl, webgpu) {
  if (!webgl || !webgpu || !(webgl.colored > 0)) {
    return null;
  }
  return webgpu.colored / webgl.colored;
}

/**
 * @param {number|null|undefined} value A ratio that may be absent.
 * @returns {string} A printable form.
 */
function show(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(3)
    : "n/a";
}

/**
 * The checks for ONE material in ONE leg.
 *
 * @param {string} material Material id.
 * @param {object} leg One `{deviceScaleFactor, webgl, webgpu}` leg.
 * @returns {Array<{label: string, pass: boolean}>} The checks.
 */
export function materialChecks(material, leg) {
  const dpr = leg.deviceScaleFactor;
  const gl = leg.webgl ? leg.webgl[material] : undefined;
  const gpu = leg.webgpu ? leg.webgpu[material] : undefined;
  const checks = [];
  const tag = `[${material}@dpr${dpr}]`;

  // Every material must be on screen on BOTH backends before any ratio means
  // anything; a ratio of two zeroes is not agreement.
  checks.push({
    material,
    label: `${tag} webgl draws (${gl ? gl.colored : 0} px)`,
    pass: (gl ? gl.colored : 0) > MINIMUM_LIT_PIXELS,
  });
  checks.push({
    material,
    label: `${tag} webgpu draws (${gpu ? gpu.colored : 0} px)`,
    pass: (gpu ? gpu.colored : 0) > MINIMUM_LIT_PIXELS,
  });

  switch (material) {
    /* material-assertions:solid */
    case "solid": {
      // Anchor only: a solid line is ~1 run per row on both backends. If this
      // fails, the scene itself is wrong and no other verdict is readable.
      checks.push({
        material,
        label: `${tag} webgpu is SOLID (runsPerRow=${show(gpu ? gpu.runsPerRow : undefined)})`,
        pass: (gpu ? gpu.runsPerRow : Number.POSITIVE_INFINITY) < 2,
      });
      break;
    }
    /* end-material-assertions:solid */
    /* material-assertions:dash */
    case "dash": {
      // The dash half of the two-symptom bug: a collapsed dash renders as one
      // run per row where a patterned one renders many.
      checks.push({
        material,
        label: `${tag} webgl is DASHED (runsPerRow=${show(gl ? gl.runsPerRow : undefined)})`,
        pass: (gl ? gl.runsPerRow : 0) > 2,
      });
      checks.push({
        material,
        label: `${tag} webgpu is DASHED (runsPerRow=${show(gpu ? gpu.runsPerRow : undefined)})`,
        pass: (gpu ? gpu.runsPerRow : 0) > 2,
      });
      const ratio = gl && gl.runs > 0 && gpu ? gpu.runs / gl.runs : null;
      checks.push({
        material,
        label: `${tag} dash-run ratio ${show(ratio)} in [${RATIO_BAND.low}, ${RATIO_BAND.high}]`,
        pass: withinBand(ratio, RATIO_BAND),
      });
      break;
    }
    /* end-material-assertions:dash */
    /* material-assertions:glow */
    case "glow": {
      // The half the closure record left ungated. The defect read 3.3x the
      // WebGL lit pixels, and it changed the cross-section from a taper to a
      // band — so both the count and the profile width are asserted, because a
      // band of similar total area would pass a count-only check.
      const ratio = litRatio(gl, gpu);
      checks.push({
        material,
        label: `${tag} lit-px ratio ${show(ratio)} in [${RATIO_BAND.low}, ${RATIO_BAND.high}]`,
        pass: withinBand(ratio, RATIO_BAND),
      });
      const fwhm = gl && gl.fwhm > 0 && gpu ? gpu.fwhm / gl.fwhm : null;
      checks.push({
        material,
        label: `${tag} FWHM ratio ${show(fwhm)} in [${FWHM_BAND.low}, ${FWHM_BAND.high}]`,
        pass: withinBand(fwhm, FWHM_BAND),
      });
      break;
    }
    /* end-material-assertions:glow */
    /* material-assertions:arrow */
    case "arrow": {
      // Never instantiated by the guard this replaces. The arrow head is a
      // large fraction of the footprint, so a collapse to a plain line moves
      // the lit-pixel count well outside the band.
      const ratio = litRatio(gl, gpu);
      checks.push({
        material,
        label: `${tag} lit-px ratio ${show(ratio)} in [${RATIO_BAND.low}, ${RATIO_BAND.high}]`,
        pass: withinBand(ratio, RATIO_BAND),
      });
      // The count is not enough, and the run that proved it was GREEN. A head
      // that paints as a filled rectangle keeps the bounding box, the peak and
      // a lit-pixel ratio of 1.145 — so the SHAPE is asserted directly.
      const glProfile = leg.webgl ? leg.webgl.arrowProfile : undefined;
      const gpuProfile = leg.webgpu ? leg.webgpu.arrowProfile : undefined;
      const glFill = glProfile ? glProfile.headFill : null;
      const gpuFill = gpuProfile ? gpuProfile.headFill : null;
      // Anchor: if the reference head is not a triangle the scene is wrong and
      // no comparison below is readable.
      checks.push({
        material,
        label: `${tag} webgl head is a TRIANGLE (fill=${show(glFill)} in [${HEAD_FILL_BAND.low}, ${HEAD_FILL_BAND.high}])`,
        pass: withinBand(glFill, HEAD_FILL_BAND),
      });
      checks.push({
        material,
        label: `${tag} webgpu head is a TRIANGLE (fill=${show(gpuFill)} in [${HEAD_FILL_BAND.low}, ${HEAD_FILL_BAND.high}])`,
        pass: withinBand(gpuFill, HEAD_FILL_BAND),
      });
      const fillRatio =
        typeof glFill === "number" && glFill > 0 && typeof gpuFill === "number"
          ? gpuFill / glFill
          : null;
      checks.push({
        material,
        label: `${tag} head fill ratio ${show(fillRatio)} in [${HEAD_RATIO_BAND.low}, ${HEAD_RATIO_BAND.high}]`,
        pass: withinBand(fillRatio, HEAD_RATIO_BAND),
      });
      // `base = 1 - fwidth(st.s) * 10 * czm_pixelRatio` makes the head a fixed
      // length in CSS pixels. Dropping the pixel-ratio term halves the head at
      // a drawing buffer that does not track CSS pixels, which no ratio of
      // areas and no fill fraction would show.
      const glCols = glProfile ? glProfile.headColumns : 0;
      const gpuCols = gpuProfile ? gpuProfile.headColumns : 0;
      const colRatio = glCols > 0 ? gpuCols / glCols : null;
      checks.push({
        material,
        label: `${tag} head length ratio ${show(colRatio)} in [${HEAD_RATIO_BAND.low}, ${HEAD_RATIO_BAND.high}] (webgl ${glCols} px, webgpu ${gpuCols} px)`,
        pass: glCols > 0 && withinBand(colRatio, HEAD_RATIO_BAND),
      });
      break;
    }
    /* end-material-assertions:arrow */
    /* material-assertions:outline */
    case "outline": {
      // Also never instantiated. The outline is a SECOND colour the Color
      // material cannot emit, so a collapse is observed directly as the
      // outline hue going missing, not inferred from the core's area.
      const ratio = litRatio(gl, gpu);
      checks.push({
        material,
        label: `${tag} lit-px ratio ${show(ratio)} in [${RATIO_BAND.low}, ${RATIO_BAND.high}]`,
        pass: withinBand(ratio, RATIO_BAND),
      });
      const glEdge = leg.webgl ? leg.webgl.outlineEdge : undefined;
      const gpuEdge = leg.webgpu ? leg.webgpu.outlineEdge : undefined;
      const edgeRatio = litRatio(glEdge, gpuEdge);
      checks.push({
        material,
        label: `${tag} outline edge present, ratio ${show(edgeRatio)} in [${RATIO_BAND.low}, ${RATIO_BAND.high}]`,
        pass:
          (gpuEdge ? gpuEdge.colored : 0) > MINIMUM_LIT_PIXELS &&
          withinBand(edgeRatio, RATIO_BAND),
      });
      // Structure, not area: at the ribbon's widest column the outline hue has
      // to BRACKET the core hue on both sides. A count ratio cannot separate a
      // two-sided outline from a one-sided one, and the flood this probe first
      // caught had an edge ratio of 4.250 with no core at all.
      for (const backend of ["webgl", "webgpu"]) {
        const cross = leg[backend]
          ? leg[backend].outlineCrossSection
          : undefined;
        const above = cross ? cross.edgeAbove : 0;
        const below = cross ? cross.edgeBelow : 0;
        const skew = Math.abs(above - below);
        const allowedSkew = Math.max(
          2,
          Math.round(0.25 * Math.max(above, below)),
        );
        checks.push({
          material,
          label: `${tag} ${backend} outline BRACKETS the core (above ${above} px, below ${below} px, skew <= ${allowedSkew})`,
          pass: !!cross && above > 0 && below > 0 && skew <= allowedSkew,
        });
      }
      break;
    }
    /* end-material-assertions:outline */
    default:
      throw new Error(`unknown material "${material}"`);
  }
  return checks;
}

/**
 * Every check for a run.
 *
 * @param {Array<object>} legs One leg per device scale factor.
 * @param {Array<string>} [materials] Materials to assert; defaults to all.
 * @returns {Array<{material: string, label: string, pass: boolean}>} The checks.
 */
export function buildChecks(legs, materials = MATERIALS) {
  const checks = [];
  for (const leg of legs) {
    for (const material of materials) {
      checks.push(...materialChecks(material, leg));
    }
    checks.push(gateCheck(leg));
  }
  return checks;
}

/**
 * The per-leg device-health gate. Exported so the probe's `verdicts()` — which
 * is what `exitCodeForOutcome` actually reads — asserts the SAME predicate this
 * check reports, rather than a summary line no exit code consults.
 *
 * @param {object} leg One device-scale-factor leg.
 * @returns {{material: string, label: string, pass: boolean}} The check.
 */
export function gateCheck(leg) {
  return {
    material: "gate",
    label: `[gate@dpr${leg.deviceScaleFactor}] no uncaptured WebGPU errors`,
    pass: (leg.gateErrors ?? 0) === 0 && !leg.deviceLost,
  };
}

/**
 * @param {Array<object>} legs One leg per device scale factor.
 * @param {Array<string>} [materials] Materials to assert.
 * @returns {boolean} Whether every check passed.
 */
export function allChecksPass(legs, materials = MATERIALS) {
  return buildChecks(legs, materials).every((check) => check.pass);
}
