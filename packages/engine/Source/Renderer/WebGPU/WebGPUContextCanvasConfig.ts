/**
 * Canvas-configuration + HDR-output helpers extracted from
 * `WebGPUContext`.
 *
 * Holds the HDR canvas-config cluster as a self-contained module rather than
 * inside the much larger `WebGPUContext.ts`:
 *
 *   - `buildCanvasConfig(host)` — assemble the `GPUCanvasConfiguration`
 *     for the current `_hdrCanvasOutput` flag + `_presentationFormat`.
 *   - `applyCanvasConfig(host)` — configure the canvas with the
 *     browser-compat fallback chain (extended toneMapping → rgba16float →
 *     SDR), firing the HDR-fallback listeners on demotion.
 *   - `reconfigureCanvas(host)` — device-loss-recovery re-configure entry.
 *   - `setHDRCanvasOutput(host, enabled)` — toggle HDR output + invalidate
 *     the format-keyed pipeline / effects-placeholder caches.
 *   - `setHDRFallbackListener(host, listener)` /
 *     `clearAllHDRFallbackListeners(host)` — the fallback-listener registry.
 *
 * The extraction is behavior-preserving: the `WebGPUContext` methods of
 * the same names become one-line delegators; the moved bodies are
 * byte-for-byte equivalent (identical branches, identical debug pragmas,
 * identical fallback ordering). No default-scene behavior changes — HDR
 * output is opt-in (`_hdrCanvasOutput` defaults false), so the SDR path
 * through `buildCanvasConfig` is byte-identical to before.
 *
 * @module WebGPUContextCanvasConfig
 */

/**
 * The `WebGPUContext` surface the canvas-config helpers reach into.
 * `_hdrCanvasOutput` / `_presentationFormat` are read+write (the fallback
 * chain demotes them); the rest are read plus method calls. All fields use
 * the public-underscore convention already established on `WebGPUContext`.
 */
export interface CanvasConfigHost {
  _context: GPUCanvasContext | null;
  _device: GPUDevice | null;
  _isDestroyed: boolean;
  _hdrCanvasOutput: boolean;
  _presentationFormat: GPUTextureFormat;
  readonly _hdrFallbackListeners: Set<(newValue: boolean) => void>;
  readonly _webgpuPipelineCache: { clear(): void } | null;
  log(level: "info" | "warn" | "error", message: string): void;
}

/**
 * Build the `GPUCanvasConfiguration` from the current `_hdrCanvasOutput` flag
 * and `_presentationFormat`. Centralizes the
 * configure body so the three call sites (initialize, resize,
 * reconfigureCanvas) stay consistent.
 *
 * When HDR is on:
 *   - format: `rgba16float` (stores the full HDR range)
 *   - colorSpace: `display-p3` (wide-gamut color space)
 *   - toneMapping: `{ mode: "extended" }` (HDR values >1.0 are intentional;
 *     gated by browser support — silently ignored where unrecognized)
 */
export function buildCanvasConfig(
  host: CanvasConfigHost,
): GPUCanvasConfiguration {
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  if (host._hdrCanvasOutput) {
    return {
      device: host._device!,
      format: "rgba16float",
      alphaMode: "opaque",
      usage,
      colorSpace: "display-p3",
      toneMapping: { mode: "extended" },
    } as GPUCanvasConfiguration;
  }
  return {
    device: host._device!,
    format: host._presentationFormat,
    alphaMode: "opaque",
    usage,
  };
}

/**
 * Apply the canvas config with a fallback path for a browser that rejects the
 * HDR-only fields. `toneMapping: { mode: "extended" }` and
 * `colorSpace: "display-p3"` are Chrome 129+ additions; older Chrome, Safari
 * and Firefox builds either throw a TypeError or fail validation. On failure
 * the HDR-only fields are stripped and the configure retried with just
 * `format: "rgba16float"`, so HDR storage still works. If that fallback also
 * fails, the canvas drops back to SDR and the fallback listeners fire so every
 * attached Scene syncs its flag.
 */
