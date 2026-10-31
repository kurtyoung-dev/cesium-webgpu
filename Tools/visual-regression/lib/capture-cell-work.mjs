// capture-cell-work.mjs — the default work one cell does: open its page, wait for readiness, screenshot the element.
//
// @purpose Cell-work piece of capture.mjs: defaultCellWork, the default descriptor.cellWork, which navigates a cell's url on its origin, refuses a navigation that left the origin, waits for the cell's readiness through capture-readiness.mjs and element-captures the scene.
// @status ACTIVE
//
// WHY A PIECE. The default cell work moved out of `capture.mjs` when that
// module passed 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). It sits apart from
// `capture-descriptor.mjs` and `capture.mjs` because both import it (the
// descriptor as its default `cellWork`) and neither may import the other.

import { throwForDecision } from "./probe-refusal.mjs";
import { captureElement, decideOriginRefusal } from "./probe-runtime.mjs";
import {
  decideCellReadinessRefusal,
  describeReadiness,
  summariseCellReadiness,
  waitForCellReadiness,
} from "./capture-readiness.mjs";

/**
 * Bring one cell's page up and screenshot its element. The default
 * `descriptor.cellWork`; a spec replaces it wholesale.
 *
 * @param {object} cell One planned cell.
 * @param {object} context Run context.
 * @param {object} context.browser The live browser.
 * @param {Function} context.now Clock; also what the readiness wait measures with.
 * @param {object} [context.scope] The lifecycle slot scope. When present the
 *   browser context is registered as a tracked resource parented to the
 *   browser, so a watchdog close proves it closed instead of assuming the
 *   browser took it down.
 * @returns {Promise<object>} `{buffer, url, capturedAt, ...}`.
 */
export async function defaultCellWork(cell, { browser, now, scope }) {
  const work = async (context) => {
    const page = await context.newPage();
    await page.goto(cell.url, {
      waitUntil: "load",
      timeout: cell.navigationTimeoutMs,
    });
    throwForDecision(
      decideOriginRefusal({
        requestedOrigin: cell.origin,
        actualUrl: page.url(),
        label: cell.key,
      }),
      `cell ${cell.key} navigated off the origin it was pointed at`,
    );

    const readiness = await waitForCellReadiness(page, cell, now);
    throwForDecision(
      decideCellReadinessRefusal(readiness),
      `cell ${cell.key} was not ready to capture: ${describeReadiness(readiness)}`,
    );

    const captured = await captureElement({
      page,
      selector: cell.selector,
      name: cell.captureName,
      outputDirectory: cell.outputDirectory,
    });
    return {
      buffer: captured.buffer,
      byteLength: captured.byteLength,
      sha256: captured.sha256,
      matchCount: captured.matchCount,
      url: page.url(),
      capturedAt: new Date(now()).toISOString(),
      readiness: summariseCellReadiness(readiness),
    };
  };

  const newContext = () =>
    browser.newContext({ viewport: { ...cell.viewport } });
  if (scope === undefined || scope === null) {
    const context = await newContext();
    try {
      return await work(context);
    } finally {
      await context.close();
    }
  }

  // A browser context has no `isConnected()` of its own, so closure is
  // observed from the close resolving — and from the cascade, when the
  // browser resource closes first and marks its children closed.
  let closed = false;
  return scope.withResource(
    {
      kind: "context",
      label: `capture context ${cell.key}`,
      parent: browser,
      acquire: newContext,
      close: async (context) => {
        await context.close();
        closed = true;
      },
      isClosed: () => closed,
    },
    work,
  );
}
