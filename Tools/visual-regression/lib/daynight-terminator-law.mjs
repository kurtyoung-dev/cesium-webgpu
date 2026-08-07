/**
 * CLT-B1 — the pure model behind `probe-daynight-terminator-law.mjs`.
 *
 * WHAT THE PROBE IS FOR. `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md` §2
 * records four static day/night findings and §4 makes CLT-B1 a BLOCKING
 * premise-verification prereq for the CLT-B7 blend: pixel-confirm them, produce
 * a numbers table, fix nothing. The four:
 *
 *   (a) the two backends disagree by 0.5 night-alpha AT the geometric
 *       terminator — GLSL `1 - clamp(N.L*5, 0, 1)`, WGSL `computeDayNightFade`
 *       adds `+0.5` and centres the ramp on N.L = 0;
 *   (b) `globe.enableNightLights = false` leaves the WebGPU emission at the
 *       default-2.5 sentinel;
 *   (c) WebGL gates the day/night imagery alpha off entirely on vertex-normal
 *       terrain (`ENABLE_DAYNIGHT_SHADING` emission rule) while WebGPU keeps it;
 *   (d) WebGL flattens the night side at low altitude via its camera-distance
 *       lighting fade, which the WGSL path lacks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS MODEL EXISTS TO AVOID
 * ─────────────────────────────────────────────────────────────────────────────
 * Finding (a) as recorded predicts "WebGPU reads ~0.5 at the terminator". A
 * probe that samples ONLY at the terminator would confirm that number and stop.
 * But 0.5 is also what a SECOND, independent mechanism produces at the vernal
 * equinox: `GlobeTerrain.wgsl`'s day/night term reads `input.v_normalEC`, the
 * interpolated MESH vertex normal, where `GlobeFS.glsl` recomputes the analytic
 * geocentric normal per fragment. On terrain with no vertex normals the WGSL
 * vertex stage feeds `octDecode(0.0)` — a CONSTANT model-space (0,0,-1) — so
 * `N.L` is the same number for every fragment on the globe, and at the equinox
 * (sun in the equatorial plane) that number is ~0, i.e. dayFade ~0.5
 * EVERYWHERE. Same reading, different defect, opposite fix.
 *
 * So the discriminator is not the value at the terminator. It is the SHAPE of
 * the ramp across N.L:
 *
 *   offset law (the recorded finding)  →  slope ~= -5 per unit N.L, range ~1
 *   constant normal (the alternative)  →  slope ~= 0,               range ~0
 *
 * `classifyRamp` is that discriminator, and `SOLSTICE_DISCRIMINATOR` documents
 * the second, independent leg: at a solstice `dot(spinAxis, sunDir) = sin(23.4
 * deg) = 0.397`, so a constant-normal backend saturates to full day and shows
 * NO terminator at all, while the offset law still ramps.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CALIBRATION LADDER RATHER THAN A THREE-LEG RATIO
 * ─────────────────────────────────────────────────────────────────────────────
 * The quantity under test is an imagery ALPHA, and what a probe can read is an
 * 8-bit display value downstream of lighting, compositing and whatever transfer
 * the backend's output chain applies. A ratio of three legs cancels the
 * multiplicative lighting term but assumes the transfer is LINEAR — the same
 * assumption `celestial-g2-gate.mjs` had to retract.
 *
 * The ladder assumption-proofs it. `dayAlpha == nightAlpha == c` makes the
 * shader's blend `mix(c, c, anything) == c` on BOTH backends, so a sweep of `c`
 * measures the per-pixel transfer from alpha to pixel value WITHOUT touching
 * the ramp. Inverting that measured curve turns the measurement leg's pixel
 * value back into an alpha, whatever the transfer is, as long as it is
 * monotone — and `calibrationHealth` checks monotonicity and span rather than
 * assuming them.
 *
 * @module daynight-terminator-law
 */

