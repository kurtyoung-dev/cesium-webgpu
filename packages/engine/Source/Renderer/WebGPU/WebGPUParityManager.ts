/// <reference types="@webgpu/types" />

/**
 * @module WebGPUParityManager
 *
 * Centralized ping-pong slot resolver — FEAT-SURVEY-07.
 *
 * Every frame-history effect today tracks parity inline:
 *   - `WebGPUTAAEffect` keeps `_historyIndex` and flips it manually
 *   - A future Hi-Z reprojection pass would do the same for its previous
 *     depth pyramid
 *   - A future auto-exposure pass would do the same for its luminance
 *     histogram
 *
 * The bug surface: every consumer has to flip the index at the right
 * point in its lifecycle and read/write the right slot. When an effect
 * is added, removed, or reordered it's easy to double-flip, miss a
 * flip, or have a corrupted "read from last frame" on the frame AFTER
 * a renderer resize. Bugs of this shape are easy to ship and very hard
 * to debug because the corruption is only visible in motion.
 *
 * `WebGPUParityManager` centralizes the pattern:
 *   1. Each consumer registers a `HistorySlot` with `register()`. The
 *      slot holds two GPU resources (`a`, `b`) and a current-index
 *      that the manager owns exclusively.
 *   2. Each frame the manager advances EVERY registered slot in lock-
 *      step via `advanceFrame()`. Consumers can't forget to flip; they
 *      can't double-flip; they can't flip at the wrong time.
 *   3. Consumers call `read<T>(slot)` and `write<T>(slot)` to get the
 *      right pair for the current frame. The types are enforced per
 *      slot — a resize rebinds the slot's contents without changing
 *      the phase.
 *
 * This module is standalone: it owns no GPU resources itself and makes
 * no WebGPU API calls. It just tracks indices and parity bits. That
 * makes it trivially unit-testable (see `WebGPUParityManagerSpec.js`).
 *
 * @example
 *   const parity = new WebGPUParityManager();
 *   const taaHistorySlot = parity.register<GPUTexture>(
 *     "taa-history",
 *     [historyTexA, historyTexB],
 *   );
 *   // each frame:
 *   parity.advanceFrame();           // call ONCE per frame, at frame start
 *   const writeTex = parity.write(taaHistorySlot);
 *   const readTex = parity.read(taaHistorySlot);
 *   // ... dispatch TAA with read→write
 */

/**
 * Opaque handle returned from `register()`. The caller never constructs
 * these directly; the number is an internal index into the manager's
 * slot array. Using a nominal type keeps consumers from accidentally
 * passing a raw number where a slot ID is expected.
 */
export type HistorySlotId = number & { readonly __brand: "HistorySlotId" };

/**
 * Internal per-slot state. One of these exists for every registered
 * history consumer. The `pair` array is mutable at the element level
 * (so callers can rebind resources after a resize) but the length is
 * fixed at 2.
 */
interface HistorySlot<T> {
  readonly name: string;
  readonly pair: [T, T];
  /**
   * Phase offset applied to the global frame index for this slot.
   * Always 0 today; reserved for future multi-phase slots (e.g., a
   * triple-buffered exposure history would widen this to {0, 1, 2}).
   */
  readonly phaseOffset: number;
}

/**
 * Central ping-pong parity state.
 *
 * All history effects share a single monotonic frame counter. When a
 * consumer needs to read-from-previous-frame and write-to-current-frame,
 * it reads `pair[(frameIndex - 1) & 1]` and writes `pair[frameIndex & 1]`.
 * The manager does that arithmetic so consumers can't get it wrong.
 */
export class WebGPUParityManager {
  /**
   * Monotonically-advancing frame counter. Incremented once per frame
   * by `advanceFrame()`. The parity bit (`_frameIndex & 1`) is what
   * actually resolves to a slot index — we store the full counter
   * (not just the parity bit) so diagnostics and deferred readbacks
   * can distinguish "current frame" from "some previous frame that
   * happens to have the same parity".
   */
  private _frameIndex = 0;

  /**
   * Registered slots, indexed by the `HistorySlotId` returned from
   * `register()`. Sparse growth (no `delete`) because slot IDs are
   * stable for the lifetime of the manager.
   */
  private readonly _slots: HistorySlot<unknown>[] = [];

