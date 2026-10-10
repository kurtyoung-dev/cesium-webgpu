/**
 * A debug-build receipt of which texture-upload and framebuffer-copy branches
 * the WebGL compatibility stub actually took, for a probe to read back.
 *
 * Every call to {@link recordStubTextureTrace} sits inside a
 * `//>>includeStart('debug', pragmas.debug)` block, so a release build carries
 * neither the calls nor, once they are gone, this module. In a debug build the
 * recorder does nothing until a page arms it by creating the global object
 * named {@link STUB_TEXTURE_TRACE_GLOBAL} (a probe does so before any engine
 * code runs); unarmed, a call costs one property read.
 *
 * The receipt counts each event and keeps the first few details of each, so a
 * branch taken every frame (a video upload) cannot grow it without bound.
 *
 * @module WebGLStubTextureTrace
 */

/** The page global a probe creates to arm the receipt. */
export const STUB_TEXTURE_TRACE_GLOBAL = "__cesiumStubTextureTrace";

/** How many details are kept per event. */
const SAMPLES_PER_EVENT = 4;

/** The armed receipt's shape. */
export interface StubTextureTrace {
  counts: Record<string, number>;
  samples: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Count one event and keep its detail while fewer than the cap are kept.
 *
 * @param event The branch taken, as `<entry point>.<outcome>`.
 * @param detail What the branch saw: sizes, flags, labels.
 */
export function recordStubTextureTrace(
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const trace = (globalThis as Record<string, unknown>)[
    STUB_TEXTURE_TRACE_GLOBAL
  ] as Partial<StubTextureTrace> | undefined;
  if (!trace || typeof trace !== "object") {
    return;
  }
  const counts = (trace.counts ??= {});
  const samples = (trace.samples ??= {});
  counts[event] = (counts[event] ?? 0) + 1;
  const kept = (samples[event] ??= []);
  if (kept.length < SAMPLES_PER_EVENT) {
    kept.push(detail);
  }
}

/**
 * A GPU texture's size and label for a receipt detail, or null.
 *
 * @param texture The texture, if any.
 * @returns Its label, width, height and format.
 */
export function describeTraceTexture(
  texture: GPUTexture | null | undefined,
): Record<string, unknown> | null {
  if (!texture) {
    return null;
  }
  return {
    label: texture.label,
    width: texture.width,
    height: texture.height,
    format: texture.format,
  };
}
