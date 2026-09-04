/**
 * Display-capability detection and the pure decision function behind
 * `Scene#highDynamicRange`'s default.
 *
 * Before this module, `Scene` hardcoded `highDynamicRange = false` regardless
 * of what the display could actually show. The CSS Media Queries Level 4
 * `dynamic-range` / `video-dynamic-range` features answer that question
 * directly, and they are *live* — a window dragged from an SDR monitor to an
 * HDR one (or a display toggled out of HDR mode in the OS) fires a `change`
 * event on the `MediaQueryList`. So detection is a subscription, not a
 * one-shot read.
 *
 * ## Why the decision lives here and not in `Scene.js`
 *
 * The interesting part of this feature is a five-input predicate whose failure
 * modes are all silent — flipping HDR on a display that cannot show it,
 * clobbering a value the application deliberately set, or throwing in an
 * environment with no `window`. `resolveHdrDefault` is a pure function over
 * plain data so `Tools/visual-regression/hdr-display-default.spec.mjs` can
 * exercise every one of those in Node, with no browser and no HDR monitor.
 * `Scene` keeps only the state-plumbing half.
 *
 * ## The three governing rules
 *
 * 1. **Explicitly overridable.** An application that assigns
 *    `scene.highDynamicRange` owns the value forever afterwards —
 *    "detect-only-until-touched". Detection never fights the app, in either
 *    direction, and a later monitor change does not resurrect it.
 * 2. **Byte-identical on SDR displays.** The target is
 *    `displayIsHdr && contextSupportsHdr`; on an SDR display that is `false`,
 *    which is exactly the historical hardcoded default, so nothing is applied
 *    and no code path changes.
 * 3. **No tonemap-operator change.** This module decides a boolean. It has no
 *    opinion about which tonemapper runs — deliberately, because ACES ends in
 *    a per-channel `clamp(0,1)` that maximises hue-shift-to-white on exactly
 *    the bright celestial pixels this fork's HDR rendering was built to
 *    preserve.
 *
 * A fourth rule is this module's own: **unknown is not SDR.** When there is no
 * `matchMedia` (Node, jsdom, a `--test` process) or the browser does not
 * understand the media feature, `displayIsHdr` is `undefined` and the resolver
 * applies *nothing*. It never guesses in either direction.
 *
 * @module HdrDisplayCapability
 */

/**
 * How far {@link Scene} is allowed to act on the detected display capability.
 *
 * - `"off"` — no detection at all; the historical hardcoded SDR default.
 * - `"scene"` — default `Scene#highDynamicRange` from the display. The scene
 *   framebuffer becomes `rgba16float` and the post-process chain keeps its
 *   normal SDR tonemap on the way to the canvas. This is the default.
 * - `"scene-and-canvas"` — additionally default `Scene#useHDRCanvasOutput`,
 *   which skips the SDR tonemap and configures the WebGPU canvas for extended
 *   range (`rgba16float` + `display-p3` + `toneMapping: {mode:"extended"}`).
 *   Opt-in because it is the half that cannot be verified without a real HDR
 *   display, and because WebGL has no canvas-colour-space equivalent — see the
 *   `canvasExtendedRangeSupported` input.
 */
export type HdrDisplayPolicyValue = "off" | "scene" | "scene-and-canvas";

/**
 * Enumerated {@link HdrDisplayPolicyValue} constants. Frozen so a typo in an
 * application fails at the `normalizeHdrDisplayPolicy` guard rather than
 * silently disabling detection.
 */
export const HdrDisplayPolicy = Object.freeze({
  OFF: "off",
  SCENE: "scene",
  SCENE_AND_CANVAS: "scene-and-canvas",
}) as Readonly<Record<string, HdrDisplayPolicyValue>>;

/**
 * Why {@link resolveHdrDefault} reached the answer it did. Reported so a
 * caller (and the spec) can distinguish "did not flip because the display is
 * SDR" from "did not flip because detection is unavailable" — those look
 * identical from the outside and have very different follow-ups.
 */
export type HdrDecisionReasonValue =
  | "policy-off"
  | "detection-unavailable"
  | "context-unsupported"
  | "sdr-display"
  | "hdr-display";

