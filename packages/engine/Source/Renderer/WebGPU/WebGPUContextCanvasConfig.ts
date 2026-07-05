/**
 * Canvas-configuration + HDR-output helpers extracted from
 * `WebGPUContext`.
 *
 * Batch 593 of the audit-recommended Context decomposition
 * (`migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`). Peels the
 * HDR-DISPLAY (Batch 206/213/219/225/230) canvas-config cluster off the
 * ~5.5K-LOC `WebGPUContext.ts` into a self-contained module:
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

import { clearEffectsPlaceholderCacheForDevice } from "./WebGPUEffectsBindGroup.js";

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
 * HDR-DISPLAY (Batch 206) — build the `GPUCanvasConfiguration` based on the
 * current `_hdrCanvasOutput` flag + `_presentationFormat`. Centralizes the
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
 * HDR-DISPLAY (Batch 213, B206-N1 audit fix) — apply the canvas config with
 * a fallback path when the browser rejects HDR-only fields.
 * `toneMapping: { mode: "extended" }` and `colorSpace: "display-p3"` are
 * Chrome 129+ additions; older Chrome / Safari / Firefox builds either throw
 * a TypeError or fail validation. On failure we strip the HDR-only fields and
 * retry with just `format: "rgba16float"` so HDR storage still works. If even
 * the rgba16float fallback fails, we drop back to SDR and fire the fallback
 * listeners so every attached Scene syncs its flag.
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
        // B213-O2 (Batch 219) + B219-N4 (Batch 225) — fan out to every
        // listener so multi-Scene-per-context setups (split-screen,
        // picture-in-picture) all sync.
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
 * HDR-DISPLAY (Batch 206) — when HDR is on we keep the rgba16float format;
 * otherwise re-query the browser's preferred format (typically bgra8unorm on
 * Windows / rgba8unorm on macOS).
 */
export function reconfigureCanvas(host: CanvasConfigHost): void {
  if (host._context && host._device) {
    if (!host._hdrCanvasOutput) {
      host._presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    }
    // Batch 213 (B206-N1 audit fix) — fallback chain for unsupported
    // extended toneMapping.
    applyCanvasConfig(host);
  }
}

/**
 * HDR-DISPLAY (Batch 206) — request an HDR-output canvas. Matches
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
    // Batch 213 (B206-N1 audit fix) — fallback chain. If extended toneMapping
    // fails, `applyCanvasConfig` may flip `_hdrCanvasOutput` back to false;
    // that's the correct behavior — the canvas couldn't honor the request.
    applyCanvasConfig(host);
    // Format-keyed cache invalidation. Identity-blit + canvas-targeted
    // pipelines must recompile against the new format. Effects-bind-group
    // placeholder cache also rebuilds against the new format texture on next
    // access.
    host._webgpuPipelineCache?.clear();
    clearEffectsPlaceholderCacheForDevice(host._device);
  }
}

/**
 * B213-O2 (Batch 219) + B219-N4 (Batch 225) + B225-N2 audit fix (Batch 230) —
 * register a callback fired when the HDR canvas configure fails and the
 * context demotes itself to SDR. `Scene.js` installs this so its
 * `_useHDRCanvasOutput` flag stays in sync with the canvas reality. Returns an
 * unsubscribe function so the Scene can clean up at destruction.
 *
 * Multiple Scenes per Context (split-screen, picture-in-picture) each register
 * their own listener — they all fire on demotion.
 *
 * **B225-N2 (Batch 230 audit fix)** — `null` is no longer a magic
 * "clear all listeners" value. Callers should use the returned unsubscribe
 * function for per-listener cleanup. To clear ALL listeners (e.g., context
 * teardown), call `clearAllHDRFallbackListeners()` explicitly.
 *
 * Returns the unsubscribe function on success, or null when `listener` was
 * nullish.
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
 * B225-N2 (Batch 230 audit fix) — explicit "clear every registered HDR
 * fallback listener" entry point. Used at context teardown. Distinct from
 * `setHDRFallbackListener(null)` so the intent is unambiguous and can't
 * accidentally fire from a Scene that just wanted to remove its own listener.
 */
export function clearAllHDRFallbackListeners(host: CanvasConfigHost): void {
  host._hdrFallbackListeners.clear();
}
