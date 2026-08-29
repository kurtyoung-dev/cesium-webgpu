// @purpose State-isolated ABBA session plan plus pinned lighting/fade constants for C13-41's deck-free eclipse control lane.
// @status ACTIVE

import { predictFactor } from "./eclipse-cloud-response-gate.mjs";

/**
 * The state-isolated C13-41 deck-free control policy. Each plan entry runs in a
 * fresh browser context and configures the cloud collection exactly once before
 * any scored capture. ABBA ordering makes backend/session drift visible without
 * returning to the persistent, transition-heavy cloud page that produced the
 * first six contradictory controls.
 */
export const DECK_FREE_CONTROL_SESSION_PLAN = Object.freeze([
  Object.freeze({ label: "off-a", eclipseEnabled: false }),
  Object.freeze({ label: "on-a", eclipseEnabled: true }),
  Object.freeze({ label: "on-b", eclipseEnabled: true }),
  Object.freeze({ label: "off-b", eclipseEnabled: false }),
]);

export const DECK_FREE_BASE_COLOR_CHANNEL = 200 / 255;
export const DECK_FREE_RAW_BASE_COLOR_LUMA = DECK_FREE_BASE_COLOR_CHANNEL;

// The isolated control flies at ~6.36 Mm geocentric distance. Globe's shipped
// near-ground day/night fade begins at ~9.98 Mm, so leaving the defaults in
// place deliberately produces a flat-lit raw baseColor control. This probe-only
// pin forces the already-shipped day/night branch live without changing Globe
// defaults or the scored lane-B camera geometry.
export const DECK_FREE_LIGHTING_FADE_OUT_DISTANCE = 0;
export const DECK_FREE_LIGHTING_FADE_IN_DISTANCE = 1;
export const DECK_FREE_EXPECTED_LIGHTING_FADE = 1;

// A forced fade alone is not a live DAYNIGHT discriminator at the Iceland
// ladder: its real-Sun NdotL values (0.531/0.496/0.479/0.453) all saturate
// `clamp(NdotL * 5 + 0.3, 0, 1)` at 1. The diagnostic therefore supplies four
// emitted-light directions whose independently reconstructed incoming NdotL
// values exercise the unsaturated 0.3/0.5/0.7/0.9 portion of the shipped law.
// The custom light is diagnostic-only; every scored factor capture restores a
// fresh SunLight first because S2's uniform-source dimming is SunLight-gated.
export const DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS = Object.freeze([
  0, 0.04, 0.08, 0.12,
]);
export const DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY = 1;
export const DECK_FREE_SUN_LIGHT_INTENSITY = 2;
export const DECK_FREE_LIGHT_COLOR = Object.freeze([1, 1, 1, 1]);
export const DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH = 0;
export const DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH = 1;

// The directional discriminator executes the WebGPU globe's complete lighting
// block. After the shared DAYNIGHT multiply, that block adds the documented
// terminator glow (`GlobeTerrain.wgsl::computeTerminatorGlow`; current source
// also carries its GLSL twin). Keep
// this Node-side model independent of the shader so captured pixels cannot
// certify themselves; the focused source contract pins the constants together.
export const DECK_FREE_TERMINATOR_GLOW_COLOR = Object.freeze([
  0.95, 0.45, 0.15,
]);
export const DECK_FREE_TERMINATOR_GLOW_EXPONENT = 40;
export const DECK_FREE_TERMINATOR_GLOW_STRENGTH = 0.15;

// The procedural night-side floor. It is a THIRD consumer of the terminator
// ramp this diagnostic already exercises, and it multiplies the composited
// surface AHEAD of the lighting arms, so a diagnostic patch held at
// N·L <= 0.12 carries it almost in full. The control pins the public property
// rather than inheriting whatever the engine currently defaults to, so a moved
// default shows up as a pin that has to be changed on purpose instead of as a
// silently stale expectation.
export const DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS = 0.15;

// A second pinned floor, captured once at the darkest rung while the
// diagnostic light is still installed. Two floors under one N·L are what keep
// the term a measured quantity rather than a constant the model absorbs: a
// surface that ignored the uniform would return the same pixel twice.
export const DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE = 0.6;

// Every imagery layer is removed before the control captures anything, so the
// night-layer share this fallback is the complement of is zero by
// construction, and the effective floor is the pinned floor itself.
export const DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE = 0;

const REC709_LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Independently execute the shipped no-vertex-normal DAYNIGHT law. */
export function computeDeckFreeDayNightDiffuse(ndotl, lightingFade) {
  if (!Number.isFinite(ndotl) || !Number.isFinite(lightingFade)) {
    return null;
  }
  const dayNightDiffuse = clamp01(Math.max(ndotl, 0) * 5 + 0.3);
  const fade = clamp01(lightingFade);
  return 1 + (dayNightDiffuse - 1) * fade;
}

/** Independently evaluate the additive WebGPU terminator-glow luma. */
export function computeDeckFreeTerminatorGlowLuma(
  ndotl,
  terminatorGlowStrength,
) {
  if (!Number.isFinite(ndotl) || !Number.isFinite(terminatorGlowStrength)) {
    return null;
  }
  const warmLuma = DECK_FREE_TERMINATOR_GLOW_COLOR.reduce(
    (sum, channel, index) => sum + channel * REC709_LUMA[index],
    0,
  );
  const terminatorFactor = Math.exp(
    -ndotl * ndotl * DECK_FREE_TERMINATOR_GLOW_EXPONENT,
  );
  return (
    warmLuma *
    terminatorFactor *
    DECK_FREE_TERMINATOR_GLOW_STRENGTH *
    Math.max(terminatorGlowStrength, 0)
  );
}

/**
 * Independently execute the shipped night-side ramp, the complement of the
 * imagery day/night alpha rather than of the DAYNIGHT diffuse: it is the bare
 * `clamp(N·L * 5, 0, 1)` with no `+ 0.3` and no camera-distance mix.
 */
export function computeDeckFreeNightBlend(ndotl) {
  if (!Number.isFinite(ndotl)) {
    return null;
  }
  return 1 - clamp01(Math.max(ndotl, 0) * 5);
}

/**
 * Independently execute the CPU-side fold that scales the procedural floor by
 * the share of the night side the imagery layers leave uncovered. Full
 * coverage resolves to the multiplicative identity, which is the value that
 * shuts the shader's own guard.
 */
