/**
 * C11-205 — pure evidence classification for the 3D Tiles lifecycle /
 * versioned-model-state work.
 *
 * Everything in this module is a pure function over plain data so the gate
 * logic that decides a probe's exit code can be mutation-tested in Node
 * without a browser. The probes and the performance campaign import these
 * decisions rather than re-deriving them, so a verdict printed by a probe and
 * a verdict recorded by the campaign cannot disagree by construction.
 *
 * Gate values follow the house convention used by probe-ground-fog /
 * probe-vector-draping:
 *
 *   true  — the gate was decided and it passed
 *   false — the gate was decided and it FAILED (a real product verdict)
 *   null  — the gate had no subject to measure (STRUCTURAL / instrument gap)
 *
 * Exit codes: 0 = every gate decided and passed. 1 = a real FAIL. 2 = watchdog
 * or an exception (owned by the probe's top-level catch). 3 = no FAIL, but at
 * least one gate had no subject — acceptance is INCOMPLETE, never green.
 */

/**
 * The repository already ships a real 3D Tiles 1.1 multiple-contents fixture,
 * and the dev server serves the repository root statically, so no synthetic
 * tileset is needed for the multiple-content lane. The root tile carries two
 * content slots of two different formats.
 */
export const C11_205_MULTIPLE_CONTENT_FIXTURE = Object.freeze({
  url: "/Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json",
  repositoryPath:
    "Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json",
  assetVersion: "1.1",
  contentSlots: 2,
  contentUris: Object.freeze(["batched.b3dm", "instanced.i3dm"]),
  minimumReadyModels: 2,
  minimumReadyTiles: 1,
});

/**
 * The broad tileset properties the versioned state packet owns. Mutating any
 * one of them must advance the packet exactly once and reach every content
 * model, including both slots of a multiple-content tile.
 */
export const C11_205_PACKET_MUTATIONS = Object.freeze([
  Object.freeze({ property: "colorBlendAmount", value: 0.25 }),
  Object.freeze({ property: "backFaceCulling", value: false }),
  Object.freeze({ property: "showCreditsOnScreen", value: true }),
]);

function gate(id, label, value, detail) {
  return { id, label, value, detail: detail ?? "" };
}

function isFiniteCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Classify one renderer leg of the multiple-content lifecycle probe.
 *
 * @param {object} leg the leg record produced by the probe
 * @returns {object[]} gates
 */