/**
 * EXIT CODES. Shared with the celestial fleet's convention.
 *   0 PASS       every scored predicate is decided and in band
 *   1 FAIL       a scored predicate is decided and out of band
 *   2 ERROR      a lane did not run (navigation, device, watchdog)
 *   3 STRUCTURAL a lane RAN but could not see its subject — no headroom, a
 *                degenerate calibration, an unavailable dependency. NEVER
 *                report such a lane as 0.
 */
export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/** Lane outcome vocabulary. */
export const LANE = Object.freeze({
  CONFIRMED: "CONFIRMED",
  REFUTED: "REFUTED",
  STRUCTURAL: "STRUCTURAL",
});

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * WebGL's day fade, transcribed from `Shaders/GlobeFS.glsl`:
 *
 *   nightBlend = 1.0 - clamp(czm_getLambertDiffuse(L, N) * 5.0, 0.0, 1.0)
 *
 * with `czm_getLambertDiffuse = max(dot(L, N), 0)`. The clamp at zero on the
 * night side makes the explicit `max` redundant, so this is the whole law.
 * Fully night at N.L <= 0; the ramp lives entirely on the DAY side.
 */
export function dayFadeGlsl(ndotl) {
  return clamp01(ndotl * 5.0);
}

/**
 * WebGPU's day fade, transcribed from `GlobeTerrain.wgsl::computeDayNightFade`:
 *
 *   clamp(dot(normalEC, sunDirEC) * 5.0 + 0.5, 0.0, 1.0)
 *
 * The `+0.5` centres the ramp ON the terminator, so the geometric terminator
 * reads half-day. The function's own comment claims it "matches the GLSL path";
 * it does not, and that is §2 bug 2.
 */
export function dayFadeWgsl(ndotl) {
  return clamp01(ndotl * 5.0 + 0.5);
}

/** Night alpha is the complement of the day fade on both backends. */
export const nightBlendGlsl = (ndotl) => 1 - dayFadeGlsl(ndotl);
export const nightBlendWgsl = (ndotl) => 1 - dayFadeWgsl(ndotl);

/**
 * The band in which the two laws actually differ.
 *
 * GLSL ramps over N.L in [0, 0.2]; WGSL over [-0.1, 0.1]. Outside [-0.1, 0.2]
 * both are saturated and a sample there discriminates nothing — it is the
 * "metric pinned at its bound" blindness that `weather-probe-pinning`'s P9
 * headroom rule exists to catch. The probe scores only inside this band and
 * uses the saturated flanks as an A/A control.
 */
export const DIVERGENCE_BAND = Object.freeze({ min: -0.1, max: 0.2 });

/** The wider window the ramp SHAPE is fitted over (saturated flanks included). */
export const FIT_WINDOW = Object.freeze({ min: -0.35, max: 0.35 });

/**
 * The solstice leg's separating prediction.
 *
 * `sin(23.44 deg)` is what `dot(earthSpinAxis, sunDirection)` reaches at a
 * solstice. A backend whose day/night term reads a constant model-space
 * (0, 0, +-1) instead of the surface normal therefore evaluates
 * `clamp(+-0.397 * 5 + 0.5, 0, 1)` — saturated at 1 or 0 — for EVERY fragment,
 * so its measured ramp range collapses. A backend reading the real normal is
 * unaffected: the terminator is still a terminator at a solstice.
 */
export const SOLSTICE_DISCRIMINATOR = Object.freeze({
  obliquityDeg: 23.44,
  axisDotSun: Math.sin((23.44 * Math.PI) / 180),
  /** Below this measured range at a solstice, the ramp is not reading N.L. */
  maxRangeForConstantNormal: 0.1,
  /** Above this, a real per-fragment normal is being read. */
  minRangeForSurfaceNormal: 0.5,
});

// ─── calibration ─────────────────────────────────────────────────────────────

