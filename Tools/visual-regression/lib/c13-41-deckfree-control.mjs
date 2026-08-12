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
    if (
      !Array.isArray(report.rungs) ||
      report.rungs.length !== expectedLadder.length
    ) {
      reasons.push(
        `${expected.label}: expected ${expectedLadder.length} rung captures, received ${report.rungs?.length ?? "none"}`,
      );
      continue;
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
      if (!baseColorIsPinned(rung?.baseColor)) {
        reasons.push(
          `${expected.label}: rung ${rungIndex} baseColor is not pinned to 200/255 gray`,
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
  const litSurfaceNonVacuous =
    Number.isFinite(maximumRawDistance) &&
    maximumRawDistance > captureDelta &&
    Number.isFinite(offASpread) &&
    offASpread > captureDelta &&
    Number.isFinite(offBSpread) &&
    offBSpread > captureDelta;

  const nonVacuityReasons = litSurfaceNonVacuous
    ? []
    : [
        `deck-free surface is not a live lighting control: max distance from raw 200/255 baseColor is ${maximumRawDistance}, OFF-A sun spread is ${offASpread}, OFF-B sun spread is ${offBSpread}, required > ${captureDelta}`,
      ];
  reasons.push(...nonVacuityReasons);

  return {
    schema: "c13-41-deckfree-control-v3",
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
    litSurfaceNonVacuous,
    rungs,
    sessions: reports,
  };
}
