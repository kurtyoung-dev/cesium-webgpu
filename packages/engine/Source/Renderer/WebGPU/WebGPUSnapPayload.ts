/// <reference types="@webgpu/types" />
/**
 * WebGPU snap-payload encoding — the single source of truth shared by the
 * shader-side WRITER, the attachment, and the readback-side READER.
 *
 * UP144-SNAP-WEBGPU (Campaign 11 row C11-212). Three modules have to agree on
 * this encoding exactly, and they live far apart:
 *
 *   - `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — `fragmentSnapMain` WRITES
 *     the payload.
 *   - `WebGPUModelPipelineCache.ts` — stamps {@link SNAP_PAYLOAD_FORMAT} as the
 *     snap pipeline's color target. WebGPU validates a pipeline's attachment
 *     state against the render pass at DRAW time, so a format drift here does
 *     not fail loudly at creation; it invalidates the whole snap command buffer
 *     at the first draw (the FORK-34 failure mode).
 *   - `WebGPUSnapFramebuffer.ts` — allocates the attachment and READS it back.
 *
 * Keeping the format constant and the two pure decode functions here (with no
 * GPU, shader, or Cesium-class dependencies) gives that agreement one
 * enforceable home and lets `Tools/visual-regression/webgpu-snap-payload.spec.mjs`
 * pin the encoding in plain Node, without a device.
 *
 * ## Word layout
 *
 * The decoded hit is shape-identical to the layout upstream's
 * `Scene/SnapFramebuffer.js` reads out of its WebGL2 RGBA32F framebuffer. The
 * WebGPU transport is deliberately denser and exact:
 *
 *     vec4(rgba8UnormToUint32(pickColor), isEdge ? 1.0 : 0.0, -v_positionEC.z, 0.0)
 *
 * | Word | Contents                                                           |
 * | ---- | ------------------------------------------------------------------ |
 * | R    | Exact uint32 pick key repacked from the RGBA8-normalized pick color. |
 * | G    | Bits 0..30: positive linear eye-space depth as IEEE-754 f32 bits. Bit 31: isEdge. |
 *
 * The decoded depth is a CAMERA-RELATIVE distance, never an absolute position, so
 * it satisfies the RTE law without a high/low pair: the WGSL writer derives it
 * from `camera.modelViewRelativeToEye * vec4(rte, 1.0)`. Visible fragments are
 * in front of the camera, so their positive depth has a clear IEEE sign bit;
 * that otherwise-unused bit carries the edge flag without changing depth.
 *
 * @private
 */

import defined from "../../Core/defined.js";

/**
 * The snap payload attachment format. WebGL retains upstream RGBA32F; WebGPU
 * uses two exact 32-bit unsigned words and converts them back to the same
 * renderer-neutral hit object during readback.
 *
 * `rg32uint` is a core renderable, non-blendable integer format and requires no
 * optional feature. It preserves all 32 pick-key bits (unlike uint-to-f32,
 * which loses keys above 2^24) and the full positive f32 eye-depth bit pattern
 * while halving payload attachment and readback bytes.
 *
 * @private
 */
export const SNAP_PAYLOAD_FORMAT: GPUTextureFormat = "rg32uint";

/** Uint32 words per snap pixel. */
export const SNAP_CHANNELS = 2;

/** Bytes per snap pixel (RG32Uint). */
export const SNAP_BYTES_PER_PIXEL = SNAP_CHANNELS * 4;

/** Bit reserved for the edge flag in the packed depth word. */
export const SNAP_EDGE_BIT = 0x80000000;

/** Bits carrying the positive f32 eye-depth payload. */
export const SNAP_DEPTH_BITS = 0x7fffffff;

// Reused scalar bit-cast storage. Decode is synchronous; the resolved scalar
// is copied out before the pick registry is consulted, so even a re-entrant
// registry callback cannot corrupt an in-progress result.
const snapScalarBits = new ArrayBuffer(4);
const snapScalarFloat = new Float32Array(snapScalarBits);
const snapScalarUint = new Uint32Array(snapScalarBits);

/** Pack a positive eye-space f32 depth and edge flag into the second word. */
export function packSnapDepthAndEdge(depth: number, isEdge: boolean): number {
  snapScalarFloat[0] = depth;
  return (
    ((snapScalarUint[0] & SNAP_DEPTH_BITS) | (isEdge ? SNAP_EDGE_BIT : 0)) >>> 0
  );
}

/** Decode the full f32 eye-space depth from the second payload word. */
export function unpackSnapDepth(word: number): number {
  snapScalarUint[0] = word & SNAP_DEPTH_BITS;
  return snapScalarFloat[0];
}

/** Decode the edge flag from the second payload word. */
export function unpackSnapIsEdge(word: number): boolean {
  return (word & SNAP_EDGE_BIT) !== 0;
}

/** WebGPU's minimum `bytesPerRow` alignment for a texture-to-buffer copy. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * A single decoded snap candidate. Shape-identical to the objects upstream's
 * `getSnapObjectsFromPixels` pushes, so `Snapping.selectBestHit` and
 * `Snapping.snapHitToWorld` consume both backends' hits unchanged.
 *
 * @private
 */