/**
 * Health of one pixel's alpha->value calibration ladder.
 *
 * `ladder` is `[{ alpha, value }]` in ascending alpha. Two things must hold
 * before an inversion means anything, and neither may be assumed:
 *
 *   MONOTONE — a non-monotone curve has no inverse. 8-bit noise can flatten a
 *              step, so equality is tolerated and only a genuine REVERSAL
 *              (beyond `noise`) is rejected.
 *   SPAN     — the curve must actually move. If the darkest and brightest rungs
 *              are `span` apart in 8-bit counts, the inversion's resolution is
 *              1/span in alpha; below `minSpan` the pixel cannot resolve the
 *              0.5 the finding is about and must not be scored.
 *
 * @returns {{ok: boolean, span: number, reason: string|null}}
 */
export function calibrationHealth(ladder, { minSpan = 24, noise = 2 } = {}) {
  if (!Array.isArray(ladder) || ladder.length < 2) {
    return { ok: false, span: 0, reason: "ladder has fewer than two rungs" };
  }
  for (let i = 1; i < ladder.length; i++) {
    if (!(ladder[i].alpha > ladder[i - 1].alpha)) {
      return { ok: false, span: 0, reason: "ladder alphas are not ascending" };
    }
  }
  const first = ladder[0].value;
  const last = ladder[ladder.length - 1].value;
  const rising = last >= first;
  for (let i = 1; i < ladder.length; i++) {
    const delta = ladder[i].value - ladder[i - 1].value;
    if (rising ? delta < -noise : delta > noise) {
      return {
        ok: false,
        span: Math.abs(last - first),
        reason: `calibration reverses between rung ${i - 1} and ${i}`,
      };
    }
  }
  const span = Math.abs(last - first);
  if (span < minSpan) {
    return {
      ok: false,
      span,
      reason:
        `calibration span ${span.toFixed(1)} < ${minSpan} counts — this ` +
        "pixel cannot resolve the alpha the gate scores",
    };
  }
  return { ok: true, span, reason: null };
}

/**
 * Invert a measured alpha->value ladder at one pixel.
 *
 * Piecewise linear between rungs, clamped to the ladder's ends. Returns null
 * when the bracketing rungs are flat (the value carries no alpha information
 * there) rather than fabricating an interpolation over a zero denominator.
 */
export function invertCalibration(ladder, value) {
  const first = ladder[0];
  const last = ladder[ladder.length - 1];
  const rising = last.value >= first.value;
  const before = rising ? value <= first.value : value >= first.value;
  const after = rising ? value >= last.value : value <= last.value;
  if (before) {
    return first.alpha;
  }
  if (after) {
    return last.alpha;
  }
  for (let i = 1; i < ladder.length; i++) {
    const lo = ladder[i - 1];
    const hi = ladder[i];
    const within = rising
      ? value >= lo.value && value <= hi.value
      : value <= lo.value && value >= hi.value;
    if (!within) {
      continue;
    }
    const denominator = hi.value - lo.value;
    if (Math.abs(denominator) < 1e-9) {
      return null;
    }
    const t = (value - lo.value) / denominator;
    return lo.alpha + t * (hi.alpha - lo.alpha);
  }
  return null;
}

// ─── ramp fitting + classification ───────────────────────────────────────────

/**
 * Bin `[{ndotl, alpha}]` samples onto a regular N.L grid and average.
 *
 * Averaging is what buys back the 8-bit quantisation: one sample resolves alpha
 * to ~1/span, `n` samples in a bin to ~1/(span*sqrt(n)). Bins with fewer than
 * `minCount` samples are dropped rather than reported at unstated precision.
 */
