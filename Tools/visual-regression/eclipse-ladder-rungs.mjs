// eclipse-ladder-rungs.mjs — the obscuration ladder that
// `probe-eclipse-scene-dimming.mjs` measures S2 dimming across, plus the
// validation of its rung separation.
// @purpose Obscuration ladder + rung-separation validation for the S2 dimming probe; extracted from page.evaluate to fix the 0.9+0.1 knife-edge reject.
// @status ACTIVE
//
// WHY THIS IS ITS OWN MODULE. The separation check used to live INSIDE the
// probe's `page.evaluate` derivation callback, where it could never be tested:
// module-scope bindings do not cross the serialization boundary, so nothing in
// Node could import it, and the only way to exercise it was a full Playwright
// run. It is also pure data validation — it needs the returned ladder and
// nothing else, no Cesium, no page. Moving it into the Node driver makes it
// both testable and better located: the abort now happens where a useful
// message can be printed.
//
// THE DEFECT THIS FILE EXISTS TO PREVENT (2026-07-24, executor-verified —
// blocked the Edge cycle before any measurement was taken). The predicate was
//
//     picks[k].obscuration > picks[k - 1].obscuration + 0.1     // STRICT
//
// with targets `[0.0, 0.35, 0.65, 0.9, min(best.o, 1.0)]`. The 2026-08-12
// eclipse is TOTAL, so the last target clamps to exactly 1.0 and the top gap
// is exactly 0.1 — and `0.9 + 0.1` rounds to exactly `1.0` in IEEE double, so
// `1.0 > 1.0` is false and a perfectly good ladder
// (0.000 / 0.350 / 0.651 / 0.900 / 1.000) was rejected as "collapsed". Every
// total or near-total eclipse tripped it by construction, which is to say the
// probe could only ever run against the eclipses it was least interesting on.
//
// THE FIX IS THREE CHANGES, NOT ONE, because either single change the
// diagnosis offered leaves a reachable knife edge:
//
//   * An epsilon-tolerant comparison ALONE is not enough. The rungs are the
//     instants CLOSEST to each target, not the targets themselves; on 10-second
//     stepping through the steep part of the curve the 0.9 rung can land at
//     0.9007, making the top gap 0.0993. That is short by ~7e-4 — three orders
//     of magnitude beyond any epsilon that deserves the name.
//   * Dropping the 4th target ALONE just RELOCATES the exact-equality knife
//     edge: at 0.85 the identical failure returns for any eclipse whose
//     maximum obscuration is exactly 0.95.
//
// So: the 4th target drops to 0.85 (a 0.15 designed gap against a total
// eclipse), the enforced minimum separation drops to 0.05 (3x headroom over
// the observed pick jitter, while still catching a genuinely collapsed ladder
// — a shallow partial peaking near 0.87 would give a 0.02 gap and still be
// rejected), and the comparison is `>=` with an epsilon so that exact equality
// is never the thing deciding the run.

/**
 * Target obscurations for the fixed rungs, in ascending order. The derivation
 * appends a fifth rung — the maximum obscuration actually reachable at the
 * chosen vantage, clamped to 1.0 — so the ladder always ends as deep as the
 * eclipse goes.
 *
 * @type {number[]}
 */
export const LADDER_TARGETS = [0.0, 0.35, 0.65, 0.85];

/**
 * Minimum obscuration separation between consecutive rungs. Below this the
 * "monotone dimming tracks the fraction" lane is measuring noise rather than
 * the curve.
 *
 * @type {number}
 */
export const MIN_RUNG_SEPARATION = 0.05;

/**
 * Tolerance on the separation comparison. Present so that an exact tie can
 * never be the discriminator — see the header. It is NOT the mechanism that
 * absorbs pick jitter; the target spacing is.
 *
 * @type {number}
 */
export const RUNG_SEPARATION_EPSILON = 1e-9;

/**
 * Validate that a derived ladder's rungs are distinct enough to measure
 * across.
 *
 * @param {Array<{iso?: string, obscuration: number}>|undefined} ladder
 * @returns {{ok: boolean, reason?: string, failedPair?: object, predicate?: string}}
 *   `ok` plus, on failure, a message naming the ACTUAL failing pair and the
 *   predicate that rejected it. The old message printed the whole ladder with
 *   no indication of which pair failed or what the bar was, which is why the
 *   real defect read as a data problem.
 */
export function validateLadderSeparation(ladder) {
  if (!Array.isArray(ladder) || ladder.length < 2) {
    return {
      ok: false,
      reason: `ladder must have at least 2 rungs, got ${
        Array.isArray(ladder) ? ladder.length : typeof ladder
      }`,
    };
  }
  for (let k = 0; k < ladder.length; k++) {
    if (!Number.isFinite(ladder[k]?.obscuration)) {
      return {
        ok: false,
        reason: `rung ${k} has a non-finite obscuration (${ladder[k]?.obscuration})`,
      };
    }
  }
  const bar = MIN_RUNG_SEPARATION - RUNG_SEPARATION_EPSILON;
  for (let k = 1; k < ladder.length; k++) {
    const prev = ladder[k - 1].obscuration;
    const cur = ladder[k].obscuration;
    if (!(cur >= prev + bar)) {
      return {
        ok: false,
        reason:
          `ladder rungs collapsed between rung ${k - 1} and rung ${k}: ` +
          `${prev.toFixed(6)} -> ${cur.toFixed(6)} is a gap of ` +
          `${(cur - prev).toFixed(6)}, below the required ` +
          `${MIN_RUNG_SEPARATION} (full ladder: ` +
          `${ladder.map((r) => r.obscuration.toFixed(3)).join(", ")})`,
        failedPair: {
          index: k,
          previousObscuration: prev,
          obscuration: cur,
          gap: cur - prev,
          previousIso: ladder[k - 1].iso,
          iso: ladder[k].iso,
        },
        predicate: `obscuration[k] >= obscuration[k-1] + ${MIN_RUNG_SEPARATION} - ${RUNG_SEPARATION_EPSILON}`,
      };
    }
  }
  return { ok: true };
}
