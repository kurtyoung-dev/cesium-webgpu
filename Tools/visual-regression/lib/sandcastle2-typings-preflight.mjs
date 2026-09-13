/**
 * Sandcastle2 typings preflight — refuse to sweep a tree whose typings are missing.
 * @purpose Turn the absence of `packages/{engine,widgets}/index.d.ts` into one loud refusal instead of the intermittent, non-localised failures it otherwise wears.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. `gulp buildTs` produces `packages/engine/index.d.ts` and
 * `packages/widgets/index.d.ts`; the built Sandcastle2 app points Monaco at
 * both. A clone built without that step serves the app fine and then fails the
 * sweep three different ways across attempts — a hang, a `rendererGate` null
 * read ("never exposed the Cesium namespace"), or a pass carrying one 404 —
 * and none of them is reproducible in a direct page load. On 2026-09-12 that
 * disguise cost a bisect lane seven verdicts, every one of them retracted
 * (`Tools/visual-regression/output/wave-end/wave-p0-2-2026-09-11/BISECT_sample-height.md`
 * §1, §4).
 *
 * A missing build artifact must not present as a flaky engine. One assertion
 * against the SERVED origin — not the disk, because what the browser can fetch
 * is what decides the run — makes it present as "typings missing, run
 * `npx gulp buildTs`".
 */

/**
 * The typings the built Sandcastle2 app references, as paths on the served
 * origin. Both are `gulp buildTs` output.
 */
export const SANDCASTLE2_TYPINGS = Object.freeze([
  "/packages/engine/index.d.ts",
  "/packages/widgets/index.d.ts",
]);

/**
 * Status codes that mean "this server does not do HEAD", not "absent".
 */
const HEAD_UNSUPPORTED = new Set([400, 403, 405, 501]);

/**
 * Score a set of probe results.
 *
 * @param {Array<{path: string, status: number|null, error?: string}>} probes
 * @returns {{ok: boolean, missing: string[], reason: string}}
 */
export function scoreTypingsPreflight(probes) {
  const missing = probes
    .filter((probe) => probe.status !== 200)
    .map((probe) =>
      probe.error
        ? `${probe.path} (${probe.error})`
        : `${probe.path} (HTTP ${probe.status})`,
    );
  if (missing.length === 0) {
    return {
      ok: true,
      missing: [],
      reason: `typings resolve on the served origin (${probes.length} checked)`,
    };
  }
  return {
    ok: false,
    missing,
    reason:
      `Sandcastle2 typings do not resolve on the served origin: ${missing.join(", ")}. ` +
      "Run `npx gulp buildTs` in the served tree and restart the server. " +
      "Without them the sweep fails intermittently and non-locally (hang, " +
      "rendererGate null read, or a pass carrying a 404) rather than saying " +
      "the typings are missing.",
  };
}

/**
 * Probe one path, preferring HEAD and falling back to GET for servers that
 * refuse it.
 *
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{path: string, status: number|null, error?: string}>}
 */
async function probeOne(url, fetchImpl) {
  const path = new URL(url).pathname;
  try {
    const head = await fetchImpl(url, { method: "HEAD" });
    if (head.status === 200 || !HEAD_UNSUPPORTED.has(head.status)) {
      return { path, status: head.status };
    }
    const get = await fetchImpl(url, { method: "GET" });
    // Release the body so a large `.d.ts` is not buffered for a status check.
    await get.body?.cancel?.();
    return { path, status: get.status };
  } catch (error) {
    return { path, status: null, error: String(error?.message ?? error) };
  }
}

/**
 * Check the typings on a served origin.
 *
 * @param {object} options
 * @param {string} options.base Served origin, e.g. `http://localhost:8080`.
 * @param {typeof fetch} [options.fetchImpl] Injected for the spec.
 * @param {string[]} [options.paths]
 * @returns {Promise<{ok: boolean, missing: string[], reason: string}>}
 */
export async function checkSandcastle2Typings({
  base,
  fetchImpl = globalThis.fetch,
  paths = SANDCASTLE2_TYPINGS,
}) {
  const probes = [];
  for (const path of paths) {
    probes.push(await probeOne(new URL(path, base).toString(), fetchImpl));
  }
  return scoreTypingsPreflight(probes);
}

/**
 * Check and REFUSE. Throws with the actionable message; callers that must not
 * throw can use {@link checkSandcastle2Typings} directly.
 *
 * @param {object} options See {@link checkSandcastle2Typings}.
 * @returns {Promise<{ok: boolean, missing: string[], reason: string}>}
 */
export async function assertSandcastle2Typings(options) {
  const verdict = await checkSandcastle2Typings(options);
  if (!verdict.ok) {
    const error = new Error(`REFUSED: ${verdict.reason}`);
    error.code = "SANDCASTLE2_TYPINGS_MISSING";
    error.missing = verdict.missing;
    throw error;
  }
  return verdict;
}