export function binByNdotL(
  samples,
  { min, max, binWidth = 0.02, minCount = 8 },
) {
  const bins = new Map();
  for (const s of samples) {
    if (!Number.isFinite(s.ndotl) || !Number.isFinite(s.alpha)) {
      continue;
    }
    if (s.ndotl < min || s.ndotl > max) {
      continue;
    }
    const key = Math.floor((s.ndotl - min) / binWidth);
    const bin = bins.get(key) ?? { sum: 0, sumNdotl: 0, count: 0 };
    bin.sum += s.alpha;
    bin.sumNdotl += s.ndotl;
    bin.count += 1;
    bins.set(key, bin);
  }
  return [...bins.entries()]
    .filter(([, b]) => b.count >= minCount)
    .map(([key, b]) => ({
      key,
      ndotl: b.sumNdotl / b.count,
      alpha: b.sum / b.count,
      count: b.count,
    }))
    .sort((a, b) => a.ndotl - b.ndotl);
}

/** Root-mean-square residual of binned samples against a candidate law. */
export function rmseAgainst(bins, law) {
  if (bins.length === 0) {
    return null;
  }
  let acc = 0;
  for (const b of bins) {
    const d = b.alpha - law(b.ndotl);
    acc += d * d;
  }
  return Math.sqrt(acc / bins.length);
}

/**
 * Least-squares slope of alpha against N.L over a window.
 *
 * The offset law has slope -5 in NIGHT-blend terms and +5 in day-fade terms
 * inside its ramp; a constant normal has slope 0. This is the shape statistic
 * `classifyRamp` keys on.
 */
export function centralSlope(bins, window = { min: -0.05, max: 0.05 }) {
  const inWindow = bins.filter(
    (b) => b.ndotl >= window.min && b.ndotl <= window.max,
  );
  if (inWindow.length < 3) {
    return null;
  }
  const n = inWindow.length;
  const meanX = inWindow.reduce((a, b) => a + b.ndotl, 0) / n;
  const meanY = inWindow.reduce((a, b) => a + b.alpha, 0) / n;
  let num = 0;
  let den = 0;
  for (const b of inWindow) {
    num += (b.ndotl - meanX) * (b.alpha - meanY);
    den += (b.ndotl - meanX) ** 2;
  }
  return den < 1e-12 ? null : num / den;
}

/** Measured day-fade at the geometric terminator, from the bin nearest N.L=0. */
export function alphaAtTerminator(bins) {
  if (bins.length === 0) {
    return null;
  }
  let best = bins[0];
  for (const b of bins) {
    if (Math.abs(b.ndotl) < Math.abs(best.ndotl)) {
      best = b;
    }
  }
  return Math.abs(best.ndotl) <= 0.02 ? best.alpha : null;
}

/**
 * Which law is this backend actually implementing?
 *
 * Order matters. The CONSTANT verdict is tested FIRST because a constant ramp
 * can accidentally satisfy the offset law's terminator value while satisfying
 * neither law's shape — that is the whole trap this module was written for.
 */
export function classifyRamp({ bins, rmseGlsl, rmseWgsl, slope, range }) {
  if (bins.length < 5) {
    return {
      verdict: "unmeasured",
      why: `only ${bins.length} usable N.L bins — the ramp was not sampled`,
    };
  }
  if (
    range !== null &&
    range < 0.15 &&
    (slope === null || Math.abs(slope) < 1.0)
  ) {
    return {
      verdict: "constant",
      why:
        `day-fade varies by only ${range.toFixed(3)} across the fit window ` +
        `(central slope ${slope === null ? "n/a" : slope.toFixed(2)}). The ` +
        "term is not reading a per-fragment surface normal at all, so the " +
        "recorded +0.5 offset is NOT the operative mechanism here",
    };
  }
  if (rmseGlsl === null || rmseWgsl === null) {
    return { verdict: "unmeasured", why: "no residuals could be computed" };
  }
  const better = rmseGlsl <= rmseWgsl ? "glsl" : "wgsl";
  const loser = better === "glsl" ? rmseWgsl : rmseGlsl;
  const winner = better === "glsl" ? rmseGlsl : rmseWgsl;
  if (loser < winner * 1.5) {
    return {
      verdict: "ambiguous",
      why:
        `residuals are within 1.5x (glsl ${rmseGlsl.toFixed(3)}, wgsl ` +
        `${rmseWgsl.toFixed(3)}) — the sampling cannot separate the laws`,
    };
  }
  return {
    verdict: better === "glsl" ? "glsl-law" : "wgsl-offset-law",
    why:
      `residual against the ${better} law is ${winner.toFixed(3)} vs ` +
      `${loser.toFixed(3)} for the other`,
  };
}