export function classifyLifecycleLegGates(leg) {
  const expectation = C11_205_MULTIPLE_CONTENT_FIXTURE;
  const result = leg?.result ?? null;
  const ledger = result?.ledger ?? null;
  const coverage = ledger?.coverage ?? null;
  const readiness = ledger?.readiness ?? null;

  // A leg that never reached the fixture has no subject at all: every gate
  // below would be scoring an empty page.
  const reachable =
    result === null || leg?.reachError
      ? null
      : result.tilesLoaded === true && isFiniteCount(result.frames)
        ? true
        : null;

  // Running the wrong backend does not fail the product; it means this leg was
  // never the leg under test.
  const rendererGate =
    reachable === null
      ? null
      : leg?.requestedRenderer && result.renderer
        ? result.renderer === leg.requestedRenderer
          ? true
          : null
        : null;

  const multipleContentGate =
    reachable === null || rendererGate === null
      ? null
      : coverage?.multipleContentSupported !== true
        ? null
        : coverage.multipleContentObserved === true;

  const ledgerGate =
    multipleContentGate === null
      ? null
      : ledger?.valid === true &&
        ledger?.complete === true &&
        ledger?.openRequestCount === 0;

  const readyModels = Array.isArray(readiness?.models) ? readiness.models : [];
  const readyTiles = Array.isArray(readiness?.tiles) ? readiness.tiles : [];
  const slotGate =
    multipleContentGate === null
      ? null
      : readiness === null
        ? null
        : readyModels.length >= expectation.minimumReadyModels &&
          readyTiles.length >= expectation.minimumReadyTiles &&
          readyModels.every(
            (model) => model.modelReady === true && model.contentReady === true,
          );

  const stabilityGate =
    reachable === null
      ? null
      : isFiniteCount(leg?.stableFramesRequired) &&
          isFiniteCount(result.stableFrames)
        ? result.stableFrames >= leg.stableFramesRequired
        : null;

  const cleanGate = Array.isArray(leg?.faults) ? leg.faults.length === 0 : null;

  return [
    gate(
      "L1",
      "REACHABLE  (the real multiple-content fixture loaded and settled)",
      reachable,
      `tilesLoaded=${result?.tilesLoaded ?? "n/a"} frames=${
        result?.frames ?? "n/a"
      }${leg?.reachError ? ` error=${leg.reachError}` : ""}`,
    ),
    gate(
      "L2",
      "BACKEND    (the resolved renderer is the requested one)",
      rendererGate,
      `requested=${leg?.requestedRenderer ?? "n/a"} resolved=${
        result?.renderer ?? "n/a"
      }`,
    ),
    gate(
      "L3",
      "MULTI      (schema v2 observed real multiple-content slots)",
      multipleContentGate,
      `supported=${coverage?.multipleContentSupported ?? "n/a"} observed=${
        coverage?.multipleContentObserved ?? "n/a"
      } predicted slots=${expectation.contentSlots}`,
    ),
    gate(
      "L4",
      "LEDGER     (valid, complete, zero open requests)",
      ledgerGate,
      `valid=${ledger?.valid ?? "n/a"} complete=${
        ledger?.complete ?? "n/a"
      } open=${ledger?.openRequestCount ?? "n/a"} requests=${
        ledger?.requestCount ?? "n/a"
      } signature=${ledger?.signature ?? "n/a"}`,
    ),
    gate(
      "L5",
      "SLOTS      (every observed content slot reached model+content ready)",
      slotGate,
      `models=${readyModels.length} (predicted >= ${
        expectation.minimumReadyModels
      }) tiles=${readyTiles.length} (predicted >= ${
        expectation.minimumReadyTiles
      })`,
    ),
    gate(
      "L6",
      "STABLE     (the ready signature held for the required frames)",
      stabilityGate,
      `stableFrames=${result?.stableFrames ?? "n/a"} required=${
        leg?.stableFramesRequired ?? "n/a"
      }`,
    ),
    gate(
      "L7",
      "CLEAN      (zero console / page errors)",
      cleanGate,
      `faults=${Array.isArray(leg?.faults) ? leg.faults.length : "n/a"}`,
    ),
  ];
}

/**
 * Classify the focused browser mutation evidence for the versioned model-state
 * packet on the same multiple-content tile.
 *
 * @param {object} leg the leg record produced by the probe
 * @returns {object[]} gates
 */