export function computeDeckFreeEffectiveNightDarkness(
  nightDarkness,
  nightLayerCoverage,
) {
  if (
    !Number.isFinite(nightDarkness) ||
    !Number.isFinite(nightLayerCoverage) ||
    nightDarkness < 0 ||
    nightDarkness > 1
  ) {
    return null;
  }
  return 1 + (nightDarkness - 1) * (1 - clamp01(nightLayerCoverage));
}

/**
 * Independently execute the procedural night-darkening multiplier the surface
 * carries before any lighting arm runs.
 */
export function computeDeckFreeNightDarkeningMultiplier(
  ndotl,
  effectiveNightDarkness,
) {
  const nightBlend = computeDeckFreeNightBlend(ndotl);
  if (
    !Number.isFinite(nightBlend) ||
    !Number.isFinite(effectiveNightDarkness) ||
    effectiveNightDarkness < 0 ||
    effectiveNightDarkness > 1
  ) {
    return null;
  }
  return 1 + (effectiveNightDarkness - 1) * nightBlend;
}

/**
 * Full expected luma of the fixed grey directional diagnostic surface.
 *
 * The order is the shipped one and it is load-bearing. The night-darkening
 * multiplier scales the composited surface first, the DAYNIGHT diffuse and the
 * custom light colour multiply that product, and only then does the terminator
 * glow ADD — scattered light, which no ground albedo term may dim. Both
 * dialects place the three terms in exactly that order.
 *
 * `effectiveNightDarkness` is required, not defaulted: the term entered the
 * shipped fragment while this model still read `base * diffuse + glow`, and a
 * defaulted identity would let the same omission return silently.
 */
export function computeDeckFreeDirectionalDiagnosticLuma(
  ndotl,
  lightingFade,
  terminatorGlowStrength,
  effectiveNightDarkness,
) {
  const diffuse = computeDeckFreeDayNightDiffuse(ndotl, lightingFade);
  const glow = computeDeckFreeTerminatorGlowLuma(ndotl, terminatorGlowStrength);
  const nightDarkening = computeDeckFreeNightDarkeningMultiplier(
    ndotl,
    effectiveNightDarkness,
  );
  if (
    !Number.isFinite(diffuse) ||
    !Number.isFinite(glow) ||
    !Number.isFinite(nightDarkening)
  ) {
    return null;
  }
  return DECK_FREE_RAW_BASE_COLOR_LUMA * nightDarkening * diffuse + glow;
}

/**
 * Reconstruct the diagnostic's WGS84 geodetic normal, east tangent, incoming
 * light, and public DirectionalLight emitted direction without Cesium. This is
 * independent of the in-page Cartesian implementation whose readback it checks.
 */
export function computeDeckFreeDiagnosticFrame(
  latitudeDegrees,
  longitudeDegrees,
  ndotlTarget,
  terminatorGlowStrength,
  effectiveNightDarkness,
) {
  if (
    !Number.isFinite(latitudeDegrees) ||
    !Number.isFinite(longitudeDegrees) ||
    !Number.isFinite(ndotlTarget) ||
    ndotlTarget < 0 ||
    ndotlTarget >= 1 ||
    !Number.isFinite(terminatorGlowStrength) ||
    !Number.isFinite(effectiveNightDarkness)
  ) {
    return null;
  }
  const latitude = (latitudeDegrees * Math.PI) / 180;
  const longitude = (longitudeDegrees * Math.PI) / 180;
  const normalWC = [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  ];
  const eastWC = [-Math.sin(longitude), Math.cos(longitude), 0];
  const tangentShare = Math.sqrt(1 - ndotlTarget * ndotlTarget);
  const incomingDirectionWC = normalWC.map(
    (component, index) =>
      component * ndotlTarget + eastWC[index] * tangentShare,
  );
  const emittedDirectionWC = incomingDirectionWC.map((component) => -component);
  const ndotl = normalWC.reduce(
    (sum, component, index) => sum + component * incomingDirectionWC[index],
    0,
  );
  const diffuse = computeDeckFreeDayNightDiffuse(
    ndotlTarget,
    DECK_FREE_EXPECTED_LIGHTING_FADE,
  );
  const terminatorGlowLuma = computeDeckFreeTerminatorGlowLuma(
    ndotlTarget,
    terminatorGlowStrength,
  );
  const nightBlend = computeDeckFreeNightBlend(ndotlTarget);
  const nightDarkeningMultiplier = computeDeckFreeNightDarkeningMultiplier(
    ndotlTarget,
    effectiveNightDarkness,
  );
  return {
    normalWC,
    eastWC,
    incomingDirectionWC,
    emittedDirectionWC,
    ndotl,
    diffuse,
    terminatorGlowStrength,
    terminatorGlowLuma,
    nightBlend,
    effectiveNightDarkness,
    nightDarkeningMultiplier,
    diagnosticLuma: computeDeckFreeDirectionalDiagnosticLuma(
      ndotlTarget,
      DECK_FREE_EXPECTED_LIGHTING_FADE,
      terminatorGlowStrength,
      effectiveNightDarkness,
    ),
  };
}

/**
 * Independently evaluate the 3D camera-distance fade from reported evidence.
 * This mirrors the public law, not an engine accessor, so a stale or fabricated
 * `expectedFade` readback cannot certify itself.
 */
export function computeDeckFreeLightingFade(
  cameraDistance,
  fadeOutDistance,
  fadeInDistance,
) {
  if (
    !Number.isFinite(cameraDistance) ||
    !Number.isFinite(fadeOutDistance) ||
    !Number.isFinite(fadeInDistance)
  ) {
    return null;
  }
  const span = fadeInDistance - fadeOutDistance;
  if (!(span > 0)) {
    return null;
  }
  const fade = (cameraDistance - fadeOutDistance) / span;
  return fade < 0 ? 0 : fade > 1 ? 1 : fade;
}

const finiteMean = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const spread = (values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) - Math.min(...finite) : null;
};

const expectedBaseColor = Object.freeze([
  DECK_FREE_BASE_COLOR_CHANNEL,
  DECK_FREE_BASE_COLOR_CHANNEL,
  DECK_FREE_BASE_COLOR_CHANNEL,
  1,
]);

const baseColorIsPinned = (value) =>
  Array.isArray(value) &&
  value.length === expectedBaseColor.length &&
  value.every((channel, index) => channel === expectedBaseColor[index]);