// ─── lane evaluators ─────────────────────────────────────────────────────────

/**
 * Lane A — finding (a). Two things are scored, and they are NOT the same claim:
 *
 *   A1 the terminator VALUES differ by ~0.5 between backends;
 *   A2 each backend's ramp SHAPE identifies which law it runs.
 *
 * A1 alone is the trap; A2 is what makes A1 mean the recorded thing. A lane
 * whose WebGPU shape comes back `constant` is STRUCTURAL for the recorded
 * finding — the pixels agree with the prediction for a reason the prediction
 * does not name, and reporting that as CONFIRMED would bank a wrong mechanism.
 */
export function evaluateRampLane({ webgl, webgpu, tolerance = 0.12 }) {
  const failures = [];
  if (!webgl || !webgpu) {
    return {
      status: LANE.STRUCTURAL,
      failures: ["a backend lane produced no ramp"],
      metrics: {},
    };
  }
  const metrics = {
    webgl_terminator: webgl.atTerminator,
    webgpu_terminator: webgpu.atTerminator,
    webgl_shape: webgl.classification.verdict,
    webgpu_shape: webgpu.classification.verdict,
    webgl_slope: webgl.slope,
    webgpu_slope: webgpu.slope,
    webgl_range: webgl.range,
    webgpu_range: webgpu.range,
    webgl_rmse_glslLaw: webgl.rmseGlsl,
    webgl_rmse_wgslLaw: webgl.rmseWgsl,
    webgpu_rmse_glslLaw: webgpu.rmseGlsl,
    webgpu_rmse_wgslLaw: webgpu.rmseWgsl,
  };
  if (webgl.atTerminator === null || webgpu.atTerminator === null) {
    return {
      status: LANE.STRUCTURAL,
      failures: ["no bin landed within 0.02 of the geometric terminator"],
      metrics,
    };
  }
  if (
    webgl.classification.verdict === "unmeasured" ||
    webgpu.classification.verdict === "unmeasured"
  ) {
    return {
      status: LANE.STRUCTURAL,
      failures: [
        `ramp shape unmeasured (webgl: ${webgl.classification.why}; ` +
          `webgpu: ${webgpu.classification.why})`,
      ],
      metrics,
    };
  }
  if (webgpu.classification.verdict === "constant") {
    return {
      status: LANE.STRUCTURAL,
      failures: [
        "the WebGPU day/night term does not vary with N.L, so the 0.5 reading " +
          "at the terminator is NOT evidence for the recorded +0.5 offset. " +
          `Mechanism: ${webgpu.classification.why}`,
      ],
      metrics,
    };
  }

  metrics.terminator_delta = webgpu.atTerminator - webgl.atTerminator;
  if (Math.abs(webgl.atTerminator - dayFadeGlsl(0)) > tolerance) {
    failures.push(
      `WebGL day-fade at the terminator is ${webgl.atTerminator.toFixed(3)}, ` +
        `not the ${dayFadeGlsl(0).toFixed(3)} its law predicts`,
    );
  }
  if (Math.abs(webgpu.atTerminator - dayFadeWgsl(0)) > tolerance) {
    failures.push(
      `WebGPU day-fade at the terminator is ${webgpu.atTerminator.toFixed(3)}, ` +
        `not the ${dayFadeWgsl(0).toFixed(3)} its law predicts`,
    );
  }
  if (webgl.classification.verdict !== "glsl-law") {
    failures.push(`WebGL ramp shape is ${webgl.classification.verdict}`);
  }
  if (webgpu.classification.verdict !== "wgsl-offset-law") {
    failures.push(`WebGPU ramp shape is ${webgpu.classification.verdict}`);
  }
  return {
    status: failures.length === 0 ? LANE.CONFIRMED : LANE.REFUTED,
    failures,
    metrics,
  };
}