export function classifyStatePacketMutationGates(leg) {
  const mutation = leg?.result?.mutation ?? null;
  if (!mutation || mutation.supported !== true) {
    const detail = mutation
      ? `unsupported: ${mutation.reason ?? "no reason given"}`
      : "no mutation evidence";
    return [
      gate(
        "M1",
        "STEADY     (no packet churn while nothing mutates)",
        null,
        detail,
      ),
      gate(
        "M2",
        "ADVANCE    (one mutation advances the packet exactly once)",
        null,
        detail,
      ),
      gate(
        "M3",
        "PROPAGATE  (every content slot observes the mutated value)",
        null,
        detail,
      ),
      gate(
        "M4",
        "DYNAMIC    (per-tile state still applies with no packet bump)",
        null,
        detail,
      ),
    ];
  }

  const steady = mutation.steady;
  const steadyGate =
    isFiniteCount(steady?.frames) &&
    steady.frames > 0 &&
    isFiniteCount(steady?.versionChanges)
      ? steady.versionChanges === 0
      : null;

  const steps = Array.isArray(mutation.steps) ? mutation.steps : [];
  const advanceGate =
    steps.length === 0
      ? null
      : steps.length === C11_205_PACKET_MUTATIONS.length &&
        steps.every((step) => step.versionDelta === 1);
  const propagateGate =
    steps.length === 0
      ? null
      : steps.every(
          (step) =>
            isFiniteCount(step.observedModels) &&
            step.observedModels >=
              C11_205_MULTIPLE_CONTENT_FIXTURE.contentSlots &&
            step.mismatchedModels === 0,
        );

  const dynamic = mutation.dynamic;
  const dynamicGate =
    dynamic === null || dynamic === undefined
      ? null
      : dynamic.applied === true && dynamic.versionDelta === 0;

  return [
    gate(
      "M1",
      "STEADY     (no packet churn while nothing mutates)",
      steadyGate,
      `frames=${steady?.frames ?? "n/a"} versionChanges=${
        steady?.versionChanges ?? "n/a"
      } (predicted 0)`,
    ),
    gate(
      "M2",
      "ADVANCE    (one mutation advances the packet exactly once)",
      advanceGate,
      `steps=${steps.length}/${C11_205_PACKET_MUTATIONS.length} deltas=[${steps
        .map((step) => step.versionDelta)
        .join(",")}] (predicted all 1)`,
    ),
    gate(
      "M3",
      "PROPAGATE  (every content slot observes the mutated value)",
      propagateGate,
      steps
        .map(
          (step) =>
            `${step.property}:${step.observedModels ?? "n/a"}ok/${
              step.mismatchedModels ?? "n/a"
            }bad`,
        )
        .join(" ") || "n/a",
    ),
    gate(
      "M4",
      "DYNAMIC    (per-tile state still applies with no packet bump)",
      dynamicGate,
      `applied=${dynamic?.applied ?? "n/a"} versionDelta=${
        dynamic?.versionDelta ?? "n/a"
      } (predicted 0)`,
    ),
  ];
}

/**
 * Cross-leg gate: the whole point of the ledger is that both backends must
 * describe the same request history. Fewer than two legs is structural — there
 * is nothing to compare, and an unopposed leg must never read as agreement.
 *
 * @param {object[]} legs
 * @returns {object[]} gates
 */
export function classifyCrossLegGates(legs) {
  const list = Array.isArray(legs) ? legs : [];
  const signatures = list.map((leg) => leg?.result?.ledger?.signature ?? null);
  const comparable = list.length >= 2 && signatures.every(Boolean);
  const value = !comparable ? null : new Set(signatures).size === 1;
  return [
    gate(
      "X1",
      "CROSS-LEG  (both backends produced the same request-ledger signature)",
      value,
      `legs=${list.length} signatures=[${signatures
        .map((signature) => signature ?? "n/a")
        .join(", ")}]`,
    ),
  ];
}

/**
 * Combine gates into the house verdict + exit code.
 *
 * @param {object[]} gates
 * @returns {{failed: boolean, structural: boolean, verdict: string, exitCode: number}}
 */
export function combineC11205Gates(gates) {
  const list = Array.isArray(gates) ? gates : [];
  // An empty gate set is not a pass. Nothing was decided.
  if (list.length === 0) {
    return {
      failed: false,
      structural: true,
      verdict: "INCOMPLETE (structural)",
      exitCode: 3,
    };
  }
  const failed = list.some((entry) => entry?.value === false);
  const structural = list.some(
    (entry) => entry?.value !== true && entry?.value !== false,
  );
  return {
    failed,
    structural,
    verdict: failed ? "FAIL" : structural ? "INCOMPLETE (structural)" : "PASS",
    exitCode: failed ? 1 : structural ? 3 : 0,
  };
}

function describeRun(run) {
  return `${run?.renderer ?? "?"}:${run?.workloadId ?? "?"} repetition ${
    run?.repetition ?? "?"
  }`;
}