/** Enumerated {@link HdrDecisionReasonValue} constants. */
export const HdrDecisionReason = Object.freeze({
  POLICY_OFF: "policy-off",
  DETECTION_UNAVAILABLE: "detection-unavailable",
  CONTEXT_UNSUPPORTED: "context-unsupported",
  SDR_DISPLAY: "sdr-display",
  HDR_DISPLAY: "hdr-display",
}) as Readonly<Record<string, HdrDecisionReasonValue>>;

/**
 * The media features queried, in order. Both are CSS Media Queries Level 4.
 *
 * `dynamic-range` describes what the *output device* can present;
 * `video-dynamic-range` is the same question restricted to video-plane
 * content, and some browsers shipped it first. Either matching is taken as
 * "the display can show HDR" — the two disagree only on hardware where the
 * video plane is HDR-capable but the composited page plane is not, and on such
 * a device the scene framebuffer precision upgrade is still correct.
 */
export const HDR_DISPLAY_MEDIA_QUERIES: readonly string[] = Object.freeze([
  "(dynamic-range: high)",
  "(video-dynamic-range: high)",
]);

/**
 * The subset of `MediaQueryList` this module uses. Declared structurally so a
 * spec can hand in a plain object, and so the legacy
 * `addListener`/`removeListener` pair (pre-14 Safari, where
 * `MediaQueryList` is not an `EventTarget`) is expressible.
 */
