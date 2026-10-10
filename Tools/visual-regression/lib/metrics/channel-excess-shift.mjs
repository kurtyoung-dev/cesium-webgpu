// channel-excess-shift.mjs — did one channel gain on the other two between two frames?
// @purpose Pure RGBA metric: the mean change, between a before and an after frame, of one channel's excess over the mean of the other two, over pixels lit in both frames — a hue-shift signal that tile refinement noise does not produce.
// @status ACTIVE
//
// WHERE IT CAME FROM. `probe-globe-default-limits` adds `GridImageryProvider`
// layers until the imagery overflows the reduced four-slot layout, which forces
// a second blend pass. The grid provider's default background is
// `rgba(0, 0.5, 0, 0.2)`, a 20 % green wash over every covered fragment, so the
// mean green excess `g - (r + b) / 2` rises only if the second pass actually
// composited. A raw changed-pixel count cannot tell that apart from tile
// refinement between the two snaps; a hue excess can, because refinement does
// not shift hue systematically. The probe measured ~3.8 on a compositing second
// pass and ~0 on a skipped one, and gates at > 2 (its own header).
//
// The loop is the one the probe carried inside `page.evaluate`, moved to Node
// and generalised only in WHICH channel is read (the probe reads green, and
// green stays the default). `metrics-globe-extraction.spec.mjs` holds the green
// case to the original source. The changed-pixel fraction the probe printed
// beside it is `diffImages` (`lib/image-diff.mjs`) at tolerance 24, not part of
// this module.

const CHANNEL_INDEX = Object.freeze({ red: 0, green: 1, blue: 2 });

/**
 * @param {{width: number, height: number, data: ArrayLike<number>}} before
 * @param {{width: number, height: number, data: ArrayLike<number>}} after
 * @param {{channel?: "red"|"green"|"blue", litFloor?: number}} [options]
 *   `channel` defaults to green. A pixel counts when its channel sum exceeds
 *   `litFloor` (default 48, strictly greater) in BOTH frames.
 * @returns {{shift: number, litPx: number}} `shift` is the mean over counted
 *   pixels of `excess(after) - excess(before)`, and 0 when none counted.
 * @throws {RangeError} When the two frames differ in size: pixel i of one is
 *   not pixel i of the other, so no shift between them means anything.
 */
export function channelExcessShift(before, after, options = {}) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new RangeError(
      `channelExcessShift: size mismatch ${before.width}x${before.height} vs ${after.width}x${after.height}`,
    );
  }
  const channel = options.channel ?? "green";
  const c = CHANNEL_INDEX[channel];
  if (c === undefined) {
    throw new RangeError(
      `channelExcessShift: channel must be one of ${Object.keys(CHANNEL_INDEX).join(", ")}, got ${String(channel)}`,
    );
  }
  const litFloor = options.litFloor ?? 48;
  // The two channels the excess is measured against, in the order the original
  // summed them for green: red first, then blue.
  const o1 = c === 0 ? 1 : 0;
  const o2 = c === 2 ? 1 : 2;
  const a = before.data;
  const b = after.data;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    const r1 = a[i],
      g1 = a[i + 1],
      b1 = a[i + 2];
    const r2 = b[i],
      g2 = b[i + 1],
      b2 = b[i + 2];
    if (r1 + g1 + b1 > litFloor && r2 + g2 + b2 > litFloor) {
      sum +=
        b[i + c] -
        (b[i + o1] + b[i + o2]) / 2 -
        (a[i + c] - (a[i + o1] + a[i + o2]) / 2);
      count++;
    }
  }
  return { shift: count > 0 ? sum / count : 0, litPx: count };
}
