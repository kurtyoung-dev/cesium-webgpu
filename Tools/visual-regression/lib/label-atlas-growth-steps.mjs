// label-atlas-growth-steps.mjs — add labels over several frames until a glyph
// texture atlas grows, and read back what the atlas did.
//
// @purpose The reusable step sequence for a label or billboard cell whose subject is a texture atlas that grows in a later frame: the in-page steps that add each batch on its frame and trace the atlas size every frame, the decision that refuses a run whose atlas did not grow between batches, and the per-half lit-pixel metric the capture is read with.
// @status ACTIVE
//
// WHY A STEP MODULE. `lib/capture.mjs` captures a rig after a settle and has
// no step sequence (adding one is maintainer question MQ-18), and an atlas
// that grows in a LATER frame cannot be set up by a rig's static fields: the
// first batch has to be in the atlas before the second is queued. The steps
// live here, apart from the probe that first used them, so a later label or
// billboard family drives the same sequence from its own rig instead of
// re-writing it.
//
// WHAT THE STEPS DO. `pageRunLabelAtlasGrowth` runs in the page against
// `globalThis.viewer`. It optionally hides the globe, sky, sun and moon over a
// black background, adds one `LabelCollection`, and drives the scene's frames
// through the runtime's frame driver (`driveSceneFrames`, installed in the page
// by `installSceneFrameDriver`), recording the glyph atlas's texture size and
// guid on every frame. A `TextureAtlas` grows in the scene's after-render
// callbacks, which run before `postRender` in the same frame, so each trace row
// is the atlas as that frame left it. Batch `i` is added on the first frame
// whose count reaches its `frame`; the run ends `settleFrames` frames after
// the last batch, or when the driver's frame cap or wall-clock deadline ends
// it first. The driver keeps a request-render-mode page (the CesiumViewer app)
// rendering, which a single `requestRender()` does not.
//
// WHAT IS DECIDED IN NODE. `decideAtlasGrowth` first refuses a run the driver
// ended early (`atlas-steps-did-not-finish`, with the driver's outcome and the
// trace so far), then reads the trace: the atlas size
// on the frame before the last batch was added (every earlier batch's glyphs
// are in it by then) against the size it ended at. An atlas that did not grow
// refuses with `atlas-did-not-resize`, because the cell exists to observe the
// copy a growth makes and a run without one measured nothing.
// `halfLitFractions` reads a decoded capture as two halves, top and bottom,
// with the capture kit's own non-black threshold.

import { NON_BLACK_CHANNEL_THRESHOLD } from "./capture.mjs";
import { ProbeRefusal, SCENE_FRAME_OUTCOMES } from "./probe-runtime.mjs";

/**
 * Add each batch of labels on its frame and trace the glyph atlas. Runs in the
 * page; everything it needs is passed in, because a page function cannot see
 * this module's bindings.
 *
 * @param {object} args Inputs.
 * @param {string} args.moduleUrl The engine module the page serves.
 * @param {boolean} args.hideScene Hide the globe, sky, sun and moon over black.
 * @param {string} args.font The CSS font every label uses.
 * @param {Array<{frame: number, lat: number, text: string}>} args.batches The
 *   batches, in frame order. Each is one label centred on longitude 0.
 * @param {{lon: number, lat: number, height: number, heading?: number,
 *   pitch?: number, roll?: number}|null} args.camera The view to set first.
 * @param {number} args.settleFrames Frames rendered after the last batch.
 * @param {number} args.maxFrames The frame count that ends the run early.
 * @param {number} args.deadlineMs Wall-clock milliseconds the frames may take.
 * @param {string} args.driverGlobal The page global the frame driver is
 *   installed under (`SCENE_FRAME_DRIVER_GLOBAL`).
 * @returns {Promise<{outcome: string, completed: boolean, frames: number,
 *   elapsedMs: number, error?: string, trace: Array<{frame: number,
 *   batchesAdded: number, width: number|null, height: number|null,
 *   guid: string|null}>, batchFrames: number[]}>} How the driven run ended,
 *   and the trace.
 */
