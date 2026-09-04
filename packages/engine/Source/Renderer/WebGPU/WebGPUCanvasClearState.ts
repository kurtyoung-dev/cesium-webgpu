/**
 * Pure interpretation of a `ClearCommand` for the WebGPU backend: which
 * channels it requests, and what the canvas clear-STATE becomes as a result.
 *
 * A `ClearCommand` in the WebGL backend does two things at once
 * (`Renderer/Context.js`): it records each requested value into GL clear-state
 * (`gl.clearColor` / `gl.clearDepth` / `gl.clearStencil`) and then issues one
 * `gl.clear`. The state half is what makes the value outlive the call — a later
 * clear that omits a channel, or any implicit clear, still uses the last
 * requested value.
 *
 * The WebGPU port kept only the second half. `WebGPUContext.clear` translates a
 * `ClearCommand` into a render pass with `loadOp:"clear"`, and the canvas
 * open is deferred further still — a canvas clear arriving before
 * anything has touched the swap texture is dropped on the premise that the
 * pending first open (`_beginDefaultRenderPass`) "delivers the same
 * `_clearColor` / `_clearDepth` / `_clearStencil` values". Nothing ever wrote
 * those fields from a clear command, so `_clearColor` stayed at its constructor
 * value — transparent black — for the life of the context.
 *
 * Consequence: on every frame whose canvas is first opened by
 * `_beginDefaultRenderPass` (the `endFrame` present fallback, the lazy
 * `executeDrawCommand` open, `resumeDefaultRenderPass`), the canvas presented
 * transparent black regardless of `scene.backgroundColor`. Content-free frames
 * are exactly that case: `WebGPUSceneRenderer.executeCommands` early-returns
 * when `shouldExecuteWebGPUSceneFrame` is false, so the scene-framebuffer pass
 * — the ONLY other consumer of `frameState.backgroundColor` — never opens, and
 * the present fallback is the sole writer of the canvas that frame. WebGL has
 * no equivalent hole: `FramebufferOrchestrator.updateAndClearFramebuffers`
 * executes the background `ClearCommand` straight against the default
 * framebuffer before any frustum work.
 *
 * This module owns that state contract as a pure function so it can be unit
 * tested without a device, and so "what does a ClearCommand request" has ONE
 * definition instead of one per call site.
 *
 * ── ABSENCE HAS EXACTLY TWO SPELLINGS, AND THEY DO NOT MIX ────────────────
 *
 * The original draft of this module used `undefined`, `false` and `null` for
 * absence across its two halves without ever saying which meant what, which is
 * the kind of thing that reads fine until someone writes `if (update.color)` and
 * silently drops a legitimate transparent-black capture. The contract is now
 * stated once, here, and enforced by the types:
 *
 *   INPUT  (`ClearChannelSlot<T>` = `T | false | undefined`)
 *     Tri-state, and NOT this module's choice — it is the `ClearCommand` shape
 *     inherited from the WebGL backend. `undefined` = the caller never populated
 *     the channel; `false` = the caller explicitly said "do not clear this one"
 *     (callers reuse a single command across passes). Both mean not-requested,
 *     but they are distinguishable to a reader and both must be handled.
 *     {@link isClearChannelRequested} is the ONE place that collapses the
 *     tri-state to a boolean; nothing else may test these slots directly.
 *
 *   OUTPUT (`CanvasClearStateUpdate`)
 *     Two-state, and entirely this module's choice: `null` — and ONLY `null` —
 *     means "leave the existing clear-state alone". `undefined` never appears in
 *     a returned field. Every returned object carries all three keys explicitly,
 *     so `"color" in update` is always true and a missing key can never be
 *     confused with an absent value. Callers therefore test `=== null`, never
 *     truthiness: `{red:0,green:0,blue:0,alpha:0}` is a real captured colour and
 *     `0` is a real captured depth/stencil.
 *
 * The asymmetry is deliberate and load-bearing: the input tri-state is a fact
 * about an API this module does not own, and flattening it at the boundary is
 * precisely this module's job.
 *
 * @module WebGPUCanvasClearState
 */

/**
 * The minimal color shape a clear request carries. Structural on purpose —
 * this module must not depend on `Core/Color`.
 */
