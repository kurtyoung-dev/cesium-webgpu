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
 * ## Channel layout
 *
 * Byte-for-byte the layout upstream's `Scene/SnapFramebuffer.js`
 * `getSnapObjectsFromPixels` reads out of its WebGL2 RGBA32F framebuffer, built
 * from the GLSL expression `PickingPipelineStage.snapIdFromPickId` compiles:
 *
 *     vec4(rgba8UnormToUint32(pickColor), isEdge ? 1.0 : 0.0, -v_positionEC.z, 0.0)
 *
 * | Channel | Contents                                                        |
 * | ------- | --------------------------------------------------------------- |
 * | R       | pick key — uint32 repacked from the RGBA8-normalized pick color, then widened to f32. Keys above 2^24 lose precision, exactly as in the GLSL original (same uint→float cast). |
 * | G       | isEdge flag: 0.0 surface, 1.0 edge.                             |
 * | B       | linear EYE-SPACE depth in meters (`-positionEC.z`). Eye space is global across the multifrustum and independent of the log-depth encoding, so `Snapping.snapHitToWorld` unprojects it directly. |
 * | A       | unused (0.0).                                                   |
 *
 * The B channel is a CAMERA-RELATIVE distance, never an absolute position, so
 * it satisfies the RTE law without a high/low pair: the WGSL writer derives it
 * from `camera.modelViewRelativeToEye * vec4(rte, 1.0)`.
 *
 * @private
 */

import defined from "../../Core/defined.js";

/**
 * The snap payload attachment format — the WebGPU twin of upstream
 * `SnapFramebuffer`'s `PixelFormat.RGBA` + `PixelDatatype.FLOAT` (WebGL2
 * RGBA32F).
 *
 * Fixed, NOT derived from the scene or pick format: every channel is a full f32
 * (a pick key that must survive uint32 repacking, and a depth in meters), and
 * an 8-bit or half-float target would destroy both. `rgba32float` is renderable
 * as a color attachment in core WebGPU with no optional feature, and is
 * deliberately non-blendable and non-filterable — exactly right for a
 * byte-exact ID + depth payload.
 *
 * @private
 */
export const SNAP_PAYLOAD_FORMAT: GPUTextureFormat = "rgba32float";

/** Channels per snap pixel. */
export const SNAP_CHANNELS = 4;

/** Bytes per snap pixel (RGBA32F). */
export const SNAP_BYTES_PER_PIXEL = SNAP_CHANNELS * 4;

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
  /** Pixel offset from the query center, +y up. */
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
 * @param mappedData - The mapped staging buffer viewed as f32.
 * @param bytesPerRow - The aligned row pitch the copy used.
 * @param region - The region {@link SnapReadbackRegion} the copy was issued for.
 * @returns Tightly packed `logicalWidth * logicalHeight * 4` floats.
 *
 * @private
 */
export function unpackSnapPixels(
  mappedData: Float32Array,
  bytesPerRow: number,
  region: SnapReadbackRegion,
): Float32Array {
  const pixels = new Float32Array(
    region.logicalWidth * region.logicalHeight * SNAP_CHANNELS,
  );
  const floatsPerSourceRow = bytesPerRow / 4;
  const copyRowFloats = region.copyWidth * SNAP_CHANNELS;
  for (let row = 0; row < region.copyHeight; row++) {
    const srcOffset = row * floatsPerSourceRow;
    const dstOffset =
      ((region.copyOffsetY + row) * region.logicalWidth + region.copyOffsetX) *
      SNAP_CHANNELS;
    pixels.set(
      mappedData.subarray(srcOffset, srcOffset + copyRowFloats),
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
 * Decode an RGBA32F snap rectangle into hits, walking the SAME outward spiral
 * upstream's `getSnapObjectsFromPixels` walks so both backends visit candidates
 * in the same order.
 *
 * Every pixel whose R channel resolves to a registered pick object becomes a
 * candidate. Edge-over-surface preference and the occlusion tolerance are NOT
 * applied here — `Snapping.selectBestHit` does that arbitration, identically
 * for both backends, from this list.
 *
 * @private
 */
export function decodeSnapHits(
  registry: SnapPickRegistry,
  pixels: Float32Array,
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
      const index = SNAP_CHANNELS * ((halfHeight - y) * width + x + halfWidth);

      const pickColor = pixels[index];
      const object = registry.getObjectByPickColor(pickColor);
      if (defined(object)) {
        results.push({
          object: object,
          isEdge: pixels[index + 1] > 0.0,
          depth: pixels[index + 2],
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
