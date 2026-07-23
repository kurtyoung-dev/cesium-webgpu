/**
 * Resolve the process-level outcome for the fixed-scene cloud perf probe.
 *
 * A valid unpaired artifact is useful characterization. Supplying a pair ID is
 * an explicit request for A/B evidence, so missing or non-comparable companion
 * data must not silently degrade to a successful single-artifact run.
 */
export function resolveCloudPerfPass({
  currentArtifactValid,
  pairId,
  comparisonStatus,
  comparisonPassed,
}) {
  if (!currentArtifactValid) {
    return false;
  }
  if (comparisonStatus === "compared") {
    return comparisonPassed === true;
  }
  return pairId === null;
}
