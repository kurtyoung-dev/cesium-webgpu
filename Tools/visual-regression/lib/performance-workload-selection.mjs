// @purpose Selects runnable workloads per requested renderers; strict mode fails rather than silently dropping an explicitly requested renderer.
// @status ACTIVE

export function renderersForWorkload(workload, selectedRenderers) {
  if (!Array.isArray(workload.renderers)) {
    return [...selectedRenderers];
  }
  return selectedRenderers.filter((renderer) =>
    workload.renderers.includes(renderer),
  );
}

/**
 * Select the workloads that can run on at least one requested renderer.
 *
 * An implicit "all workloads" campaign skips and records backend-specific
 * workloads or individual renderer lanes that cannot run. An explicit
 * workload request is strict: silently dropping any requested renderer would
 * turn a user request into a false pass.
 */
export function selectWorkloadsForRenderers(
  workloads,
  selectedRenderers,
  { strict = false } = {},
) {
  const selected = [];
  const skipped = [];
  const skippedRenderers = [];

  for (const workload of workloads) {
    const compatibleRenderers = renderersForWorkload(
      workload,
      selectedRenderers,
    );
    if (compatibleRenderers.length > 0) {
      selected.push(workload);
      const unsupportedRenderers = selectedRenderers.filter(
        (renderer) => !compatibleRenderers.includes(renderer),
      );
      if (unsupportedRenderers.length > 0) {
        skippedRenderers.push({
          id: workload.id,
          reason: "unsupported-renderer",
          skippedRenderers: unsupportedRenderers,
          compatibleRenderers,
          supportedRenderers: [...workload.renderers],
        });
      }
      continue;
    }
    skipped.push({
      id: workload.id,
      reason: "unsupported-renderer",
      selectedRenderers: [...selectedRenderers],
      supportedRenderers: Array.isArray(workload.renderers)
        ? [...workload.renderers]
        : null,
    });
  }

  if (strict && (skipped.length > 0 || skippedRenderers.length > 0)) {
    const details = [...skipped, ...skippedRenderers]
      .map(
        (entry) =>
          `${entry.id} supports ${(entry.supportedRenderers || ["all"]).join(
            ", ",
          )}`,
      )
      .join("; ");
    throw new Error(
      `Explicit workload request does not support selected renderer(s) ${selectedRenderers.join(
        ", ",
      )}: ${details}`,
    );
  }

  return { selected, skipped, skippedRenderers };
}
