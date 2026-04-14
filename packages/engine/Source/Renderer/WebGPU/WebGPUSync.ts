/**
 * WebGPU equivalent of Sync.js (WebGL2 fence sync).
 *
 * WebGL2 uses `gl.fenceSync()` + polling `gl.getSyncParameter()` to detect
 * when the GPU has finished all commands submitted before the fence.
 *
 * WebGPU replaces this with `device.queue.onSubmittedWorkDone()` which returns
 * a Promise that resolves when all previously submitted GPU commands complete.
 *
 * This class provides the same API surface as `Sync.js`:
 *   - `create(options)` — factory
 *   - `getStatus()` — SIGNALED or UNSIGNALED
 *   - `waitForSignal(scheduleFunction, ttl)` — async wait
 *   - `destroy()` — cleanup
 *
 * Used by `PickFramebuffer.endAsync` for GPU readback synchronization.
 *
 * @private
 */

const SyncStatus = Object.freeze({
  UNSIGNALED: 0,
  SIGNALED: 1,
});

interface WebGPUSyncOptions {
  context: CesiumGraphicsContext; // WebGPUContext
}

class WebGPUSync {
  private _device: GPUDevice | null;
  private _signaled: boolean;
  private _destroyed: boolean;
  private _signalPromise: Promise<void> | null;

  constructor(options: WebGPUSyncOptions) {
    const context = options.context;
    if (!context || !context._device) {
      throw new Error("A WebGPU context with an active device is required.");
    }

    this._device = context._device;
    this._signaled = false;
    this._destroyed = false;

    // Immediately request a signal when submitted work completes.
    // This is the WebGPU equivalent of gl.fenceSync(SYNC_GPU_COMMANDS_COMPLETE).
    this._signalPromise = this._device.queue
      .onSubmittedWorkDone()
      .then(() => {
        this._signaled = true;
      })
      .catch(() => {
        // Device lost or other error — treat as signaled to unblock callers
        this._signaled = true;
      });
  }

  /**
   * Factory method matching the Sync.js API.
   */
  static create(options: WebGPUSyncOptions): WebGPUSync {
    return new WebGPUSync(options);
  }

  /**
   * Returns the current signal status.
   * In WebGPU this is resolved via the onSubmittedWorkDone promise.
   */
  getStatus(): number {
    return this._signaled ? SyncStatus.SIGNALED : SyncStatus.UNSIGNALED;
  }

  /**
   * Wait for the GPU to signal completion of all previously submitted work.
   *
   * In WebGL2, this polls `gl.getSyncParameter()` each frame via
   * `scheduleFunction`. In WebGPU, we simply await the
   * `onSubmittedWorkDone()` promise, then use `scheduleFunction` to
   * defer resolution to the next frame for consistency with the
   * WebGL frame-callback pattern used by PickFramebuffer.
   *
   * @param scheduleFunction - Callback to schedule the next check
   *   (e.g. `(next) => frameState.afterRender.push(next)`)
   * @param ttl - Time-to-live in iterations (default 10). Ignored
   *   in WebGPU since the promise resolves deterministically.
   * @returns Promise that resolves when GPU work is complete.
   */
  async waitForSignal(
    scheduleFunction?: (next: () => void) => void,
    ttl: number = 10,
  ): Promise<void> {
    if (this._destroyed) {
      throw new Error("WebGPUSync has been destroyed.");
    }

    // If already signaled, resolve immediately
    if (this._signaled) {
      return;
    }

    // Wait for the GPU queue to finish
    await this._signalPromise;

    // Optionally defer to the next frame via scheduleFunction
    // for consistency with the WebGL polling pattern
    if (scheduleFunction) {
      await new Promise<void>((resolve) => {
        scheduleFunction(() => resolve());
      });
    }
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    this._device = null;
    this._signalPromise = null;
    this._destroyed = true;
  }
}

export default WebGPUSync;
export { SyncStatus };
