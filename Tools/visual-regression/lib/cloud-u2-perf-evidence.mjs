/**
 * Pure manifest policy for the C13-16 U2 cross-bundle GPU timing gate.
 * @purpose Manifest policy for the C13-16 U2 cross-bundle GPU-timing gate: comparison, environment-drift rejection, immutable evidence naming.
 * @status ACTIVE
 *
 * Browser collection lives in probe-cloud-u2-perf.mjs; this module keeps the
 * comparison, drift rejection, and immutable evidence naming executable under
 * node --test.
 */

export const CLOUD_U2_MANIFEST_VERSION = "c13-16-u2-perf/1";
export const CLOUD_U2_REGRESSION_BAND_PCT = 2;
// Same-bundle cross-round measurement (three pairs, campaigns b1108b/c:
// r0 and r1 re-measure the SAME binary) put the micro-pass controls' pure
// session noise at |dMs| up to 0.050 ms (CloudTemporalResolve) and 0.102 ms
// (CloudUpscale composite) with relative swings to 305% - GPU timestamp
// attribution on 30-170 us passes, not drift. A control below this absolute
// floor cannot fire the drift discard; the 2% relative band still governs
// every control of adequate magnitude. Floor = 2x the worst observed
// same-bundle delta.
export const CLOUD_U2_CONTROL_ABS_FLOOR_MS = 0.21;

export const CLOUD_U2_CONTROL_BAND_PCT = 2;

const VALID_TAGS = new Set(["pre", "post"]);
const VALID_ORDERS = new Set(["pre-first", "post-first"]);

function stableJson(value) {
  return JSON.stringify(value);
}

function environmentKey(manifest) {
  return stableJson({
    manifestVersion: manifest?.manifestVersion,
    adapterInfo: manifest?.environment?.adapterInfo ?? null,
    browserVersion: manifest?.environment?.browserVersion ?? null,
    canvas: manifest?.environment?.canvas ?? null,
    viewport: manifest?.environment?.viewport ?? null,
    measurement: manifest?.measurement ?? null,
  });
}

function laneReplayKey(lane) {
  return stableJson({
    id: lane?.id,
    routeId: lane?.routeId,
    genus: lane?.genus,
    volumetric: lane?.volumetric,
    camera: lane?.camera,
    clock: lane?.clock,
    expect: lane?.expect,
    requireBakedDensity: lane?.requireBakedDensity,
  });
}

function passDelta(preMs, postMs) {
  if (!Number.isFinite(preMs) || !Number.isFinite(postMs) || preMs <= 0) {
    return { preMs, postMs, deltaMs: null, deltaPct: null };
  }
  const deltaMs = +(postMs - preMs).toFixed(6);
  return {
    preMs,
    postMs,
    deltaMs,
    deltaPct: +((deltaMs / preMs) * 100).toFixed(2),
  };
}

export function cloudU2ManifestFilename({ pairId, round, order, tag }) {
  if (typeof pairId !== "string" || pairId.length === 0) {
    throw new Error("pairId is required");
  }
  if (!Number.isInteger(round) || round < 0) {
    throw new Error("round must be a non-negative integer");
  }
  if (!VALID_ORDERS.has(order)) {
    throw new Error("order must be pre-first or post-first");
  }
  if (!VALID_TAGS.has(tag)) {
    throw new Error("tag must be pre or post");
  }
  return `cloud-u2-${pairId}-r${round}-${order}-${tag}.json`;
}

export function cloudU2SummaryFilename(pairId) {
  if (typeof pairId !== "string" || pairId.length === 0) {
    throw new Error("pairId is required");
  }
  return `cloud-u2-${pairId}-summary.json`;
}

/**
 * Assess immutable per-leg manifests. Untouched-pass motion discards a round;
 * an affected pass over budget or a changed CUMULUS pixel hash is a product
 * failure. CIRRUS has an intentional visual change, so it is checked for a
 * non-vacuous subject instead of pixel identity.
 */
