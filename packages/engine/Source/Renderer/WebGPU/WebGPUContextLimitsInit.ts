/**
 * Pure WebGPU device-limit conversion retained as the focused seam used by
 * device-loss tests and compatibility imports. It deliberately does not write
 * the legacy process-global ContextLimits module.
 *
 * @module WebGPUContextLimitsInit
 */

import GraphicsCapabilities, {
  type GraphicsCapabilitiesRecord,
} from "../GraphicsCapabilities.js";

/**
 * Build an immutable capability snapshot from an initialized WebGPU device.
 *
 * @param device - Active device, or null while unavailable/lost.
 * @returns The immutable snapshot, or the immutable empty snapshot.
 */
export function initializeContextLimitsFromDevice(
  device: GPUDevice | null | undefined,
): GraphicsCapabilitiesRecord {
  return device
    ? GraphicsCapabilities.fromWebGPUDevice(device)
    : GraphicsCapabilities.EMPTY;
}

export const createGraphicsCapabilitiesFromDevice =
  initializeContextLimitsFromDevice;