export interface MediaQueryListLike {
  readonly matches: boolean;
  /**
   * The serialized query. A browser that does not understand the media
   * feature normalizes it to the literal `"not all"` — the only way to tell
   * "this display is SDR" from "this browser has never heard of
   * `dynamic-range`", since both report `matches === false`.
   */
  readonly media?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** The subset of `window` this module uses. */
export interface MatchMediaHost {
  matchMedia?: (query: string) => MediaQueryListLike | null | undefined;
}

/** Result of {@link queryHdrDisplay}. */
export interface HdrDisplayQuery {
  /**
   * True when at least one of {@link HDR_DISPLAY_MEDIA_QUERIES} was understood
   * by the host. False in Node, in a browser predating the media feature, and
   * whenever `matchMedia` is missing or throws.
   */
  detectionAvailable: boolean;
  /**
   * `true` / `false` when the display capability is known, `undefined` when it
   * is not. `undefined` is NOT a synonym for SDR — see the module header.
   */
  displayIsHdr: boolean | undefined;
  /**
   * The understood `MediaQueryList`s, retained so {@link observeHdrDisplay}
   * can subscribe to the same objects that produced `displayIsHdr`.
   */
  lists: MediaQueryListLike[];
}

/** Inputs to {@link resolveHdrDefault}. All plain data — no engine objects. */
export interface HdrDefaultInput {
  /** From {@link HdrDisplayQuery.displayIsHdr}. */
  displayIsHdr: boolean | undefined;
  /** `Scene#highDynamicRangeSupported` — depth texture + float colour buffer. */
  contextSupportsHdr: boolean;
  /** `Scene#hdrDisplayPolicy`. */
  policy: HdrDisplayPolicyValue;
  /**
   * Whether the graphics context can widen the canvas itself, i.e. exposes
   * `setHDRCanvasOutput`. True on WebGPU, false on WebGL — `GPUCanvasContext.
   * configure` has no WebGL counterpart, so on WebGL skipping the SDR tonemap
   * would forward >1.0 values into an 8-bit canvas and blow out the highlights
   * rather than showing them.
   */
  canvasExtendedRangeSupported: boolean;
  /** Whether the application has ever assigned `Scene#highDynamicRange`. */
  sceneHdrUserSet: boolean;
  /** Whether the application has ever assigned `Scene#useHDRCanvasOutput`. */
  canvasOutputUserSet: boolean;
  /** Current `Scene#highDynamicRange`. */
  currentSceneHdr: boolean;
  /** Current `Scene#useHDRCanvasOutput`. */
  currentCanvasOutput: boolean;
}

/** Output of {@link resolveHdrDefault}. */
export interface HdrDefaultDecision {
  /** True when the caller should assign {@link HdrDefaultDecision.sceneHdr}. */
  applySceneHdr: boolean;
  /** The value to assign when `applySceneHdr` is true. */
  sceneHdr: boolean;
  /** True when the caller should assign {@link HdrDefaultDecision.canvasOutput}. */
  applyCanvasOutput: boolean;
  /** The value to assign when `applyCanvasOutput` is true. */
  canvasOutput: boolean;
  /** Why — see {@link HdrDecisionReasonValue}. */
  reason: HdrDecisionReasonValue;
}

/**
 * Coerces an arbitrary value to a valid {@link HdrDisplayPolicyValue},
 * defaulting to `"scene"`. Mirrors the `Scene#gpuCullingHint` normalisation
 * pattern: an unrecognised value falls back to the documented default rather
 * than corrupting the state machine.
 */
export function normalizeHdrDisplayPolicy(
  value: unknown,
): HdrDisplayPolicyValue {
  return value === "off" || value === "scene-and-canvas"
    ? value
    : (HdrDisplayPolicy.SCENE as HdrDisplayPolicyValue);
}

/**
 * Reads the display's HDR capability from a `window`-like host.
 *
 * Never throws: a missing host, a missing/`null` `matchMedia`, a `matchMedia`
 * that throws, and a `MediaQueryList` without a boolean `matches` all resolve
 * to `{ detectionAvailable: false, displayIsHdr: undefined }`. That is the
 * shape the resolver treats as "apply nothing", which is what keeps
 * `node --test`, jsdom and old browsers on the historical SDR path.
 *
 * @param host Typically `window`. Optional so callers need no `typeof` dance.
 */
export function queryHdrDisplay(host?: MatchMediaHost | null): HdrDisplayQuery {
  const lists: MediaQueryListLike[] = [];
  if (
    host === null ||
    host === undefined ||
    typeof host.matchMedia !== "function"
  ) {
    return { detectionAvailable: false, displayIsHdr: undefined, lists };
  }

  // Bounded: HDR_DISPLAY_MEDIA_QUERIES is a frozen two-element list.
  for (let i = 0; i < HDR_DISPLAY_MEDIA_QUERIES.length; i++) {
    let mql: MediaQueryListLike | null | undefined;
    try {
      mql = host.matchMedia(HDR_DISPLAY_MEDIA_QUERIES[i]);
    } catch (e) {
      continue;
    }
    if (
      mql === null ||
      mql === undefined ||
      typeof mql.matches !== "boolean" ||
      // "not all" is how a browser serializes a media feature it does not
      // recognise. Its `matches` is permanently false, which would otherwise
      // be indistinguishable from a genuine SDR display.
      mql.media === "not all"
    ) {
      continue;
    }
    lists.push(mql);
  }

  if (lists.length === 0) {
    return { detectionAvailable: false, displayIsHdr: undefined, lists };
  }
  return {
    detectionAvailable: true,
    displayIsHdr: anyListMatches(lists),
    lists,
  };
}

/**
 * True when any of the retained `MediaQueryList`s currently matches. Exported
 * so the change handler and the initial read share one definition of "the
 * display is HDR" — two spellings of that would be a drift source.
 */
export function anyListMatches(lists: readonly MediaQueryListLike[]): boolean {
  // Bounded: `lists` holds at most one entry per HDR_DISPLAY_MEDIA_QUERIES.
  for (let i = 0; i < lists.length; i++) {
    if (lists[i].matches === true) {
      return true;
    }
  }
  return false;
}

/**
 * Subscribes to display-capability changes and returns an unsubscribe
 * function.
 *
 * This is the half that makes the feature correct rather than merely present:
 * a laptop dragged to an HDR external monitor, an OS HDR-mode toggle, and a
 * browser window moved between screens all fire `change` — without this, the
 * default would be frozen at whatever the display was during
 * `Scene` construction.
 *
 * Returns a no-op disposer when detection is unavailable, so the caller needs
 * no branch. Handler exceptions are swallowed: a listener that throws must not
 * break the browser's media-query dispatch for the rest of the page.
 *
 * @param host Typically `window`.
 * @param callback Invoked with the new capability whenever it changes.
 * @returns A function that detaches every listener this call attached.
 */
export function observeHdrDisplay(
  host: MatchMediaHost | null | undefined,
  callback: (displayIsHdr: boolean) => void,
): () => void {
  const { lists } = queryHdrDisplay(host);
  if (lists.length === 0) {
    return function noop() {};
  }

  const handler = function () {
    let value: boolean;
    try {
      value = anyListMatches(lists);
    } catch (e) {
      return;
    }
    try {
      callback(value);
    } catch (e) {
      // A Scene that throws while re-resolving must not poison the page's
      // media-query dispatch. Real errors surface from the callback's own
      // logging, not from here.
    }
  };

  const detachers: (() => void)[] = [];
  // Bounded: one iteration per understood media query (at most two).
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    try {
      if (typeof list.addEventListener === "function") {
        list.addEventListener("change", handler);
        detachers.push(function () {
          list.removeEventListener?.("change", handler);
        });
      } else if (typeof list.addListener === "function") {
        // Safari < 14 predates `MediaQueryList extends EventTarget`.
        list.addListener(handler);
        detachers.push(function () {
          list.removeListener?.(handler);
        });
      }
    } catch (e) {
      // Attaching failed; the initial read still stands, we simply will not
      // see later changes on this list.
    }
  }