/**
 * Lane B — finding (b), the `nightIntensity` sentinel collision.
 *
 * Three legs, all with a night-lights layer (dayAlpha 0, nightAlpha 1) so the
 * shader's `isNightLayer = step(dayAlpha + 0.01, nightAlpha)` gate is open:
 *
 *   `on`      enableNightLights = true,  nightIntensity = 2.5 (the default)
 *   `off`     enableNightLights = false
 *   `boosted` enableNightLights = true,  nightIntensity = 5.0
 *
 * `boosted` is the HEADROOM control and is checked first: if the emission term
 * cannot move the metric at all, "off equals on" is vacuous and the lane is
 * STRUCTURAL, not a confirmation. Only once the metric is shown to respond does
 * `off == on` mean the toggle is dead.
 */
export function evaluateSentinelLane({ on, off, boosted, noise = 1.5 }) {
  const metrics = {
    nightMean_on: on,
    nightMean_off: off,
    nightMean_boosted: boosted,
    delta_boosted_minus_on: boosted - on,
    delta_off_minus_on: off - on,
  };
  const headroom = boosted - on;
  if (!(Math.abs(headroom) > 4 * noise)) {
    return {
      status: LANE.STRUCTURAL,
      failures: [
        `raising nightIntensity 2.5 -> 5.0 moved the night-side mean by only ` +
          `${headroom.toFixed(2)} counts. The emission term is not reachable ` +
          "in this configuration, so an off==on reading proves nothing",
      ],
      metrics,
    };
  }
  const bug = Math.abs(off - on) <= noise;
  return {
    status: bug ? LANE.CONFIRMED : LANE.REFUTED,
    failures: bug
      ? []
      : [
          `enableNightLights = false changed the night-side mean by ` +
            `${(off - on).toFixed(2)} counts — the sentinel collision is not ` +
            "present at this build, so §2 bug 1 needs restating",
        ],
    metrics,
  };
}

/**
 * Lane D — finding (d), the camera-distance lighting fade.
 *
 * `GlobeFS.glsl` computes `fade = clamp((cameraDist - fadeOut)/(fadeIn -
 * fadeOut), 0, 1)` and mixes the day/night diffuse toward FULL brightness by
 * `1 - fade`, so at low altitude (fade 0) the WebGL night side is flat-lit.
 * The WGSL Lambert path has no such mix. Scored as the night/day luminance
 * ratio at two altitudes.
 *
 * The WebGPU leg is only meaningful if its lighting term reads a real surface
 * normal — a constant-normal backend is uniformly lit at BOTH altitudes for an
 * unrelated reason. `rampVerdictWebgpu` carries lane A's answer so this lane
 * can decline rather than mis-attribute.
 */
