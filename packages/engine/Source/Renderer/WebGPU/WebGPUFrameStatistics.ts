/**
 * Frame-statistics helpers extracted from `WebGPUContext`.
 *
 * Part of the audit-recommended Context decomposition.
 * Trio of small, related functions:
 *
 *   - `getFrameStatistics(host)` — assembles a `WebGPUFrameStatistics`
 *     snapshot from the Context's per-frame counters + cache sizes.
 *     The Context's `getStatistics()` becomes a 1-line delegator.
 *   - `resetFrameStatistics(host)` — zeros frameCount + drawCallCount
 *     + triangleCount. Reads/writes the same three counters via the
 *     host.
 *   - `recordDrawCall(host, triangles)` — bumps drawCallCount by 1
 *     and triangleCount by `triangles`. The Context's
 *     `recordDrawCall()` becomes a 1-line delegator.
 *
 * `frameCount` is owned by the Context (it's bumped in
 * `beginFrame()` and read across the renderer module), so this
 * helper reads but does not write that field — the Context's
 * `resetFrameStatistics` zeroes it as part of the per-statistics
 * reset, but the Context still owns the canonical state.
 *
 * @module WebGPUFrameStatistics
 */

/** Return type for `getFrameStatistics`. */
export interface WebGPUFrameStatistics {
  frameCount: number;
  drawCallCount: number;
  triangleCount: number;
  samplerCacheSize: number;
  bindGroupLayoutCacheSize: number;
  uniformBufferPoolSize: number;
}

/**
 * The Context surface the frame-statistics helpers reach into.
 * Counters are read+write; cache slots are read-only (we only need
 * their `.size` / `.length`).
 */
export interface FrameStatisticsHost {
  _frameCount: number;
  _drawCallCount: number;
  _triangleCount: number;
  readonly _samplerCache: { readonly size: number };
  readonly _bindGroupLayoutCache: { readonly size: number };
  readonly _uniformBufferPool: { readonly length: number };
}

/** Snapshot the host's per-frame counters + cache sizes. */
export function getFrameStatistics(
  host: FrameStatisticsHost,
): WebGPUFrameStatistics {
  return {
    frameCount: host._frameCount,
    drawCallCount: host._drawCallCount,
    triangleCount: host._triangleCount,
    samplerCacheSize: host._samplerCache.size,
    bindGroupLayoutCacheSize: host._bindGroupLayoutCache.size,
    uniformBufferPoolSize: host._uniformBufferPool.length,
  };
}

/** Zero the three counters owned by the host. */
export function resetFrameStatistics(host: FrameStatisticsHost): void {
  host._frameCount = 0;
  host._drawCallCount = 0;
  host._triangleCount = 0;
}

/**
 * Increment the host's draw-call counter and add `triangles` to the
 * triangle counter. Defaults to 0 triangles for callers that don't
 * track geometry counts.
 */
export function recordDrawCall(
  host: FrameStatisticsHost,
  triangles: number = 0,
): void {
  host._drawCallCount++;
  host._triangleCount += triangles;
}