const factorsMatch = (left, right, tolerance) =>
  Number.isFinite(left) &&
  Number.isFinite(right) &&
  Math.abs(left - right) <= tolerance;

const vectorsMatch = (left, right, tolerance = 1e-10) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === 3 &&
  right.length === 3 &&
  left.every(
    (component, index) =>
      Number.isFinite(component) &&
      Number.isFinite(right[index]) &&
      Math.abs(component - right[index]) <= tolerance,
  );

const colorsMatch = (value) =>
  Array.isArray(value) &&
  value.length === DECK_FREE_LIGHT_COLOR.length &&
  value.every((channel, index) => channel === DECK_FREE_LIGHT_COLOR[index]);

const lightSideMatches = (side, kind, direction) =>
  side?.constructorName === kind &&
  side?.isSunLight === (kind === "SunLight") &&
  side?.isDirectionalLight === (kind === "DirectionalLight") &&
  side?.intensity ===
    (kind === "SunLight"
      ? DECK_FREE_SUN_LIGHT_INTENSITY
      : DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY) &&
  colorsMatch(side?.color) &&
  (kind === "SunLight"
    ? side?.directionWC === null
    : vectorsMatch(side?.directionWC, direction));

const sunLightEvidenceIsRestored = (evidence) =>
  evidence?.sameObject === true &&
  evidence?.diagnosticOnly === false &&
  lightSideMatches(evidence?.scene, "SunLight", null) &&
  lightSideMatches(evidence?.frameState, "SunLight", null);

const directionalLightEvidenceMatches = (evidence, direction) =>
  evidence?.sameObject === true &&
  evidence?.diagnosticOnly === true &&
  lightSideMatches(evidence?.scene, "DirectionalLight", direction) &&
  lightSideMatches(evidence?.frameState, "DirectionalLight", direction);

const lightingFadeEvidenceIsLive = (evidence) => {
  const outDistance = finiteMean(evidence?.outDistance);
  const inDistance = finiteMean(evidence?.inDistance);
  const cameraDistance = finiteMean(evidence?.cameraDistance);
  const reportedExpectedFade = finiteMean(evidence?.expectedFade);
  const independentlyExpectedFade = computeDeckFreeLightingFade(
    cameraDistance,
    outDistance,
    inDistance,
  );
  return (
    outDistance === DECK_FREE_LIGHTING_FADE_OUT_DISTANCE &&
    inDistance === DECK_FREE_LIGHTING_FADE_IN_DISTANCE &&
    independentlyExpectedFade === DECK_FREE_EXPECTED_LIGHTING_FADE &&
    reportedExpectedFade === independentlyExpectedFade
  );
};

/**
 * Whether the night-darkening term the surface carries is the control's pin
 * rather than whatever the engine happens to default to, and whether the
 * coverage input that scales it is pinned at zero by the removed imagery.
 *
 * The LAW stays Node-side; only its two configuration inputs are observed,
 * which is the same division `lightingFadeEvidenceIsLive` draws.
 */
const nightDarkeningEvidenceIsLive = (evidence, expectedNightDarkness) => {
  const publicValue = finiteMean(evidence?.publicValue);
  const tileProviderValue = finiteMean(evidence?.tileProviderValue);
  // No layer is what pins the coverage share at zero; the two are different
  // quantities that only happen to share a value here.
  if (evidence?.imageryLayerCount !== 0) {
    return false;
  }
  return (
    publicValue === expectedNightDarkness &&
    tileProviderValue === expectedNightDarkness
  );
};

/**
 * Validate and fold four fresh-context session reports into the legacy per-rung
 * field names consumed by the response gate. The `*Settled` fields now mean an
 * independent-session replicate; no same-page recapture is allowed to satisfy
 * the control.
 *
 * @param {object} options
 * @param {Array<object>} options.sessions
 * @param {Array<{target: number, iso: string, obscuration: number}>} options.ladder
 * @param {Array<object>} options.certifiedRungs Main cloud-page rungs whose
 * published factor has already been checked by the independent factor gate.
 * @param {number} options.factorTolerance Maximum f64 factor disagreement.
 * @param {number} options.scheduleObscurationTolerance Maximum geometric
 * disagreement between the ellipsoid-height schedule and the rendered lane.
 * @param {number} options.captureDelta Smallest resolvable band-mean delta.
 * @param {{latitudeDegrees: number, longitudeDegrees: number}} options.diagnosticSite
 * Fixed site used to derive the diagnostic DirectionalLight vectors.
 * @returns {object}
 */
