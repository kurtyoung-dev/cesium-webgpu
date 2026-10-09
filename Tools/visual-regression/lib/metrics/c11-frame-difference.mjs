// c11-frame-difference.mjs — "do these two frames visibly differ", as a count
// of changed pixels over the kit's one pixel diff; a size mismatch throws
// unless the caller opts in to a not-comparable record.
// @purpose Pure two-frame difference over decoded RGB/RGBA byte frames: changed-pixel count (any channel delta at or above a bar, counted by lib/image-diff.mjs diffImages) and mean absolute channel delta; a size or channel mismatch throws, or returns comparable:false to a caller that opts in.
// @status ACTIVE
//
// WHERE THIS CAME FROM. `lib/c11-90-primitive-restart-probe.mjs` carried
// `imageDifference`, a private per-channel diff that proves the strip and fan
// topologies draw different frames ("visibly distinguishes strips from fans":
// `comparable && changedPixels >= 1000`). The probe-kit harvest
// (PROBE_KIT_PLAN_2026-09-17.md §4, DX-108) routes the changed-pixel count
// through `diffImages` (`lib/image-diff.mjs`), which does not return a mean
// delta, and keeps here the mean absolute channel delta the C11-90 receipt
// reports, plus an opt-in non-throwing size guard.
//
// WHY NOT `diffPixels`. `Tools/lib/png-decode.mjs` `diffPixels` does return a
// `meanAbsDelta` and a `{comparable: false}` record, but it is not this job:
// it reads RGBA frames only, its mismatch record does not throw (so a caller
// that forgets to read `comparable` passes), and its mean is not bit-equal to
// the pre-harvest `imageDifference` the C11-90 receipt was written with (a
// last-bit float difference in 378 of 400 random RGB pairs, measured by the
// reviewer). The integer sum below reproduces the receipt exactly.
//
// THE BAR, TRANSLATED. C11-90 counts a pixel as changed when its largest RGB
// channel delta is AT LEAST 12; `diffImages` counts it when a channel delta
// EXCEEDS its tolerance. On 0-255 integer bytes those are the same test with
// `tolerance = changedChannelDelta - 1`, which is what this module passes.
// Both readings ignore alpha.
//
// A SIZE MISMATCH NEVER PASSES. By default a width, height or channel-count
// mismatch THROWS a RangeError naming both shapes, as `diffImages` does: a
// returned count cannot fail every check a caller might write ("at least 1,000
// pixels changed" and "no pixel changed" pass on opposite values), so the only
// answer that fails every check is no answer. A caller whose check already
// reads `comparable` first may opt in with `onSizeMismatch: "not-comparable"`
// and receive `{comparable: false, changedPixels: 0, meanAbsoluteDelta: 0}`,
// the record the C11-90 harness has always written into its receipt and which
// its strips-versus-fans check (`comparable && changedPixels >= 1000`) fails.
// The C11-90 harness is the one caller that opts in, and the spec pins both
// paths.

import { diffImages } from "../image-diff.mjs";

/** The C11-90 bar: a pixel changed when some RGB channel moved by at least this. */
export const FRAME_DIFFERENCE_DEFAULTS = Object.freeze({
  changedChannelDelta: 12,
});

function frameShape(image, label) {
  if (image === null || typeof image !== "object") {
    throw new TypeError(`${label}: frame must be an object`);
  }
  const { width, height, data } = image;
  const channels = image.channels ?? 4;
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`${label}: width must be a positive integer`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError(`${label}: height must be a positive integer`);
  }
  if (channels !== 3 && channels !== 4) {
    throw new TypeError(`${label}: channels must be 3 or 4, got ${channels}`);
  }
  if (data?.length !== width * height * channels) {
    throw new TypeError(
      `${label}: ${width}x${height}x${channels} needs ${width * height * channels} bytes, got ${data?.length}`,
    );
  }
  return { width, height, channels, data };
}

function asRgba({ width, height, channels, data }) {
  if (channels === 4) {
    return { width, height, data };
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0, source = 0; pixel < width * height; pixel += 1) {
    const target = pixel * 4;
    rgba[target] = data[source];
    rgba[target + 1] = data[source + 1];
    rgba[target + 2] = data[source + 2];
    rgba[target + 3] = 255;
    source += 3;
  }
  return { width, height, data: rgba };
}

/**
 * How far apart two frames are.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>, channels?: 3|4}} first
 * @param {{width: number, height: number, data: ArrayLike<number>, channels?: 3|4}} second
 * @param {{changedChannelDelta?: number, onSizeMismatch?: "throw"|"not-comparable"}} [options]
 *   `onSizeMismatch` (default `"throw"`) says what a width, height or
 *   channel-count mismatch does; see the module header.
 * @returns {{comparable: boolean, changedPixels: number, meanAbsoluteDelta: number}}
 *   `meanAbsoluteDelta` averages |delta| over the R, G and B channels of every
 *   pixel. With `onSizeMismatch: "not-comparable"`, a mismatch returns zeros
 *   with `comparable: false`.
 * @throws {RangeError} On a mismatch, unless the caller opted in to
 *   `onSizeMismatch: "not-comparable"`.
 */
export function frameDifference(first, second, options = {}) {
  const onSizeMismatch = options.onSizeMismatch ?? "throw";
  if (onSizeMismatch !== "throw" && onSizeMismatch !== "not-comparable") {
    throw new TypeError(
      `frameDifference: options.onSizeMismatch must be "throw" or "not-comparable", got ${String(onSizeMismatch)}`,
    );
  }
  const a = frameShape(first, "frameDifference(first)");
  const b = frameShape(second, "frameDifference(second)");
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.channels !== b.channels
  ) {
    if (onSizeMismatch === "throw") {
      throw new RangeError(
        `frameDifference: the two frames are not the same shape — ` +
          `${a.width}x${a.height}x${a.channels} vs ${b.width}x${b.height}x${b.channels}`,
      );
    }
    return { comparable: false, changedPixels: 0, meanAbsoluteDelta: 0 };
  }
  const changedChannelDelta =
    options.changedChannelDelta ??
    FRAME_DIFFERENCE_DEFAULTS.changedChannelDelta;
  const { changedPx } = diffImages(asRgba(a), asRgba(b), {
    tolerance: changedChannelDelta - 1,
  });
  let absoluteDelta = 0;
  for (let offset = 0; offset < a.data.length; offset += a.channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      absoluteDelta += Math.abs(
        a.data[offset + channel] - b.data[offset + channel],
      );
    }
  }
  return {
    comparable: true,
    changedPixels: changedPx,
    meanAbsoluteDelta: absoluteDelta / (a.width * a.height * 3),
  };
}
