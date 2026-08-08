/**
 * Readiness policy for the CesiumViewer page's loading indicator.
 *
 * The page shows one loading element, and the question this module answers is
 * when to take it away. Hiding it as soon as the viewer has been constructed
 * is only correct for a backend whose first frame follows the constructor
 * immediately; a backend that builds pipelines on its first frame would expose
 * a stretch of empty page between the indicator disappearing and anything
 * being drawn. Waiting for the frame instead makes the observable sequence —
 * indicator, then scene, with nothing in between — the same for every backend,
 * and costs at most one frame where the constructor was already enough.
 *
 * The wait is bounded. A viewer built with `useDefaultRenderLoop: false`, a
 * backgrounded tab, or a scene that fails before its first frame would
 * otherwise leave the indicator over the page for as long as it stays open,
 * so the limit expires the wait and hides it anyway.
 *
 * Nothing here touches the DOM: the caller supplies the scenes to watch and
 * the action to run, so the policy can be exercised without a browser.
 *
 * @module CesiumViewerLoadingIndicator
 */

/**
 * How long a wait may run before it gives up and reports ready anyway.
 *
 * Long enough to cover a cold graphics-context acquisition plus first-frame
 * pipeline construction on a slow machine, short enough that a viewer which
 * will never render does not hold the indicator for a noticeable time.
 *
 * @type {number}
 */
export const RENDER_WAIT_LIMIT_MS = 10000;

/**
 * Whether a value can report its rendered frames.
 *
 * A start can leave a viewer unbuilt, and a caller collecting scenes from
 * whichever viewers survived should not have to filter twice.
 *
 * @param {object} [scene] Candidate scene.
 * @returns {boolean} True when the scene raises an event this module can watch.
 */
function isObservableScene(scene) {
  const postRender = scene?.postRender;
  return (
    typeof postRender?.addEventListener === "function" &&
    typeof postRender?.removeEventListener === "function"
  );
}

/**
 * Run an action once every supplied scene has rendered at least one frame.
 *
 * The action also runs when the limit expires, so a scene that never renders
 * cannot strand the caller. It runs at most once in either case.
 *
 * @param {object[]} scenes Scenes to wait on. Entries that cannot report a
 *   rendered frame are ignored, and an empty result reports ready at once.
 * @param {Function} onReady Called once, with no arguments, when ready.
 * @param {object} [options] Overrides for testing.
 * @param {number} [options.limitMs] Wait limit, defaulting to
 *   {@link RENDER_WAIT_LIMIT_MS}.
 * @param {Function} [options.setTimeout] Timer scheduler.
 * @param {Function} [options.clearTimeout] Timer canceller.
 * @returns {Function} Abandons the wait without running the action. Calling it
 *   after the action has run does nothing.
 */
export function whenScenesRendered(scenes, onReady, options) {
  options = options ?? {};
  const limitMs = options.limitMs ?? RENDER_WAIT_LIMIT_MS;
  const schedule = options.setTimeout ?? setTimeout;
  const unschedule = options.clearTimeout ?? clearTimeout;

  const watched = (scenes ?? []).filter(isObservableScene);
  const removers = [];
  let remaining = watched.length;
  let settled = false;
  let timer;

  function release() {
    while (removers.length > 0) {
      removers.pop()();
    }
    if (timer !== undefined) {
      unschedule(timer);
      timer = undefined;
    }
  }

  function settle() {
    if (settled) {
      return;
    }
    settled = true;
    release();
    onReady();
  }

  function watchFirstFrame(scene) {
    let counted = false;
    const listener = function () {
      // A scene raises this event on every frame, and only the first one
      // answers the question being asked here.
      if (counted) {
        return;
      }
      counted = true;
      scene.postRender.removeEventListener(listener);
      remaining -= 1;
      if (remaining === 0) {
        settle();
      }
    };
    scene.postRender.addEventListener(listener);
    removers.push(function () {
      scene.postRender.removeEventListener(listener);
    });
  }

  watched.forEach(watchFirstFrame);

  if (remaining === 0) {
    settle();
  } else {
    timer = schedule(settle, limitMs);
  }

  return function cancel() {
    if (settled) {
      return;
    }
    settled = true;
    release();
  };
}