export function assessCloudU2PerfManifests(input = {}) {
  const manifests = Array.isArray(input.manifests) ? input.manifests : [];
  const regressionBandPct =
    input.regressionBandPct ?? CLOUD_U2_REGRESSION_BAND_PCT;
  const controlBandPct = input.controlBandPct ?? CLOUD_U2_CONTROL_BAND_PCT;
  const failures = [];
  const globalStructuralFailures = [];

  if (manifests.length === 0) {
    return {
      status: "no-manifests",
      complete: false,
      passed: false,
      structural: true,
      failures: ["no manifests supplied"],
      rounds: [],
      bundleIdentity: null,
      verdict: {},
    };
  }

  const pairIds = new Set(manifests.map((manifest) => manifest?.pairId));
  if (pairIds.size !== 1 || pairIds.has(null) || pairIds.has(undefined)) {
    return {
      status: "incomparable-pair",
      complete: false,
      passed: false,
      structural: true,
      failures: ["all manifests must share one non-null pairId"],
      rounds: [],
      bundleIdentity: null,
      verdict: {},
    };
  }

  if (
    manifests.some(
      (manifest) => manifest?.manifestVersion !== CLOUD_U2_MANIFEST_VERSION,
    )
  ) {
    const failure = `every manifest must use ${CLOUD_U2_MANIFEST_VERSION}`;
    failures.push(failure);
    globalStructuralFailures.push(failure);
  }

  if (new Set(manifests.map(environmentKey)).size !== 1) {
    return {
      status: "incomparable-environment",
      complete: false,
      passed: false,
      structural: true,
      failures: [
        "manifest version, adapter, browser, canvas, viewport, and measurement settings must match",
      ],
      rounds: [],
      bundleIdentity: null,
      verdict: {},
    };
  }

  const shasByTag = { pre: new Set(), post: new Set() };
  for (const manifest of manifests) {
    if (!VALID_TAGS.has(manifest?.tag)) {
      const failure = `unknown tag ${String(manifest?.tag)}`;
      failures.push(failure);
      globalStructuralFailures.push(failure);
      continue;
    }
    const sha = manifest?.source?.runtimeBundle?.sha256;
    if (typeof sha !== "string" || sha.length === 0) {
      failures.push(
        `round ${String(manifest?.round)} ${manifest.tag}: missing runtime bundle sha256`,
      );
    } else {
      shasByTag[manifest.tag].add(sha);
    }
  }
  const preShas = [...shasByTag.pre];
  const postShas = [...shasByTag.post];
  const stableBundles = preShas.length <= 1 && postShas.length <= 1;
  const bothTagsPresent = preShas.length === 1 && postShas.length === 1;
  const distinctBundles = bothTagsPresent && preShas[0] !== postShas[0];
  const bundleIdentity = {
    preSha256: preShas.length === 1 ? preShas[0] : null,
    postSha256: postShas.length === 1 ? postShas[0] : null,
    stable: stableBundles,
    bothTagsPresent,
    distinct: distinctBundles,
  };
  if (!stableBundles) {
    failures.push(
      `each tag must use exactly one immutable bundle sha across the campaign (pre=${preShas.length}, post=${postShas.length})`,
    );
  } else if (bothTagsPresent && !distinctBundles) {
    failures.push("pre and post measured the same runtime bundle");
  } else if (!bothTagsPresent) {
    failures.push("both pre and post bundle identities are required");
  }

  const byRound = new Map();
  for (const manifest of manifests) {
    if (!Number.isInteger(manifest?.round) || manifest.round < 0) {
      const failure = `invalid round ${String(manifest?.round)}`;
      failures.push(failure);
      globalStructuralFailures.push(failure);
      continue;
    }
    const entry = byRound.get(manifest.round) ?? {
      round: manifest.round,
      order: manifest.order,
      duplicateTags: [],
    };
    if (entry.order !== manifest.order) {
      entry.orderMismatch = true;
    }
    if (VALID_TAGS.has(manifest.tag)) {
      if (entry[manifest.tag]) {
        entry.duplicateTags.push(manifest.tag);
      }
      entry[manifest.tag] = manifest;
    }
    byRound.set(manifest.round, entry);
  }

  const verdict = {};
  const productFailures = [];
  const rounds = [];
  for (const entry of [...byRound.values()].sort((a, b) => a.round - b.round)) {
    const roundFailures = [];
    if (!entry.pre || !entry.post) {
      roundFailures.push("incomplete round: one pre and one post are required");
    }
    if (!VALID_ORDERS.has(entry.order)) {
      roundFailures.push(`invalid order ${String(entry.order)}`);
    }
    if (entry.orderMismatch) {
      roundFailures.push("pre and post disagree about order");
    }
    if (entry.duplicateTags.length > 0) {
      roundFailures.push(
        `duplicate tag(s): ${[...new Set(entry.duplicateTags)].join(", ")}`,
      );
    }
    if (roundFailures.length > 0) {
      rounds.push({
        round: entry.round,
        order: entry.order,
        complete: false,
        usable: false,
        controlDrifted: false,
        failures: roundFailures,
        lanes: [],
      });
      continue;
    }

    const preLanes = new Map(
      (entry.pre.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const postLanes = new Map(
      (entry.post.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const preLaneIds = [...preLanes.keys()].sort();
    const postLaneIds = [...postLanes.keys()].sort();
    const acceptanceLaneIds = [
      ...(entry.post.measurement?.acceptanceLaneIds ?? []),
    ].sort();
    if (stableJson(preLaneIds) !== stableJson(postLaneIds)) {
      roundFailures.push("pre and post lane sets differ");
    }
    if (
      acceptanceLaneIds.length === 0 ||
      stableJson(postLaneIds) !== stableJson(acceptanceLaneIds)
    ) {
      roundFailures.push(
        "capture does not contain the full acceptance lane set",
      );
    }
    const lanes = [];
    let controlDrifted = false;
    const roundProductFailures = [];
    for (const postLane of entry.post.lanes ?? []) {
      const preLane = preLanes.get(postLane.id);
      if (!preLane) {
        roundFailures.push(`lane ${postLane.id} has no pre companion`);
        continue;
      }
      const sameReplay = laneReplayKey(preLane) === laneReplayKey(postLane);
      const genusId = postLane.genus?.id;
      const bothValid = preLane.valid === true && postLane.valid === true;
      if (!sameReplay) {
        roundFailures.push(`lane ${postLane.id} replay/configuration differs`);
      }
      if (!bothValid) {
        roundFailures.push(`lane ${postLane.id} has an invalid capture`);
      }
      const packedGenusRowsMatch =
        preLane.genusRowMatches === true && postLane.genusRowMatches === true;
      if (!packedGenusRowsMatch) {
        roundFailures.push(
          `lane ${postLane.id} did not prove its packed genus uniform row`,
        );
      }

      // Thin genera cannot clear the bright-cell census; the cirrus
      // subject proves itself by canvas mean luminance against the black
      // background (clouds-off is exactly zero there), with the floor
      // carried in the manifest's measurement block.
      const lumFloor = entry.post.measurement?.cirrusMinMeanLum;
      const lumFloorDeclared = Number.isFinite(lumFloor);
      if (genusId === "cirrus" && !lumFloorDeclared) {
        roundFailures.push(
          `lane ${postLane.id}: measurement block does not declare cirrusMinMeanLum`,
        );
      }
      const effectiveLumFloor = lumFloorDeclared
        ? lumFloor
        : Number.POSITIVE_INFINITY;
      const cirrusNonVacuous =
        genusId !== "cirrus" ||
        (preLane.fingerprint?.meanLum >= effectiveLumFloor &&
          postLane.fingerprint?.meanLum >= effectiveLumFloor);
      if (!cirrusNonVacuous) {
        roundFailures.push(
          `lane ${postLane.id} CIRRUS subject is vacuous below mean luminance ${lumFloor}`,
        );
      }

      const cumulusIdentity =
        genusId !== "cumulus" ||
        (typeof preLane.fingerprint?.pixelSha256 === "string" &&
          preLane.fingerprint.pixelSha256 ===
            postLane.fingerprint?.pixelSha256);
      if (!cumulusIdentity) {
        roundProductFailures.push(
          `round ${entry.round} lane ${postLane.id}: CUMULUS pixels changed`,
        );
      }

      const passes = {};
      for (const [name, expectation] of Object.entries(postLane.expect ?? {})) {
        const delta = passDelta(
          preLane.passes?.[name]?.medianAvgMs,
          postLane.passes?.[name]?.medianAvgMs,
        );
        let outcome = "missing";
        if (delta.deltaPct !== null) {
          if (expectation === "unchanged") {
            const material =
              Math.abs(delta.deltaMs) > CLOUD_U2_CONTROL_ABS_FLOOR_MS;
            const within =
              Math.abs(delta.deltaPct) <= controlBandPct || !material;
            outcome = within ? "control-stable" : "control-drift";
            controlDrifted ||= !within;
          } else if (expectation === "no-regression") {
            const within = delta.deltaPct <= regressionBandPct;
            outcome = within ? "within-budget" : "regressed";
            if (!within) {
              roundProductFailures.push(
                `round ${entry.round} lane ${postLane.id} pass ${name}: ${delta.deltaPct}% > +${regressionBandPct}%`,
              );
            }
          } else {
            roundFailures.push(
              `lane ${postLane.id} pass ${name} has unsupported expectation ${String(expectation)}`,
            );
          }
        } else {
          roundFailures.push(
            `lane ${postLane.id} pass ${name} has no comparable timing`,
          );
        }
        passes[name] = { ...delta, expectation, outcome };

        const key = `${postLane.id}/${name}`;
        const summary = verdict[key] ?? {
          expectation,
          deltaPctPerRound: [],
        };
        summary.deltaPctPerRound.push(delta.deltaPct);
        verdict[key] = summary;
      }
      lanes.push({
        id: postLane.id,
        genusId,
        sameReplay,
        bothValid,
        packedGenusRowsMatch,
        cirrusNonVacuous,
        cumulusIdentity,
        passes,
      });
    }

    const structuralFailuresBeforeDrift = roundFailures.length;
    const usable =
      roundFailures.length === 0 && !controlDrifted && lanes.length > 0;
    if (controlDrifted) {
      roundFailures.push(
        `an untouched control moved by more than ${controlBandPct}%; discard this round as drift`,
      );
    }
    if (usable) {
      productFailures.push(...roundProductFailures);
    }
    rounds.push({
      round: entry.round,
      order: entry.order,
      complete: true,
      usable,
      controlDrifted,
      discardableDrift: controlDrifted && structuralFailuresBeforeDrift === 0,
      failures: roundFailures,
      lanes,
    });
  }

  const usableRounds = rounds.filter((round) => round.usable);
  const orders = new Set(usableRounds.map((round) => round.order));
  const nonDiscardableRounds = rounds.filter(
    (round) => !round.usable && !round.discardableDrift,
  );
  const protocolComplete =
    stableBundles &&
    bothTagsPresent &&
    distinctBundles &&
    rounds.length >= 2 &&
    usableRounds.length >= 2 &&
    nonDiscardableRounds.length === 0 &&
    globalStructuralFailures.length === 0 &&
    orders.has("pre-first") &&
    orders.has("post-first");

  if (rounds.length < 2) {
    failures.push("at least two immutable rounds are required");
  }
  if (usableRounds.length < 2) {
    failures.push("at least two drift-clean usable rounds are required");
  }
  if (!orders.has("pre-first") || !orders.has("post-first")) {
    failures.push("usable rounds must include pre-first and post-first order");
  }
  failures.push(
    ...rounds.flatMap((round) =>
      round.failures.map((failure) => `round ${round.round}: ${failure}`),
    ),
  );
  failures.push(...productFailures);

  let status;
  let structural = false;
  if (!stableBundles || (bothTagsPresent && !distinctBundles)) {
    status = "incomparable-bundles";
    structural = true;
  } else if (!protocolComplete) {
    status = "incomplete-protocol";
    structural = true;
  } else if (productFailures.length > 0) {
    status = productFailures.some((failure) =>
      failure.includes("CUMULUS pixels changed"),
    )
      ? "cumulus-identity-failed"
      : "regressed";
  } else {
    status = "passed";
  }

  return {
    status,
    complete: protocolComplete,
    passed: status === "passed",
    structural,
    failures,
    rounds,
    bundleIdentity,
    verdict,
  };
}

export default {
  CLOUD_U2_MANIFEST_VERSION,
  CLOUD_U2_REGRESSION_BAND_PCT,
  CLOUD_U2_CONTROL_BAND_PCT,
  cloudU2ManifestFilename,
  cloudU2SummaryFilename,
  assessCloudU2PerfManifests,
};
