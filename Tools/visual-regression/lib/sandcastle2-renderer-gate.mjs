// sandcastle2-renderer-gate.mjs — pure helpers for the Sandcastle2 renderer
// sweep. No browser, no network, no filesystem beyond the gallery listing.
//
// @purpose Pure helpers for the Sandcastle2 backend sweep: gallery id enumeration, URL construction, and the "the demo really ran the requested renderer" predicate.
// @status ACTIVE
//
// THE GAP THIS CLOSES. A Sandcastle demo can render a perfectly good picture on
// the wrong backend. The runner rewrites demo code so the selected renderer is
// the one that gets constructed; when a construction shape is missed by that
// rewrite, the demo silently falls back to WebGL while the UI reads "WebGPU".
// Every existing gate — no console errors, a non-black canvas, distinct colors —
// passes happily in that state, because a WebGL render of the same scene looks
// right. The only assertion that catches it is asking the live context which
// backend it is, which is what `evaluateRendererGate` below scores.
//
// WHY THE HELPERS ARE SEPARATE FROM THE PROBE. The probe needs a browser; these
// do not. Keeping id enumeration, URL construction and the scoring predicate
// out here means they can be unit-tested in plain Node, so a change to the gate
// is not gated on having a GPU.

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Renderer selections the sweep can request for a single pane. */
export const SWEEPABLE_RENDERERS = ["webgl", "webgpu"];

/**
 * Strip `//` and `/* *\/` comments from a JS source string while leaving
 * string and template-literal CONTENTS untouched (so a URL like
 * `"http://…"` or a template literal containing `//` is not mistaken for a
 * comment). Matches a comment or a string/template literal and blanks only
 * the former; used before scanning demo bodies for real construction calls
 * so a call mentioned in an explanatory comment does not count as one that
 * actually runs (Q-129 — see {@link deriveNoViewerIds}).
 *
 * Not a full tokenizer (a `/` inside a regex literal, or a comment marker
 * inside a nested `${...}` template expression, can still confuse it), but
 * the gallery's demo bodies are simple enough that this is sufficient in
 * practice — every gallery file's derived viewer-less classification below
 * is checked against a real filesystem read of the current gallery.
 *
 * @param {string} source Raw JS source text.
 * @returns {string} The same text with comments blanked out.
 */
export function stripJsSourceComments(source) {
  return source.replace(
    /\/\/.*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => (match[0] === "/" ? "" : match),
  );
}

