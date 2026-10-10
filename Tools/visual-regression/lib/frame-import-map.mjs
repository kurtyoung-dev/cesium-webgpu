// frame-import-map.mjs - wait until a page or frame can resolve a bare module
// specifier through its import map, before anything evaluated there imports
// one.
//
// @purpose The readiness wait for a dynamic import of a bare specifier in a page or frame: whether a specifier is bare, an in-page predicate that reports whether the document has parsed an import map, and the Node-side wait that blocks until it has, or refuses by name when it does not appear in time.
// @status ACTIVE
//
// WHY. A probe that runs `await import("cesium")` in the Sandcastle2 run frame
// relies on the frame's import map to resolve `cesium`. The opener hands the
// probe the frame as soon as a frame with the bucket URL exists, which can be
// before its document has parsed the `<script type="importmap">` in its head.
// An import evaluated then fails with "Failed to resolve module specifier",
// which a paused video cell's run on Edge recorded. Waiting for the import
// map element to be in the document closes the race: the parser registers an
// inline import map when it inserts the element.
//
// A specifier that is a URL or a path (`http://...`, `/...`, `./...`,
// `../...`) needs no import map, so the wait returns at once for it.

import { ProbeRefusal } from "./probe-refusal.mjs";

/**
 * Whether a module specifier is bare: not a URL with a scheme and not a path,
 * so only an import map can resolve it.
 *
 * @param {unknown} specifier The specifier.
 * @returns {boolean} True for a bare specifier such as `cesium`.
 */
export function isBareModuleSpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
    return false;
  }
  return !(
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * Whether the document has parsed an import map. Runs in the page or frame;
 * self-contained.
 *
 * @returns {boolean} True once a `<script type="importmap">` is in the
 *   document.
 */
export function pageHasImportMap() {
  return document.querySelector('script[type="importmap"]') !== null;
}

/**
 * Wait until a page or frame has parsed an import map, when `specifier` is
 * bare; return at once otherwise.
 *
 * @param {{waitForFunction: Function}} frame A Playwright page or frame.
 * @param {{specifier: string, timeoutMs: number, pollMs?: number}} options
 *   The specifier the caller will import there, how long to wait, and the
 *   polling interval.
 * @returns {Promise<{waited: boolean, elapsedMs: number}>} Whether a wait was
 *   needed, and how long it took.
 * @throws {ProbeRefusal} `frame-import-map-missing` when the import map does
 *   not appear within `timeoutMs`.
 */
export async function awaitFrameImportMap(
  frame,
  { specifier, timeoutMs, pollMs = 50 },
) {
  if (!isBareModuleSpecifier(specifier)) {
    return { waited: false, elapsedMs: 0 };
  }
  const started = Date.now();
  try {
    await frame.waitForFunction(pageHasImportMap, undefined, {
      timeout: Math.max(1, timeoutMs),
      polling: pollMs,
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new ProbeRefusal(
        "frame-import-map-missing",
        `no import map appeared in the frame within ${timeoutMs} ms, so the bare specifier "${specifier}" cannot be imported there`,
        { specifier, timeoutMs },
      );
    }
    throw error;
  }
  return { waited: true, elapsedMs: Date.now() - started };
}