export function evaluateCameraFadeLane({
  webglLow,
  webglHigh,
  webgpuLow,
  webgpuHigh,
  rampVerdictWebgpu,
  flatTolerance = 0.08,
}) {
  const metrics = {
    webgl_lowAlt_nightDayRatio: webglLow,
    webgl_highAlt_nightDayRatio: webglHigh,
    webgpu_lowAlt_nightDayRatio: webgpuLow,
    webgpu_highAlt_nightDayRatio: webgpuHigh,
  };
  const failures = [];
  if (![webglLow, webglHigh, webgpuLow, webgpuHigh].every(Number.isFinite)) {
    return {
      status: LANE.STRUCTURAL,
      failures: ["a lighting-ratio leg produced no finite value"],
      metrics,
    };
  }
  if (!(webglLow >= 1 - flatTolerance)) {
    failures.push(
      `WebGL low-altitude night/day ratio is ${webglLow.toFixed(3)}; the fade ` +
        "law predicts a flat-lit globe (~1.0) there",
    );
  }
  if (!(webglHigh < webglLow - flatTolerance)) {
    failures.push(
      `WebGL high-altitude ratio ${webglHigh.toFixed(3)} is not meaningfully ` +
        `below its low-altitude ratio ${webglLow.toFixed(3)} — the fade is ` +
        "not the discriminator it is claimed to be",
    );
  }
  if (rampVerdictWebgpu === "constant") {
    return {
      status: LANE.STRUCTURAL,
      failures: failures.concat([
        "the WebGPU lighting term reads a constant normal (lane A), so its " +
          "altitude invariance cannot be attributed to a missing camera fade",
      ]),
      metrics,
    };
  }
  if (!(Math.abs(webgpuHigh - webgpuLow) <= flatTolerance)) {
    failures.push(
      `WebGPU night/day ratio moved with altitude (${webgpuLow.toFixed(3)} -> ` +
        `${webgpuHigh.toFixed(3)}), which the WGSL path has no term to produce`,
    );
  }
  return {
    status: failures.length === 0 ? LANE.CONFIRMED : LANE.REFUTED,
    failures,
    metrics,
  };
}

/**
 * Lane E — the solstice separation, run only because lane A's two hypotheses
 * are otherwise indistinguishable at the equinox.
 */
export function evaluateSolsticeLane({ webglRange, webgpuRange }) {
  const metrics = {
    webgl_solstice_dayFadeRange: webglRange,
    webgpu_solstice_dayFadeRange: webgpuRange,
    axisDotSunAtSolstice: SOLSTICE_DISCRIMINATOR.axisDotSun,
  };
  if (![webglRange, webgpuRange].every(Number.isFinite)) {
    return {
      status: LANE.STRUCTURAL,
      failures: ["a solstice leg produced no finite range"],
      metrics,
    };
  }
  if (webglRange < SOLSTICE_DISCRIMINATOR.minRangeForSurfaceNormal) {
    return {
      status: LANE.STRUCTURAL,
      failures: [
        `the WebGL reference itself shows no terminator at the solstice ` +
          `(range ${webglRange.toFixed(3)}), so the framing — not the ` +
          "renderer — is what this lane measured",
      ],
      metrics,
    };
  }
  const constant =
    webgpuRange <= SOLSTICE_DISCRIMINATOR.maxRangeForConstantNormal;
  metrics.webgpu_normalSource = constant ? "constant" : "per-fragment";
  return {
    status: LANE.CONFIRMED,
    failures: [],
    metrics,
    normalSource: constant ? "constant" : "per-fragment",
  };
}

/**
 * Fold lane statuses into a process exit code.
 *
 * STRUCTURAL dominates PASS: a run whose lanes could not see their subject has
 * certified nothing and must not exit 0. FAIL dominates STRUCTURAL: a decided,
 * out-of-band predicate is a stronger statement than an undecided one.
 */
export function foldVerdict(lanes) {
  const values = Object.values(lanes);
  if (values.some((l) => l?.status === undefined)) {
    return EXIT_CODE.ERROR;
  }
  if (values.some((l) => l.status === LANE.REFUTED)) {
    return EXIT_CODE.FAIL;
  }
  if (values.some((l) => l.status === LANE.STRUCTURAL)) {
    return EXIT_CODE.STRUCTURAL;
  }
  return EXIT_CODE.PASS;
}

export default {
  EXIT_CODE,
  LANE,
  DIVERGENCE_BAND,
  FIT_WINDOW,
  SOLSTICE_DISCRIMINATOR,
  clamp01,
  dayFadeGlsl,
  dayFadeWgsl,
  nightBlendGlsl,
  nightBlendWgsl,
  calibrationHealth,
  invertCalibration,
  binByNdotL,
  rmseAgainst,
  centralSlope,
  alphaAtTerminator,
  classifyRamp,
  evaluateRampLane,
  evaluateSentinelLane,
  evaluateCameraFadeLane,
  evaluateSolsticeLane,
  foldVerdict,
};
