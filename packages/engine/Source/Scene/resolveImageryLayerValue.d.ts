/**
 * Resolves an imagery-layer property documented as a scalar or a per-tile
 * callback. Shared by the WebGL and WebGPU uniform packs.
 */
export default function resolveImageryLayerValue(
  value: unknown,
  defaultValue: number,
  frameState: { context: object; frameNumber: number },
  layer: unknown,
  tile?: { level: number; x: number; y: number },
): number;