export interface WebGPUSnapHit {
  /** The primitive or feature the pick key resolved to. */
  object: object;
  /** True when the fragment was written by an edge-pass draw. */
  isEdge: boolean;
  /** Linear eye-space depth in meters. */
  depth: number;
  /** Pixel offset from the query center, +x right. */
  x: number;
  /** Pixel offset from the query center, +y down (CSS/window convention). */
  y: number;
}

/**
 * The logical + clipped copy geometry of one snap readback.
 *
 * The LOGICAL rectangle is the caller's query, kept unshifted even when it runs
 * off a canvas edge so the cursor stays at the center of the decode spiral. The
 * COPY rectangle is the part that actually exists in the attachment; the
 * difference is zero-filled, which decodes as pick key 0 — the "no object" key,
 * since pick ids start at 1.
 *
 * @private
 */
export interface SnapReadbackRegion {
  logicalOriginX: number;
  logicalOriginTopY: number;
  logicalWidth: number;
  logicalHeight: number;
  copyOriginX: number;
  copyOriginTopY: number;
  copyWidth: number;
  copyHeight: number;
  copyOffsetX: number;
  copyOffsetY: number;
  attachmentGeneration: number;
}

/**
 * Round a row byte count up to WebGPU's `copyTextureToBuffer` alignment.
 *
 * @private
 */
export function alignedSnapBytesPerRow(copyWidth: number): number {
  return (
    Math.ceil(
      (copyWidth * SNAP_BYTES_PER_PIXEL) / COPY_BYTES_PER_ROW_ALIGNMENT,
    ) * COPY_BYTES_PER_ROW_ALIGNMENT
  );
}

/**
 * Expand a clipped, row-padded GPU copy back into the caller's logical snap
 * rectangle, stripping the 256-byte row padding. Pixels outside the attachment
 * stay zero.
 *
 * @param mappedData - The mapped staging buffer viewed as uint32 words.
 * @param bytesPerRow - The aligned row pitch the copy used.
 * @param region - The region {@link SnapReadbackRegion} the copy was issued for.
 * @returns Tightly packed `logicalWidth * logicalHeight * 2` uint32 words.
 *
 * @private
 */
export function unpackSnapPixels(
  mappedData: Uint32Array,
  bytesPerRow: number,
  region: SnapReadbackRegion,
): Uint32Array {
  const pixels = new Uint32Array(
    region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
  );
  const wordsPerSourceRow = bytesPerRow / 4;
  const copyRowWords = region.copyWidth * SNAP_CHANNELS;
  for (let row = 0; row < region.copyHeight; row++) {
    const srcOffset = row * wordsPerSourceRow;
    const dstOffset =
      ((region.copyOffsetY + row) * region.logicalWidth + region.copyOffsetX) *
      SNAP_CHANNELS;
    pixels.set(
      mappedData.subarray(srcOffset, srcOffset + copyRowWords),
      dstOffset,
    );
  }
  return pixels;
}

/**
 * The minimal context surface {@link decodeSnapHits} needs. Narrow on purpose:
 * the decode is a pure function of the payload plus the pick registry, so a
 * spec can drive it with a two-line stub.
 *
 * @private
 */
export interface SnapPickRegistry {
  getObjectByPickColor(color: number): object | undefined;
}

/**
 * Decode an RG32Uint snap rectangle into hits, walking the SAME outward spiral
 * upstream's `getSnapObjectsFromPixels` walks so both backends visit candidates
 * in the same order.
 *
 * Every pixel whose R word resolves to a registered pick object becomes a
 * candidate. Edge-over-surface preference and the occlusion tolerance are NOT
 * applied here — `Snapping.selectBestHit` does that arbitration, identically
 * for both backends, from this list.
 *
 * @private
 */
export function decodeSnapHits(
  registry: SnapPickRegistry,
  pixels: Uint32Array,
  width: number,
  height: number,
): WebGPUSnapHit[] {
  const max = Math.max(width, height);
  const length = max * max;
  const halfWidth = Math.floor(width * 0.5);
  const halfHeight = Math.floor(height * 0.5);

  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;

  const results: WebGPUSnapHit[] = [];
  for (let i = 0; i < length; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      // A WebGPU texture-to-buffer copy is top-to-bottom. Preserve upstream's
      // public/window-space hit convention (+y down) by mapping negative
      // spiral y to the top rows. WebGL's readPixels array is bottom-to-top and
      // therefore uses `halfHeight - y` for the same logical convention.
      const index = SNAP_CHANNELS * ((halfHeight + y) * width + x + halfWidth);

      const pickColor = pixels[index];
      const depthAndEdge = pixels[index + 1];
      const depth = unpackSnapDepth(depthAndEdge);
      const isEdge = unpackSnapIsEdge(depthAndEdge);
      const object = registry.getObjectByPickColor(pickColor);
      if (defined(object)) {
        results.push({
          object: object,
          isEdge: isEdge,
          depth: depth,
          x: x,
          y: y,
        });
      }
    }

    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      const temp = dx;
      dx = -dy;
      dy = temp;
    }

    x += dx;
    y += dy;
  }

  return results;
}
