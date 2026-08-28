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
