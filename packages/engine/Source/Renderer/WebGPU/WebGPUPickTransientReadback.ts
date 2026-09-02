/// <reference types="@webgpu/types" />
/**
 * Overflow staging buffers for the synchronous WebGPU pick readback.
 *
 * `WebGPUPickFramebuffer` keeps ONE persistent staging buffer for the
 * synchronous path, because the common case — a hover handler picking once per
 * frame at a drifting cursor — never needs a second one. That buffer cannot be
 * reused while its `mapAsync` is outstanding, so a second pick issued before
 * the map resolves has nowhere to copy to.
 *
 * That second pick is not a rare case. `scene.pick()` is one pick-pass stale on
 * WebGPU, so a caller that wants an answer at a NEW position picks once to warm
 * it and picks again a frame later. The warm-up pick for the new position and
 * the answering pick for the previous one land in the same task, so the warm-up
 * was the request that got dropped, leaving the new position permanently
 * unwarmed. A search that starts cold still answers its FIRST position, because
 * nothing is in flight when it begins; the failure shape was therefore every
 * position after the first returning nothing, whatever was on screen. A miss at
 * the first position has some other cause and is not evidence about this pool.
 *
 * This pool hands those overflow requests their own exact-size buffer, the same
 * shape `endAsync` already uses for its per-request readbacks. It is bounded:
 * beyond the cap the caller falls back to the previous behaviour and declines,
 * so a runaway pick loop cannot grow allocations without limit. Each buffer is
 * one clipped pick rectangle — 768 bytes for the default 3x3 query — so the cap
 * is about bounding leaked maps on a device that stops resolving them, not
 * about memory.
 *
 * @private
 */

/**
 * Overflow readbacks that may be outstanding at once, on top of the persistent
 * buffer. Three covers the warm-up/answer interleave plus a frame of slack;
 * beyond that the map is not keeping up with the pick rate, which the
 * `readback-in-flight` arm decline already reports.
 * @private
 */
export const TRANSIENT_PICK_READBACK_CAPACITY = 3;

/**
 * Bounded allocator for overflow synchronous-pick staging buffers.
 * @private
 */
export class WebGPUPickTransientReadbackPool {
  private _inFlight: number = 0;
  private readonly _capacity: number;

  constructor(capacity: number = TRANSIENT_PICK_READBACK_CAPACITY) {
    this._capacity = Math.max(0, capacity);
  }

  /**
   * Overflow readbacks currently outstanding. Read by diagnostics and by the
   * capacity check below; never used to decide correctness.
   */
  get inFlight(): number {
    return this._inFlight;
  }

  get capacity(): number {
    return this._capacity;
  }

  /**
   * Allocates a buffer for one overflow readback, or returns null when the cap
   * is reached so the caller can decline exactly as it did before this pool
   * existed.
   */
  acquire(device: GPUDevice, size: number): GPUBuffer | null {
    if (!(size > 0) || this._inFlight >= this._capacity) {
      return null;
    }
    const buffer = device.createBuffer({
      label: "Pick sync overflow staging buffer",
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this._inFlight++;
    return buffer;
  }

  /**
   * Retires one acquired buffer. Safe to call after the owning framebuffer has
   * been destroyed: the buffer is this pool's to free either way.
   */
  release(buffer: GPUBuffer): void {
    if (this._inFlight > 0) {
      this._inFlight--;
    }
    buffer.destroy();
  }
}
