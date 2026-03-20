/**
 * @module WebGPUDevicePool
 *
 * Strategy B: WebGPU Device Sharing — One GPUDevice, Multiple Canvases.
 *
 * WebGPU allows a single GPUDevice to configure multiple GPUCanvasContexts.
 * This means GPU resources (buffers, textures, pipelines, bind groups) created
 * on one device are automatically shared across ALL canvases using that device.
 *
 * This is the optimal strategy for multi-view WebGPU scenarios:
 * - Split-screen: Two canvases, one device → ~90% GPU memory savings vs. two devices
 * - Multi-monitor: Each output canvas configured with the same device
 * - Picture-in-picture: Main canvas + thumbnail canvas sharing resources
 *
 * ## How It Works
 * ```
 * GPUAdapter → GPUDevice (ONE instance)
 *   ├─ Canvas A → canvasA.getContext('webgpu').configure({ device })
 *   ├─ Canvas B → canvasB.getContext('webgpu').configure({ device })
 *   └─ All GPU resources (buffers, textures, pipelines) shared automatically
 * ```
 *
 * ## Usage
 * ```typescript
 * const pool = WebGPUDevicePool.instance;
 *
 * // First context requests a device — pool creates it
 * const { device, adapter } = await pool.acquireDevice();
 *
 * // Second context requests a device — pool returns the SAME one
 * const { device: sameDevice } = await pool.acquireDevice();
 * console.assert(device === sameDevice); // true!
 *
 * // Configure each canvas with the shared device
 * canvasA.getContext('webgpu').configure({ device, format });
 * canvasB.getContext('webgpu').configure({ device, format });
 * ```
 *
 * @see SharedResourcePool
 * @see ContextRegistry
 */

/**
 * Options for device acquisition.
 */
export interface DeviceAcquisitionOptions {
  /**
   * Power preference for the GPU adapter.
   * @default 'high-performance'
   */
  powerPreference?: GPUPowerPreference;

  /**
   * Required WebGPU features for the device.
   * If the shared device doesn't support a required feature, a new device is created.
   */
  requiredFeatures?: GPUFeatureName[];

  /**
   * Required limits for the device.
   */
  requiredLimits?: Record<string, number>;

  /**
   * Force creation of a NEW device instead of sharing.
   * Use when you need an isolated GPU context (e.g., for testing).
   * @default false
   */
  forceNewDevice?: boolean;
}

/**
 * A managed device entry in the pool.
 */
interface PooledDevice {
  device: GPUDevice;
  adapter: GPUAdapter;
  refCount: number;
  features: ReadonlySet<string>;
  isLost: boolean;
  lostReason?: string;
}

/**
 * Pool that manages shared GPUDevice instances for multi-canvas WebGPU rendering.
 *
 * When multiple WebGPU contexts are needed (e.g., split-screen), this pool
 * ensures they share the same GPUDevice, which means all GPU resources
 * (buffers, textures, pipelines) are shared automatically — saving ~90% of
 * GPU memory compared to creating separate devices.
 */
export class WebGPUDevicePool {
  private static _instance: WebGPUDevicePool | null = null;

  /**
   * The primary shared device (most contexts will use this).
   */
  private _primaryDevice: PooledDevice | null = null;

  /**
   * Additional devices for special cases (e.g., different feature requirements).
   */
  private _additionalDevices: PooledDevice[] = [];

  /**
   * Get the singleton instance.
   */
  static get instance(): WebGPUDevicePool {
    if (!WebGPUDevicePool._instance) {
      WebGPUDevicePool._instance = new WebGPUDevicePool();
    }
    return WebGPUDevicePool._instance;
  }

  /**
   * Check if WebGPU is available in this environment.
   */
  static get isWebGPUAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  /**
   * Acquire a GPUDevice. If a shared device already exists and supports
   * the required features, the same device is returned. Otherwise, a new
   * device is created.
   *
   * @param options - Device acquisition options
   * @returns The device and adapter, plus the preferred canvas format
   */
  async acquireDevice(options?: DeviceAcquisitionOptions): Promise<{
    device: GPUDevice;
    adapter: GPUAdapter;
    preferredFormat: GPUTextureFormat;
    isShared: boolean;
  }> {
    const opts = options ?? {};
    const requiredFeatures = opts.requiredFeatures ?? [];

    // If forced new device, skip sharing
    if (opts.forceNewDevice) {
      return await this._createNewDevice(opts, false);
    }

    // Try to reuse the primary device
    if (this._primaryDevice && !this._primaryDevice.isLost) {
      // Check if it supports all required features
      const supportsAll = requiredFeatures.every((f) =>
        this._primaryDevice!.features.has(f),
      );

      if (supportsAll) {
        this._primaryDevice.refCount++;
        return {
          device: this._primaryDevice.device,
          adapter: this._primaryDevice.adapter,
          preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
          isShared: true,
        };
      }
    }

    // No shared device yet, or it doesn't support required features — create one
    const isPrimary = this._primaryDevice === null;
    return await this._createNewDevice(opts, isPrimary);
  }