export interface ClearStateColor {
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
  readonly alpha?: number;
}

/**
 * One `ClearCommand` channel slot: a value, an explicit `false` meaning "do not
 * clear this channel", or `undefined` meaning the caller never populated it.
 *
 * Named rather than spelled out at each use so the tri-state is impossible to
 * mistake for a plain optional. See the absence contract in the module doc.
 */
export type ClearChannelSlot<T> = T | false | undefined;

/**
 * The `ClearCommand` surface this module reads.
 */
export interface ClearStateRequest {
  readonly color?: ClearChannelSlot<ClearStateColor>;
  readonly depth?: ClearChannelSlot<number>;
  readonly stencil?: ClearChannelSlot<number>;
}

/**
 * Whether a `ClearCommand` channel slot asks for that channel to be cleared.
 *
 * THE ONLY place the input tri-state is collapsed. A plain `defined()` check is
 * not enough — `false` must read as "not requested" while legitimate zero values
 * (`depth: 0`, `stencil: 0`) must read as requested, and a truthiness check
 * would drop both of those plus a transparent-black colour.
 *
 * @param value - The raw `color` / `depth` / `stencil` slot.
 * @returns `true` when the channel is part of this clear.
 */
export function isClearChannelRequested(value: unknown): boolean {
  return value !== undefined && value !== false;
}

/**
 * The canvas clear-state deltas a clear command implies.
 *
 * `null` is the SINGLE "leave the existing state alone" sentinel — the channel
 * was not part of this clear, or this clear did not target the canvas. A field
 * is never `undefined`, and every key is always present; see the absence
 * contract in the module doc. Test `=== null`, never truthiness.
 */
export interface CanvasClearStateUpdate {
  readonly color: ClearStateColor | null;
  readonly depth: number | null;
  readonly stencil: number | null;
}

/**
 * The canonical "nothing captured" value. Exported so a caller can compare
 * against it rather than re-deriving the all-null shape, and so tests have a
 * name for the case.
 */
export const NO_CANVAS_CLEAR_STATE_UPDATE: CanvasClearStateUpdate =
  Object.freeze({
    color: null,
    depth: null,
    stencil: null,
  });

/**
 * Whether an update carries anything at all.
 *
 * @param update - An update from {@link canvasClearStateUpdate}.
 * @returns `true` when at least one channel was captured.
 */
export function hasCanvasClearStateUpdate(
  update: CanvasClearStateUpdate,
): boolean {
  return (
    update.color !== null || update.depth !== null || update.stencil !== null
  );
}

/**
 * Normalize one channel to the output contract: a captured value, or `null`.
 *
 * Written as its own step so the `undefined -> null` collapse happens in
 * exactly one place. Returning the raw slot would leak `false`/`undefined` into
 * the output type and break the "null is the only absence" guarantee.
 */
function capture<T>(slot: ClearChannelSlot<T>): T | null {
  return isClearChannelRequested(slot) ? (slot as T) : null;
}

/**
 * Compute the canvas clear-state update implied by a clear command.
 *
 * Capture is deliberately restricted to clears that resolve to the canvas swap
 * texture. An offscreen framebuffer clear (globe depth, OIT, pick, a
 * post-process intermediate) carries its own clear color and must never
 * redefine what an untouched canvas presents — that would let, for example, the
 * OIT accumulation clear repaint the page background.
 *
 * @param request - The clear command being executed. Tolerates
 *   `undefined`/`null` so callers need no pre-check.
 * @param targetsCanvas - Whether the resolved color attachment for this clear
 *   is the canvas swap-chain view.
 * @returns The per-channel state update. Every field is a captured value or
 *   `null`; never `undefined`. Equal in shape to
 *   {@link NO_CANVAS_CLEAR_STATE_UPDATE} when nothing is captured.
 */
export function canvasClearStateUpdate(
  request: ClearStateRequest | undefined | null,
  targetsCanvas: boolean,
): CanvasClearStateUpdate {
  if (!targetsCanvas || request === undefined || request === null) {
    return NO_CANVAS_CLEAR_STATE_UPDATE;
  }

  return {
    color: capture(request.color),
    depth: capture(request.depth),
    stencil: capture(request.stencil),
  };
}