export function foldDeckFreeControlSessions(options) {
  const {
    sessions,
    ladder,
    certifiedRungs,
    factorTolerance,
    scheduleObscurationTolerance,
    captureDelta,
    diagnosticSite,
  } = options;
  const reasons = [];
  const reports = Array.isArray(sessions) ? sessions : [];
  const expectedLadder = Array.isArray(ladder) ? ladder : [];
  const certified = Array.isArray(certifiedRungs) ? certifiedRungs : [];

  if (reports.length !== DECK_FREE_CONTROL_SESSION_PLAN.length) {
    reasons.push(
      `expected ${DECK_FREE_CONTROL_SESSION_PLAN.length} fresh control sessions, received ${reports.length}`,
    );
  }
  if (!(captureDelta > 0)) {
    reasons.push(`captureDelta must be positive, received ${captureDelta}`);
  }
  if (!(Number.isFinite(factorTolerance) && factorTolerance >= 0)) {
    reasons.push(
      `factorTolerance must be finite and non-negative, received ${factorTolerance}`,
    );
  }
  if (!(
    Number.isFinite(scheduleObscurationTolerance) &&
    scheduleObscurationTolerance >= 0
  )) {
    reasons.push(
      `scheduleObscurationTolerance must be finite and non-negative, received ${scheduleObscurationTolerance}`,
    );
  }
  if (certified.length !== expectedLadder.length) {
    reasons.push(
      `expected ${expectedLadder.length} certified main-page rungs, received ${certified.length}`,
    );
  }
  if (
    !Number.isFinite(diagnosticSite?.latitudeDegrees) ||
    !Number.isFinite(diagnosticSite?.longitudeDegrees)
  ) {
    reasons.push("directional diagnostic site is absent or non-finite");
  }
  const effectiveFactorTolerance =
    Number.isFinite(factorTolerance) && factorTolerance >= 0
      ? factorTolerance
      : 0;
  const effectiveScheduleObscurationTolerance =
    Number.isFinite(scheduleObscurationTolerance) &&
    scheduleObscurationTolerance >= 0
      ? scheduleObscurationTolerance
      : 0;

  const tokens = new Set();
  for (let index = 0; index < DECK_FREE_CONTROL_SESSION_PLAN.length; index++) {
    const expected = DECK_FREE_CONTROL_SESSION_PLAN[index];
    const report = reports[index];
    if (!report) {
      reasons.push(`${expected.label}: session did not run`);
      continue;
    }
    if (report.sessionLabel !== expected.label) {
      reasons.push(
        `${expected.label}: report label is ${String(report.sessionLabel)}`,
      );
    }
    if (
      typeof report.sessionToken !== "string" ||
      report.sessionToken.length < 8
    ) {
      reasons.push(`${expected.label}: missing fresh-context session token`);
    } else if (tokens.has(report.sessionToken)) {
      reasons.push(
        `${expected.label}: session token ${report.sessionToken} was reused`,
      );
    } else {
      tokens.add(report.sessionToken);
    }
    if (report.eclipseEnabled !== expected.eclipseEnabled) {
      reasons.push(
        `${expected.label}: eclipse read-back is ${String(report.eclipseEnabled)}, expected ${expected.eclipseEnabled}`,
      );
    }
    if (report.configureCalls !== 1) {
      reasons.push(
        `${expected.label}: configureCalls is ${String(report.configureCalls)}, expected exactly 1`,
      );
    }
    if (report.configureTruth?.enableVolumetric !== false) {
      reasons.push(`${expected.label}: volumetric clouds are not disabled`);
    }
    if (report.rendererType !== "webgpu") {
      reasons.push(
        `${expected.label}: rendererType is ${String(report.rendererType)}, expected webgpu`,
      );
    }
    if (report.enableLighting !== true) {
      reasons.push(`${expected.label}: globe lighting is not enabled`);
    }
    if (!baseColorIsPinned(report.baseColor)) {
      reasons.push(
        `${expected.label}: baseColor is not pinned to 200/255 gray`,
      );
    }
    if (!lightingFadeEvidenceIsLive(report.lighting?.lightingFade)) {
      reasons.push(
        `${expected.label}: top-level lighting fade is not the live probe pin (out 0, in 1, independently expected fade 1)`,
      );
    }
    if (
      !nightDarkeningEvidenceIsLive(
        report.nightDarkening,
        DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
      )
    ) {
      reasons.push(
        `${expected.label}: top-level night-darkening pin is not restored to ${DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS} on a globe with zero imagery layers`,
      );
    }
    const priorTerminatorGlowStrength = finiteMean(
      report.terminatorGlow?.priorStrength,
    );
    if (
      report.terminatorGlow?.supported !== true ||
      priorTerminatorGlowStrength === null ||
      priorTerminatorGlowStrength !== DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH
    ) {
      reasons.push(
        `${expected.label}: terminator-glow control is absent or its prior/default strength is not exactly ${DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH}`,
      );
    }
    if (
      priorTerminatorGlowStrength === null ||
      report.terminatorGlow?.publicStrength !== priorTerminatorGlowStrength ||
      report.terminatorGlow?.tileProviderStrength !==
        priorTerminatorGlowStrength
    ) {
      reasons.push(
        `${expected.label}: top-level terminator-glow strength was not restored exactly to its prior value`,
      );
    }
    if (
      report.captureSequence !== "directional-diagnostic-then-fresh-sun-scored"
    ) {
      reasons.push(
        `${expected.label}: capture sequence does not isolate the custom-light diagnostic from the fresh-Sun scored capture`,
      );
    }
    if (!sunLightEvidenceIsRestored(report.light)) {
      reasons.push(
        `${expected.label}: top-level light read-back is not a restored fresh SunLight`,
      );
    }
    if (
      !Array.isArray(report.rungs) ||
      report.rungs.length !== expectedLadder.length
    ) {
      reasons.push(
        `${expected.label}: expected ${expectedLadder.length} rung captures, received ${report.rungs?.length ?? "none"}`,
      );
      continue;
    }
    if (
      !Array.isArray(report.directionalDiagnosticRungs) ||
      report.directionalDiagnosticRungs.length !== expectedLadder.length
    ) {
      reasons.push(
        `${expected.label}: expected ${expectedLadder.length} directional diagnostic captures, received ${report.directionalDiagnosticRungs?.length ?? "none"}`,
      );
    }
    for (let rungIndex = 0; rungIndex < expectedLadder.length; rungIndex++) {
      const expectedRung = expectedLadder[rungIndex];
      const certifiedRung = certified[rungIndex];
      const rung = report.rungs[rungIndex];
      if (
        rung?.target !== expectedRung.target ||
        rung?.iso !== expectedRung.iso
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} does not match the shared ladder`,
        );
      }
      if (!lightingFadeEvidenceIsLive(rung?.lighting?.lightingFade)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} lighting fade is not the live probe pin (out 0, in 1, independently expected fade 1)`,
        );
      }
      if (finiteMean(rung?.mean) === null || !(rung?.samples > 0)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} has no non-vacuous band measurement`,
        );
      }
      if (rung?.enableVolumetric !== false) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} re-enabled volumetric clouds`,
        );
      }
      if (rung?.eclipseEnabled !== expected.eclipseEnabled) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} eclipse state changed after configure`,
        );
      }
      if (rung?.configureCalls !== 1) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} observed ${String(rung?.configureCalls)} configure calls`,
        );
      }
      if (rung?.enableLighting !== true) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} globe lighting is not enabled`,
        );
      }
      if (
        priorTerminatorGlowStrength === null ||
        rung?.terminatorGlowStrength !== priorTerminatorGlowStrength ||
        rung?.terminatorGlowTileProviderStrength !== priorTerminatorGlowStrength
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} scored Sun capture did not restore the exact prior terminator-glow strength`,
        );
      }
      if (!baseColorIsPinned(rung?.baseColor)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} baseColor is not pinned to 200/255 gray`,
        );
      }
      if (rung?.captureRole !== "scored-real-sun-factor") {
        reasons.push(
          `${expected.label}: rung ${rungIndex} is not labelled as the scored real-Sun factor capture`,
        );
      }
      if (!sunLightEvidenceIsRestored(rung?.light)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} did not restore and render a fresh SunLight before scoring`,
        );
      }
      if (
        rung?.lighting?.enableLighting !== true ||
        rung?.lighting?.enableEclipse !== expected.eclipseEnabled ||
        rung?.lighting?.eclipseStateEnabled !== expected.eclipseEnabled ||
        rung?.lighting?.eclipseStateValid !== true ||
        rung?.lighting?.enableEclipseGlobeShadow !== false
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} lighting read-back does not match the fixed eclipse state`,
        );
      }
      if (
        certifiedRung?.target !== expectedRung.target ||
        certifiedRung?.iso !== expectedRung.iso
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} has no matching certified main-page rung`,
        );
      }
      const measuredFactor = finiteMean(rung?.factor);
      const measuredLightingFactor = finiteMean(rung?.lighting?.factor);
      const measuredObscuration = finiteMean(rung?.lighting?.moonObscuration);
      const measuredCameraHeight = finiteMean(rung?.cameraHeight);
      const expectedObscuration = finiteMean(expectedRung?.obscuration);
      const certifiedPublished = certifiedRung?.published;
      const certifiedScheduledObscuration = finiteMean(
        certifiedRung?.scheduledObscuration,
      );
      const certifiedObscuration = finiteMean(
        certifiedPublished?.moonObscuration,
      );
      const certifiedFactor = finiteMean(certifiedPublished?.factor);
      const deckFreePublished = certifiedRung?.deckFreePublished;
      const deckFreeCertifiedObscuration = finiteMean(
        deckFreePublished?.moonObscuration,
      );
      const deckFreeCertifiedFactor = finiteMean(deckFreePublished?.factor);
      const deckFreeCertifiedCameraHeight = finiteMean(
        deckFreePublished?.cameraHeight,
      );
      const laneBCameraHeight = finiteMean(certifiedRung?.shadow?.cameraHeight);

      if (certifiedPublished?.valid !== true) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page eclipse state is not valid`,
        );
      }
      if (certifiedPublished?.enabled !== true) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page eclipse state is not enabled`,
        );
      }
      if (
        expectedObscuration === null ||
        certifiedScheduledObscuration === null ||
        Math.abs(certifiedScheduledObscuration - expectedObscuration) >
          effectiveFactorTolerance
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page schedule does not match the derived ladder`,
        );
      }
      if (expectedObscuration === null || certifiedObscuration === null) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} scheduled or certified main-page obscuration is not finite`,
        );
      } else if (
        Math.abs(certifiedObscuration - expectedObscuration) >
        effectiveScheduleObscurationTolerance
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page obscuration ${certifiedObscuration} drifted from scheduled ${expectedObscuration}`,
        );
      }
      if (certifiedFactor === null) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page factor is not finite`,
        );
      } else if (
        certifiedObscuration === null ||
        !factorsMatch(
          certifiedFactor,
          predictFactor(certifiedObscuration),
          effectiveFactorTolerance,
        )
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} certified main-page factor does not match the independent prediction`,
        );
      }
      if (
        deckFreePublished?.valid !== true ||
        deckFreePublished?.enabled !== true
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} deck-free main-page certification is not valid and enabled`,
        );
      }
      if (
        expectedObscuration === null ||
        deckFreeCertifiedObscuration === null ||
        Math.abs(deckFreeCertifiedObscuration - expectedObscuration) >
          effectiveScheduleObscurationTolerance
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} deck-free main-page obscuration ${String(deckFreeCertifiedObscuration)} drifted from scheduled ${String(expectedObscuration)}`,
        );
      }
      if (
        measuredCameraHeight === null ||
        deckFreeCertifiedCameraHeight === null ||
        laneBCameraHeight === null ||
        measuredCameraHeight !== deckFreeCertifiedCameraHeight ||
        measuredCameraHeight !== laneBCameraHeight
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} measurement factor is not bound to the certified lane-B camera height`,
        );
      }
      if (
        deckFreeCertifiedObscuration === null ||
        deckFreeCertifiedFactor === null ||
        !factorsMatch(
          deckFreeCertifiedFactor,
          predictFactor(deckFreeCertifiedObscuration),
          effectiveFactorTolerance,
        )
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} deck-free main-page factor is absent or not independently predicted`,
        );
      }
      if (
        measuredObscuration === null ||
        deckFreeCertifiedObscuration === null ||
        Math.abs(measuredObscuration - deckFreeCertifiedObscuration) >
          effectiveScheduleObscurationTolerance
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} fresh-session obscuration does not match the deck-free main-page certification`,
        );
      }
      if (expected.eclipseEnabled) {
        if (
          measuredLightingFactor === null ||
          !factorsMatch(
            measuredLightingFactor,
            measuredFactor,
            effectiveFactorTolerance,
          )
        ) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} factor read-backs disagree`,
          );
        }
        if (
          measuredLightingFactor === null ||
          deckFreeCertifiedFactor === null ||
          !factorsMatch(
            measuredLightingFactor,
            deckFreeCertifiedFactor,
            effectiveFactorTolerance,
          )
        ) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} lighting factor ${String(measuredLightingFactor)} does not match certified main-page factor ${String(deckFreeCertifiedFactor)}`,
          );
        }
        if (measuredFactor === null) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} eclipse-ON factor is not finite`,
          );
        }
        if (deckFreeCertifiedFactor === null) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} certified deck-free main-page factor is not finite`,
          );
        } else if (
          !factorsMatch(
            measuredFactor,
            deckFreeCertifiedFactor,
            effectiveFactorTolerance,
          )
        ) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} factor ${String(measuredFactor)} does not match certified main-page factor ${deckFreeCertifiedFactor}`,
          );
        }
      } else {
        if (measuredFactor !== 1) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} eclipse-OFF factor is ${String(measuredFactor)}, expected exactly 1`,
          );
        }
        if (measuredLightingFactor !== 1) {
          reasons.push(
            `${expected.label}: rung ${rungIndex} eclipse-OFF lighting factor is ${String(measuredLightingFactor)}, expected exactly 1`,
          );
        }
      }

      const diagnostic = report.directionalDiagnosticRungs?.[rungIndex];
      const ndotlTarget = DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[rungIndex];
      const expectedFrame = computeDeckFreeDiagnosticFrame(
        diagnosticSite?.latitudeDegrees,
        diagnosticSite?.longitudeDegrees,
        ndotlTarget,
        DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
        computeDeckFreeEffectiveNightDarkness(
          DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
          DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
        ),
      );
      if (
        diagnostic?.target !== expectedRung.target ||
        diagnostic?.iso !== expectedRung.iso ||
        diagnostic?.captureRole !== "diagnostic-directional-daynight" ||
        diagnostic?.diagnosticOnly !== true ||
        diagnostic?.ndotlTarget !== ndotlTarget
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} directional diagnostic is absent, reordered, or not diagnostic-only`,
        );
      }
      if (
        !expectedFrame ||
        !vectorsMatch(
          diagnostic?.directionSpec?.surfaceNormalWC,
          expectedFrame?.normalWC,
        ) ||
        !vectorsMatch(
          diagnostic?.directionSpec?.eastWC,
          expectedFrame?.eastWC,
        ) ||
        !vectorsMatch(
          diagnostic?.directionSpec?.incomingDirectionWC,
          expectedFrame?.incomingDirectionWC,
        ) ||
        !vectorsMatch(
          diagnostic?.directionSpec?.emittedDirectionWC,
          expectedFrame?.emittedDirectionWC,
        ) ||
        !factorsMatch(
          diagnostic?.directionSpec?.ndotl,
          expectedFrame?.ndotl,
          1e-10,
        ) ||
        !factorsMatch(
          diagnostic?.directionSpec?.expectedDiffuse,
          expectedFrame?.diffuse,
          1e-10,
        ) ||
        diagnostic?.terminatorGlowStrength !==
          DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH ||
        diagnostic?.terminatorGlowTileProviderStrength !==
          DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} directional vector or DAYNIGHT prediction does not match the independent geodetic construction, or diagnostic terminator-glow strength is not exact`,
        );
      }
      if (
        !directionalLightEvidenceMatches(
          diagnostic?.light,
          expectedFrame?.emittedDirectionWC,
        )
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} custom-light read-back is not the exact diagnostic DirectionalLight`,
        );
      }
      if (
        diagnostic?.eclipseEnabled !== expected.eclipseEnabled ||
        diagnostic?.enableVolumetric !== false ||
        diagnostic?.enableLighting !== true ||
        diagnostic?.configureCalls !== 1 ||
        !baseColorIsPinned(diagnostic?.baseColor) ||
        diagnostic?.lighting?.enableLighting !== true ||
        diagnostic?.lighting?.enableEclipse !== expected.eclipseEnabled ||
        diagnostic?.lighting?.eclipseStateEnabled !== expected.eclipseEnabled ||
        diagnostic?.lighting?.eclipseStateValid !== true ||
        diagnostic?.lighting?.enableEclipseGlobeShadow !== false ||
        !lightingFadeEvidenceIsLive(diagnostic?.lighting?.lightingFade) ||
        !nightDarkeningEvidenceIsLive(
          diagnostic?.nightDarkening,
          DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
        )
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} directional diagnostic read-back does not preserve the fixed control state`,
        );
      }
      if (finiteMean(diagnostic?.mean) === null || !(diagnostic?.samples > 0)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} directional diagnostic has no non-vacuous pixel measurement`,
        );
      }
      if (
        !factorsMatch(
          diagnostic?.factor,
          measuredFactor,
          effectiveFactorTolerance,
        ) ||
        !factorsMatch(
          diagnostic?.lighting?.factor,
          measuredLightingFactor,
          effectiveFactorTolerance,
        )
      ) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} diagnostic and scored real-Sun factor read-backs disagree`,
        );
      }
    }
  }

  const byLabel = Object.fromEntries(
    reports.map((report) => [report?.sessionLabel, report]),
  );
  const isolationReasons = [...reasons];
  const rungs = expectedLadder.map((expected, index) => {
    const offA = finiteMean(byLabel["off-a"]?.rungs?.[index]?.mean);
    const offB = finiteMean(byLabel["off-b"]?.rungs?.[index]?.mean);
    const onA = finiteMean(byLabel["on-a"]?.rungs?.[index]?.mean);
    const onB = finiteMean(byLabel["on-b"]?.rungs?.[index]?.mean);
    const offAFactor = finiteMean(byLabel["off-a"]?.rungs?.[index]?.factor);
    const offBFactor = finiteMean(byLabel["off-b"]?.rungs?.[index]?.factor);
    const onAFactor = finiteMean(byLabel["on-a"]?.rungs?.[index]?.factor);
    const onBFactor = finiteMean(byLabel["on-b"]?.rungs?.[index]?.factor);
    const onALightingFactor = finiteMean(
      byLabel["on-a"]?.rungs?.[index]?.lighting?.factor,
    );
    const onBLightingFactor = finiteMean(
      byLabel["on-b"]?.rungs?.[index]?.lighting?.factor,
    );
    const certifiedFactor = finiteMean(
      certified[index]?.deckFreePublished?.factor,
    );
    const scheduledMainFactor = finiteMean(certified[index]?.published?.factor);
    if (!factorsMatch(onAFactor, onBFactor, effectiveFactorTolerance)) {
      const reason =
        `rung ${index}: eclipse-ON fresh-session factors do not replicate ` +
        `(${String(onAFactor)} vs ${String(onBFactor)})`;
      reasons.push(reason);
      isolationReasons.push(reason);
    }
    if (
      !factorsMatch(
        onALightingFactor,
        onBLightingFactor,
        effectiveFactorTolerance,
      )
    ) {
      const reason =
        `rung ${index}: eclipse-ON nested lighting factors do not replicate ` +
        `(${String(onALightingFactor)} vs ${String(onBLightingFactor)})`;
      reasons.push(reason);
      isolationReasons.push(reason);
    }
    return {
      target: expected.target,
      iso: expected.iso,
      // A is the measurement; B is its independently-created replication. Do
      // not average a divergent pair into something that neither session saw.
      offNoCloud: offA,
      onNoCloud: onA,
      // Independent-session replicas, retained under the existing field names
      // so historical judge arithmetic stays readable and first-red artifacts
      // never need rewriting.
      offNoCloudSettled: offB,
      onNoCloudSettled: onB,
      offPrimary: offA,
      onPrimary: onA,
      offSessionDelta:
        Number.isFinite(offA) && Number.isFinite(offB)
          ? Math.abs(offA - offB)
          : null,
      onSessionDelta:
        Number.isFinite(onA) && Number.isFinite(onB)
          ? Math.abs(onA - onB)
          : null,
      factorEvidence: {
        certifiedMainPage: certifiedFactor,
        scheduledMainPage: scheduledMainFactor,
        scheduledObscuration: finiteMean(expected.obscuration),
        scheduledMainPageObscuration: finiteMean(
          certified[index]?.published?.moonObscuration,
        ),
        deckFreeMainPageObscuration: finiteMean(
          certified[index]?.deckFreePublished?.moonObscuration,
        ),
        offA: offAFactor,
        offB: offBFactor,
        onA: onAFactor,
        onB: onBFactor,
        onALighting: onALightingFactor,
        onBLighting: onBLightingFactor,
        onReplicationDelta:
          Number.isFinite(onAFactor) && Number.isFinite(onBFactor)
            ? Math.abs(onAFactor - onBFactor)
            : null,
        onLightingReplicationDelta:
          Number.isFinite(onALightingFactor) &&
          Number.isFinite(onBLightingFactor)
            ? Math.abs(onALightingFactor - onBLightingFactor)
            : null,
        cameraHeight: finiteMean(
          certified[index]?.deckFreePublished?.cameraHeight,
        ),
      },
    };
  });

  const offASeries = expectedLadder.map((_, index) =>
    finiteMean(byLabel["off-a"]?.rungs?.[index]?.mean),
  );
  const offBSeries = expectedLadder.map((_, index) =>
    finiteMean(byLabel["off-b"]?.rungs?.[index]?.mean),
  );
  const allOff = [...offASeries, ...offBSeries].filter(Number.isFinite);
  const maximumRawDistance =
    allOff.length > 0
      ? Math.max(
          ...allOff.map((value) =>
            Math.abs(value - DECK_FREE_RAW_BASE_COLOR_LUMA),
          ),
        )
      : null;
  const offASpread = spread(offASeries);
  const offBSpread = spread(offBSeries);
  // The real Sun is deliberately NOT the diffuse-path liveness discriminator:
  // all four Iceland NdotL values saturate the DAYNIGHT clamp at 1. Instead,
  // independently predicted custom-light captures exercise diffuse values
  // 0.3/0.5/0.7/0.9, after which every scored capture restores a fresh SunLight.
  // The central nadir diagnostic patch spans <2 km at 1400 m, so its geodetic
  // normal changes by <3.2e-4 and the 5x ramp changes by <0.0016. Two existing
  // capture deltas (one for that bound, one for the 8-bit band mean) are a
  // conservative evidence tolerance without moving any product band.
  const diagnosticPixelTolerance = captureDelta * 2;
  const nonVacuityReasons = [];
  const pinnedEffectiveNightDarkness = computeDeckFreeEffectiveNightDarkness(
    DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
    DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
  );
  const alternateEffectiveNightDarkness = computeDeckFreeEffectiveNightDarkness(
    DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE,
    DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
  );
  const directionalDiagnostic = expectedLadder.map((expected, index) => {
    const expectedFrame = computeDeckFreeDiagnosticFrame(
      diagnosticSite?.latitudeDegrees,
      diagnosticSite?.longitudeDegrees,
      DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index],
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
      pinnedEffectiveNightDarkness,
    );
    const offA = finiteMean(
      byLabel["off-a"]?.directionalDiagnosticRungs?.[index]?.mean,
    );
    const offB = finiteMean(
      byLabel["off-b"]?.directionalDiagnosticRungs?.[index]?.mean,
    );
    const onA = finiteMean(
      byLabel["on-a"]?.directionalDiagnosticRungs?.[index]?.mean,
    );
    const onB = finiteMean(
      byLabel["on-b"]?.directionalDiagnosticRungs?.[index]?.mean,
    );
    const factor = finiteMean(certified[index]?.deckFreePublished?.factor);
    const expectedOff = finiteMean(expectedFrame?.diagnosticLuma);
    // The custom DirectionalLight is deliberately NOT an eclipse-factor lane:
    // UniformState applies S2 only to SunLight, and this control disables the
    // fragment-local eclipse-globe shadow. Its ON/OFF identity proves the
    // diagnostic stayed out of the SunLight-only factor path; F is certified
    // exclusively by the restored-Sun scored captures above.
    const expectedOn = expectedOff;
    const offReplicaDelta =
      Number.isFinite(offA) && Number.isFinite(offB)
        ? Math.abs(offA - offB)
        : null;
    const onReplicaDelta =
      Number.isFinite(onA) && Number.isFinite(onB) ? Math.abs(onA - onB) : null;
    const onOffRatioA =
      Number.isFinite(onA) && Number.isFinite(offA) && offA > 0
        ? onA / offA
        : null;
    const onOffRatioB =
      Number.isFinite(onB) && Number.isFinite(offB) && offB > 0
        ? onB / offB
        : null;
    const ratioTolerance =
      Number.isFinite(expectedOff) && expectedOff > 0
        ? (diagnosticPixelTolerance / expectedOff) * 2
        : 0;
    const pixelsFollowLaw =
      Number.isFinite(expectedOff) &&
      Number.isFinite(expectedOn) &&
      [offA, offB].every(
        (value) =>
          Number.isFinite(value) &&
          Math.abs(value - expectedOff) <= diagnosticPixelTolerance,
      ) &&
      [onA, onB].every(
        (value) =>
          Number.isFinite(value) &&
          Math.abs(value - expectedOn) <= diagnosticPixelTolerance,
      );
    const replicasAgree =
      Number.isFinite(offReplicaDelta) &&
      offReplicaDelta <= diagnosticPixelTolerance &&
      Number.isFinite(onReplicaDelta) &&
      onReplicaDelta <= diagnosticPixelTolerance;
    const ratioIsIdentity =
      Number.isFinite(onOffRatioA) &&
      Math.abs(onOffRatioA - 1) <= ratioTolerance &&
      Number.isFinite(onOffRatioB) &&
      Math.abs(onOffRatioB - 1) <= ratioTolerance;
    if (!pixelsFollowLaw) {
      nonVacuityReasons.push(
        `rung ${index}: diagnostic DirectionalLight pixels do not execute DAYNIGHT diffuse ${String(expectedFrame?.diffuse)} plus terminator-glow luma ${String(expectedFrame?.terminatorGlowLuma)} within ${diagnosticPixelTolerance} (OFF ${String(offA)}/${String(offB)} expected ${String(expectedOff)}, ON ${String(onA)}/${String(onB)} expected ${String(expectedOn)})`,
      );
    }
    if (!replicasAgree) {
      nonVacuityReasons.push(
        `rung ${index}: diagnostic DirectionalLight replicas disagree (OFF delta ${String(offReplicaDelta)}, ON delta ${String(onReplicaDelta)}, limit ${diagnosticPixelTolerance})`,
      );
    }
    if (!ratioIsIdentity) {
      nonVacuityReasons.push(
        `rung ${index}: diagnostic-only DirectionalLight ON/OFF ratios ${String(onOffRatioA)}/${String(onOffRatioB)} are not eclipse-invariant at 1 within ${ratioTolerance}; the SunLight-only factor lane was contaminated`,
      );
    }
    return {
      target: expected.target,
      iso: expected.iso,
      ndotlTarget: DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index],
      expectedDiffuse: expectedFrame?.diffuse ?? null,
      expectedTerminatorGlowLuma: expectedFrame?.terminatorGlowLuma ?? null,
      expectedNightBlend: expectedFrame?.nightBlend ?? null,
      expectedNightDarkeningMultiplier:
        expectedFrame?.nightDarkeningMultiplier ?? null,
      expectedOff,
      expectedOn,
      offA,
      offB,
      onA,
      onB,
      offReplicaDelta,
      onReplicaDelta,
      onOffRatioA,
      onOffRatioB,
      certifiedFactor: factor,
      ratioTolerance,
      pixelsFollowLaw,
      replicasAgree,
      ratioIsIdentity,
    };
  });
  for (const [label, field] of [
    ["off-a", "offA"],
    ["off-b", "offB"],
  ]) {
    const values = directionalDiagnostic.map((entry) => entry[field]);
    for (let index = 1; index < values.length; index++) {
      if (
        !Number.isFinite(values[index - 1]) ||
        !Number.isFinite(values[index]) ||
        !(values[index] - values[index - 1] > diagnosticPixelTolerance)
      ) {
        nonVacuityReasons.push(
          `${label}: diagnostic DAYNIGHT pixels do not increase across the unsaturated NdotL ladder`,
        );
        break;
      }
    }
  }

  // The night-darkening flow-through leg. Rung 0 sits at N·L = 0, where the
  // ramp is fully night and the floor reaches the surface undiluted, so the
  // same fragment captured under a second pinned floor must move by the
  // predicted amount. Without this leg the floor is a constant the closed form
  // could absorb — which is exactly how the term entered the shipped fragment
  // without the model noticing.
  const alternateNightDarknessFrame = computeDeckFreeDiagnosticFrame(
    diagnosticSite?.latitudeDegrees,
    diagnosticSite?.longitudeDegrees,
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[0],
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
    alternateEffectiveNightDarkness,
  );
  const expectedAlternateLuma = finiteMean(
    alternateNightDarknessFrame?.diagnosticLuma,
  );
  const nightDarknessFlowThrough = DECK_FREE_CONTROL_SESSION_PLAN.map(
    (planned) => {
      const report = byLabel[planned.label];
      const leg = report?.nightDarknessAlternate;
      const measured = finiteMean(leg?.mean);
      const primary = finiteMean(report?.directionalDiagnosticRungs?.[0]?.mean);
      const pinIsLive = nightDarkeningEvidenceIsLive(
        leg?.nightDarkening,
        DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE,
      );
      const followsLaw =
        Number.isFinite(measured) &&
        Number.isFinite(expectedAlternateLuma) &&
        Math.abs(measured - expectedAlternateLuma) <= diagnosticPixelTolerance;
      const separationFromPrimary =
        Number.isFinite(measured) && Number.isFinite(primary)
          ? Math.abs(measured - primary)
          : null;
      const separates =
        Number.isFinite(separationFromPrimary) &&
        separationFromPrimary > diagnosticPixelTolerance;
      if (
        leg?.captureRole !== "diagnostic-directional-night-darkness" ||
        leg?.diagnosticOnly !== true ||
        leg?.ndotlTarget !== DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[0] ||
        !(leg?.samples > 0) ||
        !pinIsLive
      ) {
        nonVacuityReasons.push(
          `${planned.label}: the alternate night-darkness leg is absent, mislabelled, or not pinned to ${DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE}`,
        );
      }
      if (!followsLaw) {
        nonVacuityReasons.push(
          `${planned.label}: alternate night-darkness pixels ${String(measured)} do not execute the night floor ${DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE} within ${diagnosticPixelTolerance} (expected ${String(expectedAlternateLuma)})`,
        );
      }
      if (!separates) {
        nonVacuityReasons.push(
          `${planned.label}: the two pinned night floors are not resolvable in the pixels (separation ${String(separationFromPrimary)}, limit ${diagnosticPixelTolerance}); the surface is not reading the uniform`,
        );
      }
      return {
        label: planned.label,
        nightDarkness: DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE,
        expected: expectedAlternateLuma,
        measured,
        primary,
        separationFromPrimary,
        pinIsLive,
        followsLaw,
        separates,
      };
    },
  );

  const litSurfaceNonVacuous = nonVacuityReasons.length === 0;
  reasons.push(...nonVacuityReasons);

  return {
    schema: "c13-41-deckfree-control-v6",
    stateIsolated: isolationReasons.length === 0,
    structuralReasons: reasons,
    isolationReasons,
    nonVacuityReasons,
    sessionOrder: reports.map((report) => report?.sessionLabel ?? null),
    sessionTokens: reports.map((report) => report?.sessionToken ?? null),
    rawBaseColorLuma: DECK_FREE_RAW_BASE_COLOR_LUMA,
    expectedBaseColor,
    factorTolerance: effectiveFactorTolerance,
    scheduleObscurationTolerance: effectiveScheduleObscurationTolerance,
    maximumRawDistance,
    offASpread,
    offBSpread,
    diagnosticPixelTolerance,
    pinnedEffectiveNightDarkness,
    alternateEffectiveNightDarkness,
    directionalDiagnostic,
    nightDarknessFlowThrough,
    litSurfaceNonVacuous,
    rungs,
    sessions: reports,
  };
}
