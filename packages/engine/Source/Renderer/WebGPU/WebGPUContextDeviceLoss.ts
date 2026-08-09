/**
 * Device-loss host-adapter builder extracted from
 * `WebGPUContext._setupDeviceLostHandler`.
 *
 * The recovery logic itself lives in `WebGPUDeviceLossRecovery.ts`; what sits
 * here is the host-adapter literal, a state proxy mapping that class's
 * {@link DeviceLossRecoveryHost} interface onto the Context's
 * underscore-prefixed fields and methods.
 *
 * The shape mirrors the WebGL-stub builder: a `WebGPUDeviceLossHost`
 * interface a Context-like object satisfies, plus a
 * `buildDeviceLossRecoveryFor(host)` function that produces the live state
 * proxy and wraps it in a fresh `WebGPUDeviceLossRecovery` instance.
 *
 * The Context's own `_setupDeviceLostHandler` becomes a 3-line
 * delegator. `_reconfigureCanvas`, `onDeviceLost`, `deviceLossState`,
 * and `recoveryAttempts` stay on the Context — they're either thin
 * delegators over the recovery instance or canvas-config bodies that
 * touch private state directly.
 *
 * @module WebGPUContextDeviceLoss
 */

import {
  WebGPUDeviceLossRecovery,
  type DeviceLossRecoveryHost,
} from "./WebGPUDeviceLossRecovery.js";

/**
 * The Context surface the device-loss host-adapter reaches back to.
 * `_options` and `_context` are read-only here; `_adapter` / `_device`
 * / `_isDestroyed` need a writable path because the recovery class
 * sets the new device + adapter when it succeeds.
 */
export interface WebGPUDeviceLossHost {
  // Read access (the host adapter exposes these via getters)
  _adapter: GPUAdapter | null;
  _device: GPUDevice | null;
  /**
   * Read by the recovery class to decide between pool-routed recovery
   * (when true)
   * and the legacy direct `adapter.requestDevice` path (when false).
   * Recovery's `_setDevice` callback updates this flag based on which
   * path was taken so the destroy path consults it correctly.
   */
  _deviceFromPool: boolean;
  _isDestroyed: boolean;
  _isTerminallyLost: boolean;
  // Subset of `WebGPUContextOptions` the recovery class actually
  // reads. Structural-typed here so this module doesn't need to
  // import the full options interface (which would create a
  // circular import — `WebGPUContextOptions` lives in
  // `WebGPUContext.ts`).
  _options: {
    powerPreference?: GPUPowerPreference;
    featureLevel?: "core" | "compatibility";
    requiredFeatures?: GPUFeatureName[];
    requiredLimits?: Record<string, number>;
    useDevicePool?: boolean;
  };
  _context: GPUCanvasContext | null;

  // Method callbacks the recovery class invokes after acquiring a
  // new device.
  _initializeContextLimits(): void;
  _reconfigureCanvas(): void;
  _initializeDefaultTextures(): void;
  _clearAllCaches(previousDevice?: GPUDevice | null): void;
  _rollbackRecoveredDevice(candidateDevice: GPUDevice): void;
  destroy(): void;
}

/**
 * Build the `WebGPUDeviceLossRecovery` instance + its host-adapter
 * proxy for a given Context. Returns the recovery instance so the
 * caller can store it and call `setupHandler(device)` on the current
 * device.
 *
 * The `_setAdapter` / `_setDevice` setters on the host adapter
 * forward through the same `host` reference so the recovery class
 * can swap to a fresh adapter/device on a successful recovery.
 *
 * @param host - The owning WebGPUContext (or any matching shape).
 * @param maxRecoveryAttempts - Forwarded to the recovery class
 *   constructor (default 3 in the original `_setupDeviceLostHandler`).
 */
export function buildDeviceLossRecoveryFor(
  host: WebGPUDeviceLossHost,
  maxRecoveryAttempts: number = 3,
): WebGPUDeviceLossRecovery {
  const adapter: DeviceLossRecoveryHost = {
    get _adapter() {
      return host._adapter;
    },
    get _device() {
      return host._device;
    },
    get _isDestroyed() {
      return host._isDestroyed;
    },
    set _isDestroyed(v: boolean) {
      host._isDestroyed = v;
    },
    get _isTerminallyLost() {
      return host._isTerminallyLost;
    },
    set _isTerminallyLost(v: boolean) {
      host._isTerminallyLost = v;
    },
    get _options() {
      return host._options;
    },
    get _context() {
      return host._context;
    },
    _setAdapter: (a: GPUAdapter | null) => {
      host._adapter = a;
    },
    _setDevice: (d: GPUDevice | null) => {
      host._device = d;
      // Recovery routes through `WebGPUDevicePool` when the original device
      // was pool-managed (the common case). The pool's `acquireDevice`
      // handles the dedup of concurrent per-context recoveries: the
      // first recovering context creates the new shared primary;
      // others await the in-flight Promise and increment refcount on
      // the same new device. Result: cross-context sharing is
      // preserved across the loss event.
      //
      // The recovery class's `_attemptRecovery` flips
      // `host._deviceFromPool` itself based on whether it took the
      // pool path or the legacy direct-request path. This callback
      // just plumbs the new device handle.
    },
    get _deviceFromPool() {
      return host._deviceFromPool;
    },
    set _deviceFromPool(v: boolean) {
      host._deviceFromPool = v;
    },
    _initializeContextLimits: () => host._initializeContextLimits(),
    _reconfigureCanvas: () => host._reconfigureCanvas(),
    _initializeDefaultTextures: () => host._initializeDefaultTextures(),
    _clearAllCaches: (previousDevice?: GPUDevice | null) =>
      host._clearAllCaches(previousDevice),
    _rollbackRecoveredDevice: (candidateDevice: GPUDevice) =>
      host._rollbackRecoveredDevice(candidateDevice),
    _finalizeTerminalLoss: () => host.destroy(),
  };

  return new WebGPUDeviceLossRecovery(adapter, maxRecoveryAttempts);
}