/**
 * Classify a performance-campaign report into the same PASS / FAIL /
 * STRUCTURAL contract.
 *
 * The separation that matters for C11-205: a run whose 3D Tiles content was
 * never fully resident did not measure the subject a resident comparison
 * stands in for. Its downstream pair exclusions — including "the legs held
 * different ready sets" — are consequences of that unmet precondition, not
 * renderer findings. Reporting them as FAIL would attribute an instrument gap
 * to the backend. Reporting a clean-run ready-set divergence as STRUCTURAL
 * would do the opposite and hide a real one, so that stays FAIL.
 *
 * @param {object} report
 * @returns {{verdict: string, exitCode: number, productCauses: string[], structuralCauses: string[]}}
 */
export function classifyPerformanceCampaignExit(report) {
  if (!report || typeof report !== "object") {
    return {
      verdict: "FAIL",
      exitCode: 1,
      productCauses: ["no campaign report was produced"],
      structuralCauses: [],
    };
  }
  if (report.result === "error") {
    return {
      verdict: "ERROR",
      exitCode: 2,
      productCauses: [],
      structuralCauses: [],
      errorCauses: Array.isArray(report.errors) ? report.errors : [],
    };
  }

  const runs = Array.isArray(report.runs) ? report.runs : [];
  const productCauses = [];
  const structuralCauses = [];
  for (const run of runs) {
    const bad = run?.result !== "pass" || run?.quality?.status === "invalid";
    if (!bad) continue;
    const detail = `${describeRun(run)}: ${
      (run?.failures ?? []).join("; ") || run?.result || "unspecified"
    }`;
    if (run?.structural === true) {
      structuralCauses.push(detail);
    } else {
      productCauses.push(detail);
    }
  }

  const downstreamCauses = [];
  for (const [workloadId, summary] of Object.entries(
    report.representativePairSummaries ?? {},
  )) {
    for (const reason of summary?.reasons ?? []) {
      downstreamCauses.push(`${workloadId}: ${reason}`);
    }
  }
  for (const [key, aggregate] of Object.entries(report.aggregates ?? {})) {
    if (aggregate && aggregate.stable === false) {
      downstreamCauses.push(`${key}: aggregate did not reach stability`);
    }
  }

  // Downstream pair/aggregate causes are only attributable to the product when
  // no leg failed structurally. If a leg never held its subject, everything
  // computed from it is unattributable.
  if (productCauses.length > 0 || structuralCauses.length === 0) {
    productCauses.push(...downstreamCauses);
  } else {
    structuralCauses.push(
      ...downstreamCauses.map(
        (cause) => `${cause} (downstream of an unmet measurement precondition)`,
      ),
    );
  }

  if (report.result === "pass") {
    // A "pass" report with recorded causes is a contradiction; never round it
    // up to green.
    if (productCauses.length > 0) {
      return {
        verdict: "FAIL",
        exitCode: 1,
        productCauses,
        structuralCauses,
      };
    }
    if (structuralCauses.length > 0) {
      return {
        verdict: "INCOMPLETE (structural)",
        exitCode: 3,
        productCauses,
        structuralCauses,
      };
    }
    return { verdict: "PASS", exitCode: 0, productCauses, structuralCauses };
  }

  if (productCauses.length > 0) {
    return { verdict: "FAIL", exitCode: 1, productCauses, structuralCauses };
  }
  if (structuralCauses.length > 0) {
    return {
      verdict: "INCOMPLETE (structural)",
      exitCode: 3,
      productCauses,
      structuralCauses,
    };
  }
  // Not a pass, but nothing named it. That is a FAIL, not a green run.
  return {
    verdict: "FAIL",
    exitCode: 1,
    productCauses: [
      `campaign result "${report.result}" with no recorded cause`,
    ],
    structuralCauses,
  };
}

/**
 * Render a gate list in the house format.
 *
 * @param {object[]} gates
 * @returns {string[]}
 */
export function formatC11205Gates(gates) {
  return (Array.isArray(gates) ? gates : []).map((entry) => {
    const verdict =
      entry?.value === null || entry?.value === undefined
        ? "STRUCTURAL"
        : entry.value
          ? "PASS"
          : "FAIL";
    return `${entry?.id ?? "??"} ${entry?.label ?? ""}: ${verdict} ${
      entry?.detail ?? ""
    }`.trimEnd();
  });
}
