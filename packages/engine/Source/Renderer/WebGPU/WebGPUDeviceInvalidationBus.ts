/**
 * Subscriber bus for device-invalidation events on a WebGPU context.
 *
 * Backs `WebGPUContext.onDeviceInvalidated` and
 * `_fireDeviceInvalidated`. The bus fires once per device-loss event, after
 * the Context-owned caches drop their stale GPU handles, giving subscribed
 * subsystems a single hook to do the same with their private caches.
 *
 * Subscriber errors are caught + logged so one failing subsystem
 * doesn't block the rest from cleaning up. The error log includes
 * the owning context's id (or "?" if unset) so multi-context setups
 * can attribute the failure.
 *
 * @module WebGPUDeviceInvalidationBus
 */

/**
 * Whether a cache entry built for an earlier `GPUDevice` must be rebuilt
 * against the live one.
 *
 * Device-loss recovery reuses the host objects a cache hangs from - the
 * Context, a Scene-side object, a `WeakMap` keyed on either - so a
 * presence-only guard (`if (cached)`) stays satisfied and the subsystem
 * binds handles from the dead device into new-device bind groups. Identity
 * against the live device is the check that distinguishes the two, and
 * `null` reads as "rebuild" so a first call needs no separate branch.
 *
 * Typed on the device field alone so any cache struct carrying a `device`
 * can consume it without a shared base type.
 */
export function shouldRebuildForDevice(
  cached: { device: GPUDevice } | null | undefined,
  liveDevice: GPUDevice,
): boolean {
  return (
    cached === null || cached === undefined || cached.device !== liveDevice
  );
}

/**
 * Devices whose `lost` promise has resolved.
 *
 * WebGPU publishes loss only as a promise, so nothing in the engine can ask
 * synchronously whether the device it is about to record work against is still
 * alive. Between the loss and the moment recovery publishes a replacement,
 * every producer that reads `context.device` still sees a handle that looks
 * usable, and keeps allocating against it. One shared registry lets the first
 * subsystem to observe the loss answer that question for all of them.
 *
 * A `WeakSet` holds the entry no longer than the device itself, and a
 * replacement device is simply absent from it, so the answer flips back the
 * instant recovery swaps the handle - no flag to clear and no epoch to bump.
 */
const lostDevices = new WeakSet<GPUDevice>();

/**
 * Devices that have failed an operation the way a dying device fails, keyed to
 * when they last did so.
 *
 * A GPU-process termination is visible to pipeline creation well before
 * `device.lost` settles: the create rejects with a non-validation error while
 * the lost promise is still pending. That rejection is the earliest signal the
 * page has, but it is a suspicion rather than a fact - a driver can reject one
 * create and stay healthy - so it expires after
 * {@link DEVICE_SUSPECT_WINDOW_MS} and any success clears it. Nothing that
 * rendering depends on may be gated on it; only speculative work.
 */
const suspectDevices = new WeakMap<GPUDevice, number>();

/**
 * How long one unexplained failure keeps a device under suspicion. Long enough
 * to cover the observed gap between the first dead-device rejection and the
 * lost promise settling, short enough that a false positive costs at most one
 * skipped round of speculative pre-cooking.
 */
export const DEVICE_SUSPECT_WINDOW_MS = 1000;

/**
 * Record that a device is gone. Called from every `device.lost` handler,
 * before any other work, so the answer is available to producers running in
 * the same task as the handler.
 */
export function markDeviceLost(device: GPUDevice | null | undefined): void {
  if (device) {
    lostDevices.add(device);
  }
}

/**
 * Whether `device` has been reported lost. A missing device reads as not
 * lost: absence of a device is a separate condition callers already test, and
 * conflating the two would make a not-yet-initialized context look broken.
 */
export function isDeviceLost(device: GPUDevice | null | undefined): boolean {
  return device !== null && device !== undefined && lostDevices.has(device);
}

/**
 * Flag a device that just failed in a way a live device does not. Ignored once
 * the device is known lost - the stronger fact is already recorded.
 */
export function markDeviceSuspect(
  device: GPUDevice | null | undefined,
  nowMs: number = Date.now(),
): void {
  if (device && !lostDevices.has(device)) {
    suspectDevices.set(device, nowMs);
  }
}

/** Withdraw suspicion. Any successful operation on the device clears it. */
export function clearDeviceSuspect(device: GPUDevice | null | undefined): void {
  if (device) {
    suspectDevices.delete(device);
  }
}

/**
 * Whether `device` failed recently enough that speculative work should wait.
 * Expiry is evaluated on read rather than by a timer so the registry owns no
 * scheduling and a page that stops rendering leaves nothing pending.
 */
export function isDeviceSuspect(
  device: GPUDevice | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!device) {
    return false;
  }
  const since = suspectDevices.get(device);
  if (since === undefined) {
    return false;
  }
  if (nowMs - since >= DEVICE_SUSPECT_WINDOW_MS) {
    suspectDevices.delete(device);
    return false;
  }
  return true;
}

/**
 * Whether a rejected GPU operation implicates the device rather than the work
 * submitted to it. A `GPUPipelineError` with reason `"validation"` means the
 * descriptor or the shader is wrong and would fail on any device; everything
 * else - an internal pipeline error, a bare `Error` from a wire that has lost
 * its backing process - is a statement about the device.
 */
export function isDeviceFailureSignal(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null | undefined)?.reason;
  return reason !== "validation";
}

export class WebGPUDeviceInvalidationBus {
  private listeners = new Set<() => void>();
  private contextIdProvider: () => string | undefined;

  /**
   * @param contextIdProvider - Returns the owning context's id when
   *   called. Provided as a callable rather than a string snapshot
   *   so the bus picks up changes (e.g. id assignment after the
   *   bus is constructed during early Context init).
   */
  constructor(contextIdProvider: () => string | undefined) {
    this.contextIdProvider = contextIdProvider;
  }

  /**
   * Register a subscriber. Returns an unsubscribe function. Idempotent
   * over a given `callback` reference: a second subscribe with the
   * same callback is a no-op (Set semantics).
   */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Dispatch the invalidation event to every subscriber. Individual
   * subscriber errors are caught + logged so one failing subsystem
   * doesn't block the rest from cleaning up.
   */
  fire(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        const id = this.contextIdProvider() ?? "?";
        console.error(
          `[WebGPU:ctx-${id}] Device-invalidation subscriber threw:`,
          e,
        );
      }
    }
  }

  /**
   * Number of currently-registered subscribers. Exposed for
   * diagnostics + tests; not part of the production hot path.
   */
  get size(): number {
    return this.listeners.size;
  }

  /**
   * Drop all subscribers. Used by the Context's destroy path so a
   * destroyed Context doesn't keep references to long-lived
   * subscriber closures.
   */
  clear(): void {
    this.listeners.clear();
  }
}

export default WebGPUDeviceInvalidationBus;
