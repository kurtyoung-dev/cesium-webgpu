// owned-resource-transaction.mjs — browser-safe ownership transfer helper.
// @purpose Dependency-free browser-safe helper that swaps an explicitly-owned resource transactionally (rollback on install failure, exactly-once destroy).
// @status ACTIVE
//
// This module is intentionally dependency-free. It is imported from inside a
// Playwright page evaluation, so importing a Node built-in here (directly or
// transitively) would make the browser-side transaction fail before it starts.

/**
 * Replace one explicitly-owned resource without losing either ownership edge.
 * The candidate is destroyed after a successful rollback when installation
 * fails; if rollback itself fails, ambiguous ownership is left alive. After a
 * successful installation, the previous resource is destroyed exactly once
 * and ownership of the candidate belongs to the installer. A failure while
 * destroying the previous resource is propagated without also destroying the
 * now-installed candidate.
 *
 * @param {{current:object|undefined,create:Function,install:Function,
 *          restore:Function,destroy:Function}} input
 * @returns {{resource:object,installed:boolean,previousDestroyed:boolean,
 *            candidateDestroyed:boolean}}
 */
export function replaceOwnedResourceTransaction(input) {
  const { current, create, install, restore, destroy } = input ?? {};
  if (
    typeof create !== "function" ||
    typeof install !== "function" ||
    typeof restore !== "function" ||
    typeof destroy !== "function"
  ) {
    throw new TypeError(
      "create, install, restore, and destroy callbacks are required",
    );
  }

  const candidate = create();
  if (!candidate) {
    throw new Error("resource factory returned no candidate");
  }

  try {
    install(candidate);
  } catch (installError) {
    const cleanupErrors = [installError];
    let restored = false;
    try {
      restore(current);
      restored = true;
    } catch (restoreError) {
      cleanupErrors.push(restoreError);
    }
    // Never destroy a candidate that may still be installed. A failed restore
    // leaves ownership ambiguous; leaking on a fatal path is safer than leaving
    // the scene pointing at a destroyed object.
    if (restored && candidate !== current) {
      try {
        destroy(candidate);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "resource installation rollback did not complete cleanly",
        { cause: installError },
      );
    }
    throw installError;
  }

  let previousDestroyed = false;
  if (current && current !== candidate) {
    // Exactly one call. If it throws, the installed candidate remains owned by
    // the installer and must not be destroyed as though installation failed.
    destroy(current);
    previousDestroyed = true;
  }
  return {
    resource: candidate,
    installed: true,
    previousDestroyed,
    candidateDestroyed: false,
  };
}

export default replaceOwnedResourceTransaction;