export function applyCanvasConfig(host: CanvasConfigHost): void {
  if (!host._context || !host._device) {
    return;
  }
  const cfg = buildCanvasConfig(host);
  try {
    host._context.configure(cfg);
  } catch (e) {
    if (host._hdrCanvasOutput) {
      //>>includeStart('debug', pragmas.debug);
      host.log(
        "warn",
        `HDR canvas configure failed (browser may not support extended toneMapping); retrying with rgba16float-only: ${(e as Error).message}`,
      );
      //>>includeEnd('debug');
      try {
        host._context.configure({
          device: host._device,
          format: "rgba16float",
          alphaMode: "opaque",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        return;
      } catch (e2) {
        //>>includeStart('debug', pragmas.debug);
        host.log(
          "warn",
          `HDR rgba16float fallback also failed; dropping to SDR: ${(e2 as Error).message}`,
        );
        //>>includeEnd('debug');
        host._hdrCanvasOutput = false;
        host._presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        host._context.configure(buildCanvasConfig(host));
        // Fan out to every listener so a multi-Scene-per-context setup —
        // split-screen, picture-in-picture — syncs all of them.
        for (const listener of host._hdrFallbackListeners) {
          try {
            listener(false);
          } catch (e3) {
            //>>includeStart('debug', pragmas.debug);
            host.log(
              "warn",
              `HDR fallback listener threw: ${(e3 as Error).message}`,
            );
            //>>includeEnd('debug');
          }
        }
        return;
      }
    }
    throw e;
  }
}

/**
 * Re-configure the canvas context after device-loss recovery. Called by
 * `WebGPUDeviceLossRecovery` via the `DeviceLossRecoveryHost` interface.
 *
 * With HDR on the format stays `rgba16float`; otherwise the browser's
 * preferred format is re-queried, typically `bgra8unorm` on Windows and
 * `rgba8unorm` on macOS.
 */
export function reconfigureCanvas(host: CanvasConfigHost): void {
  if (host._context && host._device) {
    if (!host._hdrCanvasOutput) {
      host._presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    }
    // Routed through the fallback chain for unsupported extended toneMapping.
    applyCanvasConfig(host);
  }
}

/**
 * Request an HDR-output canvas. Matches
 * `Scene.useHDRCanvasOutput` and is invoked by the Scene setter.
 *
 * Switching the canvas format invalidates every pipeline that targets the
 * canvas format (identity-blit, debug overlays, anything using
 * `presentationFormat`). The pipeline cache is cleared so subsequent
 * `getOrCreatePipeline` calls rebuild against the new format on demand.
 *
 * No-ops if the flag is unchanged or the context is uninitialized.
 */
export function setHDRCanvasOutput(
  host: CanvasConfigHost,
  enabled: boolean,
): void {
  if (host._hdrCanvasOutput === enabled) {
    return;
  }
  host._hdrCanvasOutput = enabled;
  host._presentationFormat = enabled
    ? "rgba16float"
    : navigator.gpu.getPreferredCanvasFormat();
  if (host._context && host._device && !host._isDestroyed) {
    // If extended toneMapping fails, `applyCanvasConfig` flips
    // `_hdrCanvasOutput` back to false, which is correct: the canvas could not
    // honour the request.
    applyCanvasConfig(host);
    // Format-keyed cache invalidation. Identity-blit + canvas-targeted
    // pipelines must recompile against the new format. Effects bind groups
    // contain no presentation-format resources and are physical-device scoped,
    // so one context must not invalidate them for other pooled contexts.
    host._webgpuPipelineCache?.clear();
  }
}

/**
 * Register a callback fired when the HDR canvas configure fails and the
 * context demotes itself to SDR. `Scene.js` installs one so its
 * `_useHDRCanvasOutput` flag stays in sync with the canvas reality, and the
 * returned unsubscribe function lets it clean up at destruction.
 *
 * Several Scenes can share one Context — split-screen, picture-in-picture —
 * and each registers its own listener; all of them fire on demotion.
 *
 * `null` is not a "clear all listeners" value: per-listener cleanup goes
 * through the returned unsubscribe function, and clearing all listeners, as at
 * context teardown, goes through `clearAllHDRFallbackListeners()`.
 *
 * @param {object} host The canvas-config host.
 * @param {Function|null} listener Called with the new HDR state on demotion.
 * @returns {Function|null} The unsubscribe function, or null when `listener`
 *   was nullish.
 */
export function setHDRFallbackListener(
  host: CanvasConfigHost,
  listener: ((newValue: boolean) => void) | null,
): (() => void) | null {
  if (!listener) {
    return null;
  }
  host._hdrFallbackListeners.add(listener);
  return () => {
    host._hdrFallbackListeners.delete(listener);
  };
}

/**
 * Clear every registered HDR fallback listener. Used at context teardown, and
 * kept distinct from `setHDRFallbackListener(null)` so a Scene removing only
 * its own listener cannot trigger it by accident.
 */
export function clearAllHDRFallbackListeners(host: CanvasConfigHost): void {
  host._hdrFallbackListeners.clear();
}