  return function unobserve() {
    // Bounded by `detachers.length` (at most two).
    for (let i = 0; i < detachers.length; i++) {
      try {
        detachers[i]();
      } catch (e) {
        // Nothing actionable — the list is going away with the page.
      }
    }
    detachers.length = 0;
  };
}

/**
 * The HDR-default decision. Pure: same inputs always produce the same
 * output, no globals, no engine objects.
 *
 * Order of the guards is the specification:
 *
 * 1. `policy === "off"` — apply nothing.
 * 2. `displayIsHdr === undefined` — apply nothing. Unknown is not SDR, and
 *    "apply nothing" is what guarantees byte-identical behaviour wherever
 *    detection cannot run.
 * 3. Otherwise the target is `displayIsHdr && contextSupportsHdr`, and the
 *    reason distinguishes which of the two vetoed it.
 * 4. The scene value is applied only when the application has not set it AND
 *    the target differs from the current value — so this is idempotent and a
 *    no-op re-resolve does not dirty the HDR state.
 * 5. The canvas value is additionally gated on the policy, on the context
 *    actually being able to widen the canvas, and on the *effective* scene HDR
 *    value. That last gate matters: an app that pinned `highDynamicRange` to
 *    false must not end up with an extended-range canvas fed by an SDR
 *    framebuffer.
 */
export function resolveHdrDefault(input: HdrDefaultInput): HdrDefaultDecision {
  const unchanged: HdrDefaultDecision = {
    applySceneHdr: false,
    sceneHdr: input.currentSceneHdr,
    applyCanvasOutput: false,
    canvasOutput: input.currentCanvasOutput,
    reason: HdrDecisionReason.POLICY_OFF,
  };

  if (input.policy === "off") {
    return unchanged;
  }
  if (input.displayIsHdr === undefined) {
    return {
      ...unchanged,
      reason: HdrDecisionReason.DETECTION_UNAVAILABLE,
    };
  }

  const displayIsHdr = input.displayIsHdr === true;
  const target = displayIsHdr && input.contextSupportsHdr === true;
  const reason = !input.contextSupportsHdr
    ? HdrDecisionReason.CONTEXT_UNSUPPORTED
    : displayIsHdr
      ? HdrDecisionReason.HDR_DISPLAY
      : HdrDecisionReason.SDR_DISPLAY;

  const sceneHdrLocked = input.sceneHdrUserSet === true;
  const applySceneHdr = !sceneHdrLocked && input.currentSceneHdr !== target;
  // What `Scene#highDynamicRange` will read after this decision is applied —
  // the user's pinned value when locked, otherwise the target.
  const effectiveSceneHdr = sceneHdrLocked ? input.currentSceneHdr : target;

  const canvasEligible =
    input.policy === "scene-and-canvas" &&
    input.canvasExtendedRangeSupported === true;
  const canvasTarget = canvasEligible && target && effectiveSceneHdr;
  const applyCanvasOutput =
    canvasEligible &&
    input.canvasOutputUserSet !== true &&
    input.currentCanvasOutput !== canvasTarget;

  return {
    applySceneHdr,
    sceneHdr: applySceneHdr ? target : input.currentSceneHdr,
    applyCanvasOutput,
    canvasOutput: applyCanvasOutput ? canvasTarget : input.currentCanvasOutput,
    reason,
  };
}