export async function pageRunLabelAtlasGrowth({
  moduleUrl,
  hideScene,
  font,
  batches,
  camera,
  settleFrames,
  maxFrames,
  deadlineMs,
  driverGlobal,
}) {
  // __labelAtlasGrowth
  const drive = globalThis[driverGlobal];
  if (typeof drive !== "function") {
    throw new Error(
      `the scene frame driver is not installed as globalThis.${driverGlobal}`,
    );
  }
  const viewer = globalThis.viewer;
  const C = await import(moduleUrl);
  const scene = viewer.scene;
  if (hideScene) {
    scene.globe.show = false;
    for (const key of ["skyBox", "skyAtmosphere", "sun", "moon"]) {
      if (scene[key]) {
        scene[key].show = false;
      }
    }
    scene.backgroundColor = C.Color.BLACK;
  }
  if (camera) {
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      },
    });
  }
  const labels = scene.primitives.add(new C.LabelCollection({ scene }));
  const atlasOf = () => labels._glyphBillboardCollection?._textureAtlas;
  const trace = [];
  const batchFrames = [];
  let added = 0;
  const run = await drive(scene, {
    maxFrames,
    deadlineMs,
    onFrame(frame) {
      const atlas = atlasOf();
      const texture = atlas?._texture;
      trace.push({
        frame,
        batchesAdded: added,
        width: texture ? texture.width : null,
        height: texture ? texture.height : null,
        guid: atlas ? String(atlas.guid) : null,
      });
      if (added < batches.length && frame >= batches[added].frame) {
        const batch = batches[added];
        labels.add({
          position: C.Cartesian3.fromDegrees(0, batch.lat, 0),
          text: batch.text,
          font,
          fillColor: C.Color.WHITE,
          horizontalOrigin: C.HorizontalOrigin.CENTER,
          verticalOrigin: C.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        added += 1;
        batchFrames.push(frame);
        return false;
      }
      return (
        added === batches.length &&
        frame - batchFrames[batchFrames.length - 1] >= settleFrames
      );
    },
  });
  return {
    ...run,
    completed: run.outcome === "done",
    trace,
    batchFrames,
  };
}

/**
 * Whether the glyph atlas grew while every batch but the last was already in
 * it, read from the page's trace.
 *
 * @param {{trace: Array<{frame: number, width: number|null,
 *   height: number|null, guid: string|null}>, batchFrames: number[]}} result
 *   What {@link pageRunLabelAtlasGrowth} returned.
 * @returns {{before: {width: number, height: number, frame: number},
 *   after: {width: number, height: number, frame: number},
 *   resizedOnFrame: number}} The atlas before the last batch, at the end, and
 *   the first frame it was larger.
 * @throws {ProbeRefusal} `atlas-steps-did-not-finish` when the frame driver
 *   ended the run before the last batch settled (its deadline, its frame cap,
 *   or a step error), and `atlas-did-not-resize`.
 */
export function decideAtlasGrowth(result) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const batchFrames = Array.isArray(result?.batchFrames)
    ? result.batchFrames
    : [];
  if (result?.outcome !== SCENE_FRAME_OUTCOMES.DONE) {
    throw new ProbeRefusal(
      "atlas-steps-did-not-finish",
      `the label steps ended with "${result?.outcome ?? "no outcome"}" after ${result?.frames ?? 0} frames in ${result?.elapsedMs ?? 0} ms, before the last batch settled`,
      {
        outcome: result?.outcome ?? null,
        frames: result?.frames ?? null,
        elapsedMs: result?.elapsedMs ?? null,
        error: result?.error ?? null,
        batchFrames,
        lastRow: trace[trace.length - 1] ?? null,
      },
    );
  }
  const lastBatchFrame = batchFrames[batchFrames.length - 1];
  const beforeRow = trace.find((row) => row.frame === lastBatchFrame);
  const afterRow = trace[trace.length - 1];
  const area = (row) =>
    Number.isFinite(row?.width) && Number.isFinite(row?.height)
      ? row.width * row.height
      : 0;
  const grown =
    batchFrames.length >= 2 &&
    area(beforeRow) > 0 &&
    area(afterRow) > area(beforeRow);
  if (!grown) {
    throw new ProbeRefusal(
      "atlas-did-not-resize",
      "the glyph atlas did not grow after the last batch was added, so no copy of the earlier glyphs happened to observe",
      {
        batchFrames,
        before: beforeRow ?? null,
        after: afterRow ?? null,
      },
    );
  }
  const resizedRow = trace.find(
    (row) => row.frame > lastBatchFrame && area(row) > area(beforeRow),
  );
  return {
    before: {
      width: beforeRow.width,
      height: beforeRow.height,
      frame: beforeRow.frame,
    },
    after: {
      width: afterRow.width,
      height: afterRow.height,
      frame: afterRow.frame,
    },
    resizedOnFrame: resizedRow.frame,
  };
}

/**
 * The fraction of lit pixels in the top and bottom halves of a decoded frame.
 * A pixel is lit when any channel exceeds the capture kit's non-black
 * threshold.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 *   A decoded RGBA frame.
 * @param {number} [threshold] The per-channel threshold.
 * @returns {{top: number, bottom: number}} Each half's lit fraction.
 */
export function halfLitFractions(
  image,
  threshold = NON_BLACK_CHANNEL_THRESHOLD,
) {
  const { width, height, data } = image;
  const split = Math.floor(height / 2);
  let top = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        data[i] > threshold ||
        data[i + 1] > threshold ||
        data[i + 2] > threshold
      ) {
        if (y < split) {
          top += 1;
        } else {
          bottom += 1;
        }
      }
    }
  }
  return {
    top: split > 0 ? top / (split * width) : 0,
    bottom: height - split > 0 ? bottom / ((height - split) * width) : 0,
  };
}