/** The construction regex {@link deriveNoViewerIds} tests against comment-stripped source. */
const VIEWER_CONSTRUCTION_PATTERN =
  /new\s+(Cesium\.)?(Viewer|CesiumWidget)\s*\(|(Viewer|CesiumWidget)\.createAsync/;

/**
 * Derive, from the gallery itself, which demo ids build no viewer and so no
 * graphics context. A demo counts as viewer-less only when NO real (i.e.
 * comment-stripped) Viewer/CesiumWidget construction — qualified or bare,
 * synchronous or `createAsync` — appears in its `main.js`.
 *
 * Comment-stripping matters: `packages/sandcastle/gallery/viewerless/main.js`
 * documents `new Cesium.Viewer("cesiumContainer")` in a COMMENTED-OUT line
 * (`//const viewer = new Cesium.Viewer("cesiumContainer");`) to show what a
 * reader would add. A derivation that scans raw source text (as this
 * function's predecessor did — the inline regex this replaces, formerly
 * duplicated in sandcastle2-renderer-gate.spec.mjs's "C2a" test) matches that
 * commented-out text and wrongly concludes `viewerless` constructs a viewer,
 * which is exactly why it was missing from {@link NO_VIEWER_IDS} (Q-129).
 *
 * @param {string} galleryDir Absolute path to `packages/sandcastle/gallery`.
 * @param {{includeDevelopment?: boolean}} [options] Forwarded to {@link enumerateGalleryIds}.
 * @returns {string[]} Sorted ids that build no viewer.
 */
export function deriveNoViewerIds(galleryDir, options = {}) {
  const ids = enumerateGalleryIds(galleryDir, options);
  return ids
    .filter((id) => {
      const source = readFileSync(join(galleryDir, id, "main.js"), "utf8");
      return !VIEWER_CONSTRUCTION_PATTERN.test(stripJsSourceComments(source));
    })
    .sort();
}

/**
 * Gallery ids that legitimately build no viewer, and so no graphics context.
 *
 * Re-derived from the gallery bodies via {@link deriveNoViewerIds}
 * (comment-aware — see that function's docs for why comment-blindness
 * matters) rather than hand-maintained:
 *
 *   - `timeline` constructs `Timeline` and `Animation` widgets straight from
 *     the engine and never builds a `Viewer` or a `CesiumWidget`, so no
 *     backend is ever selected for it.
 *   - `viewerless` is a deliberately bare Sandcastle template: its only
 *     mention of `new Cesium.Viewer(...)` is a commented-out line showing
 *     what a reader would uncomment, so no viewer is ever actually built.
 *
 * These ids are NOT skipped. Both scorers INVERT for them: the demo must report
 * zero contexts and zero rendered frames, and must still load without errors. A
 * viewer appearing here is as much a finding as a viewer missing elsewhere — it
 * means this list has gone stale — which is why the entry is an assertion rather
 * than an exemption. `sandcastle2-renderer-gate.spec.mjs`'s "C2a" test asserts
 * this literal array equals a fresh call to {@link deriveNoViewerIds} against
 * the real gallery, so the two cannot drift apart silently.
 */
export const NO_VIEWER_IDS = ["timeline", "viewerless"];

/**
 * Whether a gallery id is expected to build no viewer.
 *
 * @param {string} id Gallery id.
 * @returns {boolean} True when both scorers should invert for it.
 */
export function isNoViewerId(id) {
  return NO_VIEWER_IDS.includes(id);
}

/**
 * List the gallery ids the app can load, in stable order.
 *
 * The id is the demo directory's own name — that is what `buildGallery.js`
 * publishes as the entry id and what `?id=` resolves against. A directory only
 * counts as a demo when it carries the two files the gallery build requires.
 *
 * @param {string} galleryDir Absolute path to `packages/sandcastle/gallery`.
 * @param {{includeDevelopment?: boolean}} [options] `includeDevelopment` keeps
 *   demos whose metadata marks them development-only. It defaults to TRUE,
 *   because a certification sweep wants the whole tree — the gallery build is
 *   what decides which ones a visitor sees, and the development demos are
 *   exactly where new renderer work lands.
 * @returns {string[]} Sorted ids.
 */
export function enumerateGalleryIds(galleryDir, options = {}) {
  const includeDevelopment = options.includeDevelopment ?? true;
  const entries = readdirSync(galleryDir, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(galleryDir, entry.name);
    if (!existsSync(join(dir, "main.js"))) {
      continue;
    }
    if (!includeDevelopment && isDevelopmentDemo(dir)) {
      continue;
    }
    ids.push(entry.name);
  }
  return ids.sort();
}

/**
 * Whether a demo directory's metadata marks it development-only.
 *
 * Deliberately a line scan rather than a YAML parse: the only key that matters
 * is a top-level boolean, and an id enumerator has no business acquiring a
 * parser dependency. A missing or unreadable file reads as "not development",
 * which keeps the demo in the sweep rather than silently dropping it.
 *
 * @param {string} demoDir Absolute path to one gallery directory.
 * @returns {boolean} True when the metadata says development.
 */
export function isDevelopmentDemo(demoDir) {
  const metadataPath = join(demoDir, "sandcastle.yaml");
  if (!existsSync(metadataPath)) {
    return false;
  }
  try {
    return /^development:\s*true\s*$/m.test(readFileSync(metadataPath, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Build the URL that opens one demo with a renderer pinned.
 *
 * @param {object} options Options.
 * @param {string} options.base Origin the Sandcastle build is served from.
 * @param {string} options.id Gallery id.
 * @param {string} options.renderer Renderer to request.
 * @param {boolean} [options.standalone] Target the share page instead of the editor.
 * @param {string} [options.appPath] Directory the built app lives under.
 * @returns {string} An absolute URL.
 */
export function buildSandcastle2Url({
  base,
  id,
  renderer,
  standalone = false,
  appPath = "/Apps/Sandcastle2",
}) {
  const page = standalone ? "standalone.html" : "index.html";
  const url = new URL(`${appPath}/${page}`, base);
  url.searchParams.set("id", id);
  url.searchParams.set("renderer", renderer);
  return url.toString();
}

/**
 * Score the backend a demo actually ran on.
 *
 * Fails closed in three distinguishable ways, because "we could not tell" and
 * "it ran the wrong backend" are different bugs and a sweep over 338 demos is
 * unreadable if they collapse into one message.
 *
 * @param {object} options Options.
 * @param {Array<{id?: string, rendererType?: string}>|null|undefined} options.contexts
 *   Live graphics contexts read out of the demo frame.
 * @param {string} options.requested The renderer that was asked for.
 * @param {boolean} [options.expectNoViewer] Invert the verdict: the demo is one
 *   of {@link NO_VIEWER_IDS} and must report NO context at all.
 * @returns {{ok: boolean, reason: string, observed: string[]}} Verdict.
 */
export function evaluateRendererGate({
  contexts,
  requested,
  expectNoViewer = false,
}) {
  if (!SWEEPABLE_RENDERERS.includes(requested)) {
    return {
      ok: false,
      reason: `unsweepable renderer "${requested}" (expected one of: ${SWEEPABLE_RENDERERS.join(", ")})`,
      observed: [],
    };
  }
  if (contexts === null || contexts === undefined) {
    return {
      ok: false,
      reason:
        "could not read the context registry — the demo frame never exposed the Cesium namespace",
      observed: [],
    };
  }
  const observed = contexts.map((c) => String(c?.rendererType ?? "unknown"));

  if (expectNoViewer) {
    // Inverted, not skipped. The demo has to prove it built nothing, and the
    // registry read above already proved the page booted far enough to answer.
    if (observed.length > 0) {
      return {
        ok: false,
        reason: `expected no graphics context but found ${observed.length} (${[
          ...new Set(observed),
        ].join(", ")}) — the no-viewer list is stale`,
        observed,
      };
    }
    return {
      ok: true,
      reason: "no graphics context, as expected for a viewer-less demo",
      observed,
    };
  }

  if (observed.length === 0) {
    return {
      ok: false,
      reason: "no graphics context was created — the demo built no viewer",
      observed,
    };
  }
  const wrong = observed.filter((type) => type !== requested);
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: `requested ${requested} but ran ${[...new Set(wrong)].join(", ")} (${wrong.length} of ${observed.length} contexts)`,
      observed,
    };
  }
  return {
    ok: true,
    reason: `${observed.length} context(s) on ${requested}`,
    observed,
  };
}

/**
 * The in-page reader the probe evaluates inside the demo frame.
 *
 * Exported as a function so the sweep and any future probe agree on exactly
 * what is read. It runs in the browser, so it must stay dependency-free and
 * must never throw — a frame that has not booted yet has to report that rather
 * than fail the evaluate call.
 *
 * @returns {{contexts: Array<{id: string, rendererType: string}>|null, frameNumbers: number[], note: string}}
 *   What the frame could see.
 */
export function readRendererStateInPage() {
  const namespace = globalThis.Cesium;
  if (!namespace || !namespace.GraphicsContext) {
    return {
      contexts: null,
      frameNumbers: [],
      note: "no Cesium namespace on the frame",
    };
  }
  const registry = namespace.GraphicsContext.registry;
  if (!registry || !registry.all) {
    return {
      contexts: null,
      frameNumbers: [],
      note: "no context registry on GraphicsContext",
    };
  }
  const contexts = [];
  for (const context of registry.all.values()) {
    contexts.push({
      id: String(context.id),
      rendererType: String(context.rendererType),
    });
  }
  const frameNumbers = [];
  for (const instance of globalThis.__sandcastleInstances ?? []) {
    const frameNumber = instance?.scene?.frameState?.frameNumber;
    if (typeof frameNumber === "number") {
      frameNumbers.push(frameNumber);
    }
  }
  return { contexts, frameNumbers, note: "" };
}

/**
 * Returned when a frame read never came back, so the caller can report TIMEOUT
 * rather than folding a wedged demo in with a wrong-backend failure.
 */
export const EVALUATE_TIMEOUT = Symbol.for("sandcastle2-evaluate-timeout");

/**
 * Evaluate inside a demo frame under a deadline.
 *
 * `frame.evaluate` honours no timeout of its own, so a demo that wedges the
 * frame's event loop — an infinite loop in demo code, a promise that never
 * settles — would hang an unattended full-gallery run forever at that row.
 * Everything else the sweep does is already bounded by Playwright's own default
 * timeout.
 *
 * A real evaluation failure is rethrown rather than reported as a timeout: a
 * detached frame and a wedged one are different findings. The rejection is
 * converted at attach time, so losing the race never leaves it unhandled.
 *
 * Takes anything with an `evaluate` method, which is what lets this be tested
 * against a frame that never answers.
 *
 * @param {{evaluate: Function}} frame Bucket frame, or any duck-typed stand-in.
 * @param {Function} fn Function to run inside the frame.
 * @param {number} timeoutMs Deadline in milliseconds.
 * @returns {Promise<unknown>} The frame's answer, or {@link EVALUATE_TIMEOUT}.
 */
export async function evaluateWithDeadline(frame, fn, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EVALUATE_TIMEOUT), timeoutMs);
  });
  const evaluation = Promise.resolve()
    .then(() => frame.evaluate(fn))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    const outcome = await Promise.race([evaluation, deadline]);
    if (outcome === EVALUATE_TIMEOUT) {
      return EVALUATE_TIMEOUT;
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score whether rendering actually advanced.
 *
 * @param {number[]} frameNumbers Frame numbers read from every constructed instance.
 * @param {object} [options] Options.
 * @param {number} [options.minimum] Lowest frame number that counts as "it rendered".
 * @param {boolean} [options.expectNoViewer] Invert the verdict: the demo is one
 *   of {@link NO_VIEWER_IDS} and must have rendered NO frames.
 * @returns {{ok: boolean, reason: string}} Verdict.
 */
export function evaluateFrameGate(frameNumbers, options = {}) {
  const { minimum = 2, expectNoViewer = false } = options;

  if (expectNoViewer) {
    // Inverted, not skipped — same reasoning as the renderer gate above.
    if (!Array.isArray(frameNumbers)) {
      return { ok: false, reason: "frame numbers were not readable" };
    }
    if (frameNumbers.length > 0) {
      return {
        ok: false,
        reason: `expected no rendered frames but found ${frameNumbers.join(
          ", ",
        )} — the no-viewer list is stale`,
      };
    }
    return {
      ok: true,
      reason: "no viewer instance, as expected for a viewer-less demo",
    };
  }

  if (!Array.isArray(frameNumbers) || frameNumbers.length === 0) {
    return {
      ok: false,
      reason: "no viewer instance published a frame number",
    };
  }
  const stalled = frameNumbers.filter((n) => n < minimum);
  if (stalled.length > 0) {
    return {
      ok: false,
      reason: `frameNumber ${stalled.join(", ")} did not reach ${minimum}`,
    };
  }
  return {
    ok: true,
    reason: `frameNumber ${frameNumbers.join(", ")}`,
  };
}