  /**
   * Release a reference to a device. When refCount reaches zero,
   * the device is destroyed.
   *
   * @param device - The GPUDevice to release
   */
  releaseDevice(device: GPUDevice): void {
    // Check primary
    if (this._primaryDevice && this._primaryDevice.device === device) {
      this._primaryDevice.refCount--;
      if (this._primaryDevice.refCount <= 0) {
        this._primaryDevice.device.destroy();
        this._primaryDevice = null;
      }
      return;
    }

    // Check additional devices
    const idx = this._additionalDevices.findIndex((d) => d.device === device);
    if (idx >= 0) {
      this._additionalDevices[idx].refCount--;
      if (this._additionalDevices[idx].refCount <= 0) {
        this._additionalDevices[idx].device.destroy();
        this._additionalDevices.splice(idx, 1);
      }
    }
  }

  /**
   * Get the number of active device references.
   */
  get activeDeviceCount(): number {
    let count = this._primaryDevice ? 1 : 0;
    count += this._additionalDevices.length;
    return count;
  }

  /**
   * Get the total reference count across all devices.
   */
  get totalRefCount(): number {
    let total = this._primaryDevice?.refCount ?? 0;
    for (const d of this._additionalDevices) {
      total += d.refCount;
    }
    return total;
  }

  /**
   * Check if the primary shared device is available and not lost.
   */
  get hasSharedDevice(): boolean {
    return this._primaryDevice !== null && !this._primaryDevice.isLost;
  }

  /**
   * Get diagnostic info about the device pool.
   */
  getDiagnostics(): {
    primaryDevice: {
      refCount: number;
      features: string[];
      isLost: boolean;
    } | null;
    additionalDevices: number;
    totalRefCount: number;
  } {
    return {
      primaryDevice: this._primaryDevice
        ? {
            refCount: this._primaryDevice.refCount,
            features: Array.from(this._primaryDevice.features),
            isLost: this._primaryDevice.isLost,
          }
        : null,
      additionalDevices: this._additionalDevices.length,
      totalRefCount: this.totalRefCount,
    };
  }

  /**
   * Create a new GPUDevice with the given options.
   * @private
   */
  private async _createNewDevice(
    opts: DeviceAcquisitionOptions,
    isPrimary: boolean,
  ): Promise<{
    device: GPUDevice;
    adapter: GPUAdapter;
    preferredFormat: GPUTextureFormat;
    isShared: boolean;
  }> {
    if (!WebGPUDevicePool.isWebGPUAvailable) {
      throw new Error("WebGPU is not available in this environment.");
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: opts.powerPreference ?? "high-performance",
    });

    if (!adapter) {
      throw new Error("Failed to get GPU adapter.");
    }

    // Auto-detect supported optional features
    const requestedFeatures: GPUFeatureName[] = [];
    const optionalFeatures: GPUFeatureName[] = [
      "float32-filterable" as GPUFeatureName,
      "rg11b10ufloat-renderable" as GPUFeatureName,
      "texture-compression-bc" as GPUFeatureName,
      "texture-compression-etc2" as GPUFeatureName,
      "texture-compression-astc" as GPUFeatureName,
    ];

    // Add explicitly required features
    if (opts.requiredFeatures) {
      for (const f of opts.requiredFeatures) {
        if (adapter.features.has(f)) {
          requestedFeatures.push(f);
        }
      }
    }

    // Probe and add optional features
    for (const f of optionalFeatures) {
      if (adapter.features.has(f) && !requestedFeatures.includes(f)) {
        requestedFeatures.push(f);
      }
    }

    const device = await adapter.requestDevice({
      requiredFeatures: requestedFeatures,
      requiredLimits: opts.requiredLimits,
    });

    const pooled: PooledDevice = {
      device,
      adapter,
      refCount: 1,
      features: device.features,
      isLost: false,
    };

    // Listen for device loss
    device.lost.then((info) => {
      pooled.isLost = true;
      pooled.lostReason = info.message;
      console.error(
        `[CesiumJS:WebGPUDevicePool] Device lost: ${info.reason} — ${info.message}`,
      );
    });

    if (isPrimary) {
      this._primaryDevice = pooled;
    } else {
      this._additionalDevices.push(pooled);
    }

    return {
      device,
      adapter,
      preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
      isShared: false,
    };
  }

  /**
   * Destroy all devices and reset the pool.
   */
  destroyAll(): void {
    if (this._primaryDevice) {
      this._primaryDevice.device.destroy();
      this._primaryDevice = null;
    }
    for (const d of this._additionalDevices) {
      d.device.destroy();
    }
    this._additionalDevices = [];
  }

  /**
   * Reset the singleton (for testing).
   * @private
   */
  static _resetInstance(): void {
    if (WebGPUDevicePool._instance) {
      WebGPUDevicePool._instance.destroyAll();
      WebGPUDevicePool._instance = null;
    }
  }
}

export default WebGPUDevicePool;