  /**
   * Register a pair of history resources (typically two GPUTextures or
   * two GPUBuffers). The manager stores the pair and returns a stable
   * ID the consumer passes to `read()` / `write()` every frame.
   *
   * On resize, call `rebind(id, [newA, newB])` to update the pair
   * without changing the slot's phase — this keeps frame-coherence:
   * the NEXT frame still reads from what used to be the "previous"
   * side, which after a resize is just cleared content (same as a
   * first-frame reset, which every history effect handles already).
   *
   * @param name Debug label for diagnostics. Not used for lookup.
   * @param pair The two resources. Ownership stays with the caller.
   * @param phaseOffset Reserved for future multi-phase slots.
   *   Defaults to 0. Non-zero values shift this slot's parity relative
   *   to the global frame counter.
   */
  register<T>(
    name: string,
    pair: [T, T],
    phaseOffset: number = 0,
  ): HistorySlotId {
    const id = this._slots.length as HistorySlotId;
    this._slots.push({ name, pair, phaseOffset } as HistorySlot<unknown>);
    return id;
  }

  /**
   * Update a slot's resource pair (e.g., after a canvas resize).
   * The phase is preserved — after the call, the NEW pair's slot-0
   * resource corresponds to the same parity as the OLD pair's slot-0.
   * Consumers should reset (clear to 0 / black / etc.) both halves of
   * the new pair before the next frame so history reads return a
   * well-defined "first-frame" state.
   */
  rebind<T>(id: HistorySlotId, pair: [T, T]): void {
    const slot = this._slots[id];
    //>>includeStart('debug', pragmas.debug);
    if (!slot) {
      throw new Error(`WebGPUParityManager.rebind: invalid slot id ${id}`);
    }
    //>>includeEnd('debug');
    // Cast is safe because the public API type-enforces `T` matches
    // the slot's original registration type at the call site.
    (slot.pair as unknown as [T, T])[0] = pair[0];
    (slot.pair as unknown as [T, T])[1] = pair[1];
  }

  /**
   * Advance to the next frame. Call EXACTLY ONCE per frame at frame
   * start — never from inside a consumer's `execute()`. The manager's
   * single-authority ownership of parity is the whole point.
   */
  advanceFrame(): void {
    this._frameIndex++;
  }

  /**
   * The resource to READ from this frame. For ping-pong (2-slot) this
   * is the one that was written LAST frame.
   *
   * First-frame behaviour: on `_frameIndex = 1` the read side is the
   * slot that was never written (slot 0 if phaseOffset is 0). Consumers
   * must handle this — typically by initializing both halves to a
   * known state at registration time, or by checking `frameIndex <= 1`
   * and taking a non-history path.
   */
  read<T>(id: HistorySlotId): T {
    const slot = this._slots[id] as HistorySlot<T> | undefined;
    //>>includeStart('debug', pragmas.debug);
    if (!slot) {
      throw new Error(`WebGPUParityManager.read: invalid slot id ${id}`);
    }
    //>>includeEnd('debug');
    const idx = (this._frameIndex - 1 + slot!.phaseOffset) & 1;
    return slot!.pair[idx];
  }

  /**
   * The resource to WRITE to this frame. Paired with `read()` on the
   * same slot id — guaranteed to return a different element of the
   * pair (for the 2-slot case).
   */
  write<T>(id: HistorySlotId): T {
    const slot = this._slots[id] as HistorySlot<T> | undefined;
    //>>includeStart('debug', pragmas.debug);
    if (!slot) {
      throw new Error(`WebGPUParityManager.write: invalid slot id ${id}`);
    }
    //>>includeEnd('debug');
    const idx = (this._frameIndex + slot!.phaseOffset) & 1;
    return slot!.pair[idx];
  }

  /**
   * Current frame index. Exposed for diagnostics and for consumers that
   * need to detect "first frame" explicitly (e.g., TAA falls back to a
   * UV-identity path when `frameIndex === 0`).
   */
  get frameIndex(): number {
    return this._frameIndex;
  }

  /**
   * Named slot count, for diagnostics.
   */
  get slotCount(): number {
    return this._slots.length;
  }

  /**
   * Diagnostic snapshot — one line per registered slot with its name
   * and the current read/write indices. Never called from hot paths.
   */
  getDiagnostics(): string {
    const lines: string[] = [
      `ParityManager: frameIndex=${this._frameIndex}, slots=${this._slots.length}`,
    ];
    for (let i = 0; i < this._slots.length; i++) {
      const slot = this._slots[i];
      const readIdx = (this._frameIndex - 1 + slot.phaseOffset) & 1;
      const writeIdx = (this._frameIndex + slot.phaseOffset) & 1;
      lines.push(`  [${i}] ${slot.name}: read=${readIdx} write=${writeIdx}`);
    }
    return lines.join("\n");
  }
}

export default WebGPUParityManager;
