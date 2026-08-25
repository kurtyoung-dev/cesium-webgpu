/**
 * Orchestrates WebGPU pick and snap command passes across frustum slices.
 *
 * Frustum slices execute far to near. Pick ID color loads between slices,
 * while depth and stencil clear because independently projected slice depths
 * are not comparable. Commands route through `selectCommandVariant` so only
 * the applicable pick command reaches the pass.
 *
 * A `WebGPUSnapFramebuffer` adds an occluder phase followed by an integer
 * payload phase over the same slice depth. Framebuffer allocation and result
 * decoding remain outside this module.
 *
 * @module WebGPUSceneRendererPickPass
 */

import DeveloperError from "../../Core/DeveloperError.js";
import Pass from "../../Renderer/Pass.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUDynamicStateOverride } from "./WebGPUDrawCommand.js";
import {
  publishCurrentFrustumState,
  publishLogDepthEncodeNearFar,
} from "./WebGPUSceneRendererFrustumState.js";
import {
  selectCommandVariant,
  sortCommandsBackToFront,
  sortCommandsFrontToBack,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * Enables the horizon depth-plane draw that occludes pick fragments behind
 * the visible terrain limb.
 *
 * Every producer sharing the pick depth attachment must use a comparable
 * depth encoding and range. The plane uses the frame-stable full-camera pair;
 * mixing logarithmic and hyperbolic depth makes its comparisons incoherent
 * and can over-occlude visible fragments.
 *
 * Setting this constant to `false` disables only the plane draw.
 * `WebGPUContext._pickLogDepthWriteEnabled` separately controls native pick
 * producers.
 */
const PICK_DEPTH_PLANE_ENABLED = true;

/**
 * Host services used while encoding WebGPU pick passes.
 */
export interface PickPassHost {
  _currentFrustumIndex: number;
  _globeDepth: {
    executeCopyDepthToView(
      encoder: GPUCommandEncoder,
      destinationView: GPUTextureView,
      depthTexture: GPUTexture,
      scissor?: { x: number; y: number; width: number; height: number },
    ): void;
  } | null;
  /**
   * Apply the given near/far to the camera frustum and refresh the
   * uniform state's projection matrix. Stores originals before the
   * apply, restores afterwards so the camera frustum stays unchanged
   * for downstream systems.
   */
  _updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void;
  _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: "scene" | "pick",
  ): void;
}

/**
 * Debug-only per-pass census of commands binned, dispatched, or rejected by
 * pick admission for one mini-frame.
 *
 * The interface survives type checking because types are erased, while every
 * producer block is removed from release builds by debug pragmas. Consumers
 * must therefore interpret `undefined` as a release build, not as zero
 * commands.
 */
export interface PickPassCensusRow {
  /** Commands present in this Pass's frustum bin, summed over frustum slices. */
  binned: number;
  /** Commands that reached `dispatched.execute(...)`. */
  dispatched: number;
  /** Skipped: `debugCommandFilter` rejected the command. */
  skippedDebugFilter: number;
  /** Skipped: the resolved command is not a native `WebGPUDrawCommand`. */
  skippedNonNative: number;
  /** Skipped: no pick variant resolved AND no `pickOnly` / `_isPickCommand`. */
  skippedNoPickVariant: number;
  /** Skipped: a voxel-coordinate payload did not belong to the selected owner. */
  skippedWrongVoxelOwner: number;
  /** Of `binned`, how many carried a dedicated-pick marker. */
  dedicatedPickBinned: number;
}

/** Whole-mini-frame census keyed by `Pass` index. */
export interface PickPassCensus {
  /** Increments once per {@link executePickPass}; lets a lane detect staleness. */
  generation: number;
  /** `frustumCommandsList.length` for the mini-frame this census describes. */
  frustums: number;
  /** Sparse map: only passes the schedule actually visited appear. */
  passes: Record<number, PickPassCensusRow>;
}

/** Context slot the census is published on. Debug builds only. */
type PickCensusContext = { _diagPickPassCensus?: PickPassCensus };

//>>includeStart('debug', pragmas.debug);
function diagResetPickCensus(
  context: WebGPUContext,
  frustums: number,
): PickPassCensus {
  const host = context as unknown as PickCensusContext;
  const census: PickPassCensus = {
    generation: (host._diagPickPassCensus?.generation ?? 0) + 1,
    frustums,
    passes: {},
  };
  host._diagPickPassCensus = census;
  return census;
}

function diagPickCensusRow(
  context: WebGPUContext,
  passIndex: number,
): PickPassCensusRow | null {
  const census = (context as unknown as PickCensusContext)._diagPickPassCensus;
  if (!census) {
    return null;
  }
  let row = census.passes[passIndex];
  if (!row) {
    row = {
      binned: 0,
      dispatched: 0,
      skippedDebugFilter: 0,
      skippedNonNative: 0,
      skippedNoPickVariant: 0,
      skippedWrongVoxelOwner: 0,
      dedicatedPickBinned: 0,
    };
    census.passes[passIndex] = row;
  }
  return row;
}
//>>includeEnd('debug');

/**
 * Type-narrowed view of the pick framebuffer that
 * `WebGPUPickFramebuffer.begin()` publishes into `passState.framebuffer`.
 * The `_isWebGPUPickFBO` discriminator is the marker the SceneRenderer
 * uses to confirm it isn't being handed a generic Cesium framebuffer
 * by accident.
 */
type WebGPUPickFBOShape = CesiumOpaqueFramebuffer & {
  _isWebGPUPickFBO?: boolean;
  colorView?: GPUTextureView;
  depthView?: GPUTextureView;
  depthTexture?: GPUTexture;
  width?: number;
  height?: number;
  pickScissor?: { x: number; y: number; width: number; height: number };
  // Optional pass-domain clear; ordinary object/metadata picking defaults 0.
  pickClearValue?: GPUColor;
  ensureClassificationDepth?: () => {
    texture: GPUTexture;
    view: GPUTextureView;
  } | null;
  // A `WebGPUSnapFramebuffer` adds these members. Its ordinary color and depth
  // views form the occluder phase; `snapColorView` is the `rg32uint` payload
  // attachment used against the same depth in the second phase.
  _isWebGPUSnapFBO?: boolean;
  snapColorView?: GPUTextureView;
  resetSnapPayloadCoverage?: (renderPass: GPURenderPassEncoder) => void;
};

const DEFAULT_PICK_CLEAR_VALUE: GPUColorDict = Object.freeze({
  r: 0,
  g: 0,
  b: 0,
  a: 0,
});

/**
 * Apply the caller's target sub-viewport and intersect it with the small pick
 * rectangle.
 * Cesium rectangles use a bottom-left origin while WebGPU scissor coordinates
 * use a top-left origin, matching the readback conversion in
 * `WebGPUPickFramebuffer`.
 */
function resolvePickDynamicState(
  pickFBO: WebGPUPickFBOShape,
  passState: CesiumPassState,
): WebGPUDynamicStateOverride {
  const passViewport = passState.viewport;
  const targetWidth = Math.max(
    1,
    Math.floor(pickFBO.width ?? passViewport?.width ?? 1),
  );
  const targetHeight = Math.max(
    1,
    Math.floor(pickFBO.height ?? passViewport?.height ?? 1),
  );
  const viewportX = Math.max(
    0,
    Math.min(targetWidth, Math.floor(passViewport?.x ?? 0)),
  );
  const viewportY = Math.max(
    0,
    Math.min(targetHeight, Math.floor(passViewport?.y ?? 0)),
  );
  const viewport = {
    x: viewportX,
    y: viewportY,
    width: Math.max(
      0,
      Math.min(
        Math.floor(passViewport?.width ?? targetWidth),
        targetWidth - viewportX,
      ),
    ),
    height: Math.max(
      0,
      Math.min(
        Math.floor(passViewport?.height ?? targetHeight),
        targetHeight - viewportY,
      ),
    ),
  };

  const normalized = pickFBO.pickScissor;
  const passScissor = passState.scissorTest;
  const rectangle = passScissor?.enabled ? passScissor.rectangle : undefined;
  const query =
    normalized ??
    (rectangle
      ? {
          x: Math.max(0, Math.min(targetWidth - 1, Math.floor(rectangle.x))),
          y: Math.max(
            0,
            Math.min(
              targetHeight - 1,
              targetHeight -
                Math.floor(rectangle.y) -
                Math.max(1, Math.floor(rectangle.height)),
            ),
          ),
          width: Math.max(1, Math.floor(rectangle.width)),
          height: Math.max(1, Math.floor(rectangle.height)),
        }
      : { x: 0, y: 0, width: targetWidth, height: targetHeight });

  const x = Math.max(viewport.x, query.x);
  const y = Math.max(viewport.y, query.y);
  const right = Math.min(viewport.x + viewport.width, query.x + query.width);
  const bottom = Math.min(viewport.y + viewport.height, query.y + query.height);
  return {
    viewport,
    scissor: {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    },
  };
}

function applyPickDynamicState(
  renderPass: GPURenderPassEncoder,
  dynamicState: WebGPUDynamicStateOverride,
): void {
  const viewport = dynamicState.viewport!;
  const scissor = dynamicState.scissor!;
  renderPass.setViewport(
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    0,
    1,
  );
  renderPass.setScissorRect(
    scissor.x,
    scissor.y,
    scissor.width,
    scissor.height,
  );
}

function beginPickRenderPass(
  context: WebGPUContext,
  encoder: GPUCommandEncoder,
  pickFBO: WebGPUPickFBOShape,
  dynamicState: WebGPUDynamicStateOverride,
  label: string,
  colorLoadOp: GPULoadOp,
  depthLoadOp: GPULoadOp,
  stencilLoadOp: GPULoadOp,
  storeForContinuation: boolean,
): GPURenderPassEncoder {
  const descriptor: GPURenderPassDescriptor = {
    label,
    colorAttachments: [
      {
        view: pickFBO.colorView as GPUTextureView,
        clearValue: pickFBO.pickClearValue ?? DEFAULT_PICK_CLEAR_VALUE,
        loadOp: colorLoadOp,
        // A snap occluder pass binds the RGBA8 pick target solely to keep the
        // existing pick fleet's pipelines attachment-compatible. No snap
        // consumer reads that color; only the shared depth/stencil attachment
        // crosses into the payload phase. Discarding avoids preserving a
        // full-viewport throwaway target. Ordinary pick ID color still stores
        // and accumulates across frustum slices exactly as before.
        storeOp:
          pickFBO._isWebGPUSnapFBO === true && !!pickFBO.snapColorView
            ? "discard"
            : "store",
      },
    ],
    depthStencilAttachment: {
      view: pickFBO.depthView as GPUTextureView,
      depthClearValue: 1.0,
      depthLoadOp,
      depthStoreOp: storeForContinuation ? "store" : "discard",
      stencilClearValue: 0,
      stencilLoadOp,
      stencilStoreOp: storeForContinuation ? "store" : "discard",
    },
  };
  const renderPass = encoder.beginRenderPass(
    context.withRenderPassTimestamps(descriptor, label),
  );
  context._currentRenderPassEncoder = renderPass;
  applyPickDynamicState(renderPass, dynamicState);
  return renderPass;
}

/**
 * Opens the snap payload render pass for one frustum slice.
 *
 * The pass loads the depth and stencil written by the occluder phase. Splitting
 * the phases is required because ordinary pick target formats are incompatible
 * with the integer payload attachment. Payload color loads across slices; the
 * coverage-reset draw erases a farther payload wherever the nearer slice has
 * established depth. Depth can be discarded after this phase because the next
 * slice clears it.
 */
function beginSnapPayloadRenderPass(
  context: WebGPUContext,
  encoder: GPUCommandEncoder,
  snapFBO: WebGPUPickFBOShape,
  dynamicState: WebGPUDynamicStateOverride,
  label: string,
  colorLoadOp: GPULoadOp,
): GPURenderPassEncoder {
  const descriptor: GPURenderPassDescriptor = {
    label,
    colorAttachments: [
      {
        view: snapFBO.snapColorView as GPUTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: colorLoadOp,
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: snapFBO.depthView as GPUTextureView,
      depthClearValue: 1.0,
      depthLoadOp: "load",
      depthStoreOp: "discard",
      stencilClearValue: 0,
      stencilLoadOp: "load",
      stencilStoreOp: "discard",
    },
  };
  const renderPass = encoder.beginRenderPass(
    context.withRenderPassTimestamps(descriptor, label),
  );
  context._currentRenderPassEncoder = renderPass;
  applyPickDynamicState(renderPass, dynamicState);
  return renderPass;
}

function endPickRenderPass(
  context: WebGPUContext,
  renderPass: GPURenderPassEncoder | null,
): void {
  if (!renderPass) {
    return;
  }
  try {
    renderPass.end();
  } finally {
    if (context._currentRenderPassEncoder === renderPass) {
      context._currentRenderPassEncoder = null;
    }
  }
}

/**
 * Run the WebGPU pick pass for the current frame. Mirrors the WebGL
 * `Picking.pickRectangle` orchestration but over the WebGPU pick FBO
 * + WebGPU command-execution path.
 *
 * @param host - The owning SceneRenderer (or any object satisfying
 *   {@link PickPassHost}).
 * @param config - The current frame's render-frame config. The
 *   `passState.framebuffer` slot must carry the WebGPU pick FBO
 *   established by {@link WebGPUPickFramebuffer}.
 */
export function executePickPass(
  host: PickPassHost,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context, passState } = config;
  const view = scene._view;
  const { frustumCommandsList } = view;
  const numFrustums: number = frustumCommandsList.length;
  const { uniformState } = context;

  // Reset before the zero-frustum return so a new empty generation is
  // distinguishable from stale census data.
  //>>includeStart('debug', pragmas.debug);
  diagResetPickCensus(context, numFrustums);
  //>>includeEnd('debug');

  // Get pick framebuffer from passState (set by WebGPUPickFramebuffer.begin())
  const pickFBORaw = passState?.framebuffer;
  const pickFBO = pickFBORaw as WebGPUPickFBOShape | undefined;
  if (!pickFBO || !pickFBO._isWebGPUPickFBO) {
    // No WebGPU pick framebuffer — fall back to rendering normally
    // (this shouldn't happen, but be safe)
    return;
  }

  // A snap framebuffer supplies both discriminators and a payload view. Each
  // slice first establishes occluder depth, then draws resolved snap variants
  // against it. Without a payload view, retain the ordinary pick schedule
  // rather than opening a null-target pass.
  const snapMode = pickFBO._isWebGPUSnapFBO === true && !!pickFBO.snapColorView;
  const resetSnapPayloadCoverage = pickFBO.resetSnapPayloadCoverage;
  if (
    snapMode &&
    (numFrustums > 1 || config.sceneFbLoad) &&
    typeof resetSnapPayloadCoverage !== "function"
  ) {
    throw new DeveloperError(
      "A loaded WebGPU snap payload requires resetSnapPayloadCoverage.",
    );
  }

  const device: GPUDevice | undefined = context._device;
  if (!device) {
    return;
  }
  // The pick render runs via `pickBegin → updateAndExecuteCommands`, NOT the
  // normal `render()` path, so `context.beginFrame()` never ran and there is no
  // command encoder yet. Create the off-screen pick mini-frame encoder (+ the
  // uniform-allocator page) here; `pickEnd → context.endFrame()` submits +
  // finalizes it. Without this the pick pass renders nothing and every
  // scene.pick / pickAsync returns undefined. No-op if an encoder
  // already exists (e.g. pick nested inside a normal frame).
  context.beginPickFrame?.();
  const encoder: GPUCommandEncoder | undefined = context._currentCommandEncoder;
  if (!encoder) {
    return;
  }

  // End the current render pass so we can start the pick render pass
  context.endCurrentRenderPass?.();
  const pickDynamicState = resolvePickDynamicState(pickFBO, passState);

  // An empty/cull-only pick still owns a result: no hit. The attachment is
  // persistent, so returning without a render pass would leave the previous
  // object's ID in place; for pickVoxel it would also bypass the all-255
  // no-fragment sentinel and reinterpret those stale bytes as a cell. Clear
  // once even when PVS produced no frustum, on the same mini-frame encoder
  // that the readback copies after this function returns.
  if (numFrustums === 0) {
    const clearPass = beginPickRenderPass(
      context,
      encoder,
      pickFBO,
      pickDynamicState,
      "Pick clear-only pass (zero frustums)",
      "clear",
      "clear",
      "clear",
      false,
    );
    endPickRenderPass(context, clearPass);
    if (snapMode) {
      const snapClearPass = beginSnapPayloadRenderPass(
        context,
        encoder,
        pickFBO,
        pickDynamicState,
        "Snap payload clear-only pass (zero frustums)",
        "clear",
      );
      endPickRenderPass(context, snapClearPass);
    }
    context._pickClassificationDepthView = null;
    return;
  }

  publishLogDepthEncodeNearFar(scene, uniformState);
  const scene2DCamera = scene.camera as unknown as {
    position: { z: number };
  };
  const initialHeight2D =
    scene.mode === 2 /* SceneMode.SCENE2D */ ? scene2DCamera.position.z : 0;
  const opaqueFrustumNearOffset = scene.opaqueFrustumNearOffset ?? 0.9999;
  let completed = false;

  // Execute all pickable passes across all frustums. Cesium frustum depths are
  // encoded against each slice's projection, so values from two slices are not
  // comparable. Mirroring WebGL, use one render pass per far-to-near slice:
  // clear ID color once, load it for later slices, and clear depth/stencil for
  // every slice. A single pass with one depth clear lets a near-slice depth
  // incorrectly reject or preserve a far-slice fragment.
  try {
    for (let i = 0; i < numFrustums; i++) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      let near: number;
      let far: number;
      if (scene.mode === 2 /* SceneMode.SCENE2D */ && numFrustums > 1) {
        scene2DCamera.position.z = initialHeight2D - frustumCommands.near + 1.0;
        near = 1.0;
        far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
        const state = uniformState as unknown as {
          update?: (frameState: typeof scene._frameState) => void;
        };
        state.update?.(scene._frameState);
      } else if (scene.mode === 2 /* SceneMode.SCENE2D */) {
        const cameraFrustum = scene._frameState.camera?.frustum as
          { near?: number; far?: number } | undefined;
        near = cameraFrustum?.near ?? frustumCommands.near;
        far = cameraFrustum?.far ?? frustumCommands.far;
      } else {
        near =
          index !== 0
            ? frustumCommands.near * opaqueFrustumNearOffset
            : frustumCommands.near;
        far = frustumCommands.far;
      }
      host._updateFrustumUniforms(uniformState, near, far, scene);
      publishCurrentFrustumState(host, context, uniformState, i, near, far);

      const terrainClassificationCount =
        frustumCommands.indices[Pass.TERRAIN_CLASSIFICATION] ?? 0;
      const tileClassificationCount =
        frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] ?? 0;
      const requestsClassificationDepth =
        terrainClassificationCount > 0 || tileClassificationCount > 0;
      const classificationTarget =
        requestsClassificationDepth && host._globeDepth && pickFBO.depthTexture
          ? (pickFBO.ensureClassificationDepth?.() ?? null)
          : null;
      if (classificationTarget) {
        context._pickClassificationDepthView = classificationTarget.view;
      }
      const terrainCheckpoint =
        terrainClassificationCount > 0 && classificationTarget !== null;
      const tileCheckpoint =
        tileClassificationCount > 0 && classificationTarget !== null;
      const clearGlobeDepth = config.clearGlobeDepth === true;
      let pickRenderPass: GPURenderPassEncoder | null = beginPickRenderPass(
        context,
        encoder,
        pickFBO,
        pickDynamicState,
        `Pick render pass frustum ${i}`,
        i === 0 && !config.sceneFbLoad ? "clear" : "load",
        "clear",
        "clear",
        // In snap mode the payload phase LOADS this depth, so it must survive
        // the end of the occluder phase.
        terrainCheckpoint || clearGlobeDepth || tileCheckpoint || snapMode,
      );
      const execute = (passIndex: number): void => {
        executePickBatch(
          frustumCommands,
          passIndex,
          scene,
          context,
          passState,
          pickRenderPass!,
          pickDynamicState,
        );
      };
      const reopen = (
        label: string,
        depthLoadOp: GPULoadOp,
        stencilLoadOp: GPULoadOp,
        storeForContinuation: boolean,
      ): void => {
        const previousPass = pickRenderPass;
        pickRenderPass = null;
        endPickRenderPass(context, previousPass);
        pickRenderPass = beginPickRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          label,
          "load",
          depthLoadOp,
          stencilLoadOp,
          storeForContinuation,
        );
      };
      const packDepthAndReopen = (
        label: string,
        storeForContinuation: boolean,
      ): void => {
        endPickRenderPass(context, pickRenderPass);
        pickRenderPass = null;
        host._globeDepth!.executeCopyDepthToView(
          encoder,
          classificationTarget!.view,
          pickFBO.depthTexture!,
          pickDynamicState.scissor,
        );
        context._pickClassificationDepthView = classificationTarget!.view;
        pickRenderPass = beginPickRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          label,
          "load",
          "load",
          "load",
          storeForContinuation,
        );
      };

      try {
        // Skip ENVIRONMENT pass — sky/sun/moon/atmosphere don't generate pick IDs

        // GLOBE pass
        execute(Pass.GLOBE);

        // Classification samples packed depth and therefore needs a real pass
        // boundary. Ordinary picks skip both the pack and the continuation.
        if (terrainCheckpoint) {
          packDepthAndReopen(
            `Pick terrain classification frustum ${i}`,
            clearGlobeDepth || tileCheckpoint || snapMode,
          );
          execute(Pass.TERRAIN_CLASSIFICATION);
        }

        if (clearGlobeDepth) {
          reopen(
            `Pick post-globe depth-clear frustum ${i}`,
            "clear",
            "load",
            tileCheckpoint || snapMode,
          );
          if (PICK_DEPTH_PLANE_ENABLED && config.useDepthPlane) {
            host._renderDepthPlane(config, "pick");
          }
        }

        execute(Pass.CESIUM_3D_TILE);
        if (tileCheckpoint) {
          packDepthAndReopen(
            `Pick 3D-tile classification frustum ${i}`,
            snapMode,
          );
          execute(Pass.CESIUM_3D_TILE_CLASSIFICATION);
        }

        // Voxel and Gaussian-splat bins participate in the pick schedule and
        // use the same resolved-variant or dedicated-command admission rules
        // as the other bins.
        const voxelCount = frustumCommands.indices[Pass.VOXELS] ?? 0;
        if (voxelCount > 1) {
          sortCommandsBackToFront(
            frustumCommands.commands[Pass.VOXELS],
            voxelCount,
            scene,
          );
        }
        execute(Pass.VOXELS);

        // OPAQUE follows voxels, matching the normal/WebGL frustum loop.
        const splatCount = frustumCommands.indices[Pass.GAUSSIAN_SPLATS] ?? 0;
        if (splatCount > 1) {
          sortGaussianSplatsBackToFront(
            frustumCommands.commands[Pass.GAUSSIAN_SPLATS],
            splatCount,
            scene,
          );
        }
        execute(Pass.OPAQUE);

        execute(Pass.GAUSSIAN_SPLATS);

        // Match the normal loop's exact-near translucent projection. Opaque
        // slices use a slight near offset to avoid seams, but translucent depth
        // and blending must use the raw slice boundary.
        if (
          index !== 0 &&
          scene.mode !== 2 /* SceneMode.SCENE2D */ &&
          (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) > 0
        ) {
          host._updateFrustumUniforms(
            uniformState,
            frustumCommands.near,
            far,
            scene,
          );
          publishCurrentFrustumState(
            host,
            context,
            uniformState,
            i,
            frustumCommands.near,
            far,
          );
        }

        // TRANSLUCENT pass runs last so opaque/voxel/splat depth is established.
        const translucentCount = frustumCommands.indices[Pass.TRANSLUCENT] ?? 0;
        if (translucentCount > 1) {
          sortCommandsFrontToBack(
            frustumCommands.commands[Pass.TRANSLUCENT],
            translucentCount,
            scene,
          );
        }
        execute(Pass.TRANSLUCENT);
      } finally {
        // A thrown command must not leave the command encoder with an open
        // render pass; otherwise endFrame cannot finish or submit it.
        endPickRenderPass(context, pickRenderPass);
      }

      // The occluder phase stored this slice's depth. Load that depth in the
      // `rg32uint` payload pass and draw only resolved snap variants.
      if (snapMode) {
        const snapRenderPass: GPURenderPassEncoder = beginSnapPayloadRenderPass(
          context,
          encoder,
          pickFBO,
          pickDynamicState,
          `Snap payload pass frustum ${i}`,
          i === 0 && !config.sceneFbLoad ? "clear" : "load",
        );
        try {
          // A loaded payload may contain a farther slice's hit. Depth was
          // cleared and rebuilt for this slice, so erase that prior payload
          // wherever the current slice has an occluder before drawing current
          // snap variants. The callback records one fullscreen triangle into
          // THIS pass; beginSnapPayloadRenderPass already restricted it to the
          // query viewport/scissor. No reset is needed for the first fresh
          // slice because its payload attachment was just cleared.
          if (i > 0 || config.sceneFbLoad) {
            resetSnapPayloadCoverage!(snapRenderPass);
          }

          // Same pass order as the occluder phase minus the classification
          // checkpoints: classification draws carry no snap payload, and their
          // packed-depth reopen would clear the depth the payload phase is
          // reading. Sorting already happened in the occluder phase, so the
          // command arrays are in the order this phase wants. The two edge
          // passes execute last.
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.GLOBE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.VOXELS,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.OPAQUE,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.GAUSSIAN_SPLATS,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.TRANSLUCENT,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );

          // Edge-emitter commands live in bins omitted by the occluder phase
          // because they have no pick variant. Only resolved snap variants
          // draw here, preserving the strict payload admission rule. Execute
          // them last so `less-equal` lets an edge win a surface-depth tie and
          // stamp the edge bit over the surface payload.
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE_EDGES,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
          executeSnapPayloadBatch(
            frustumCommands,
            Pass.CESIUM_3D_TILE_EDGES_DIRECT,
            scene,
            context,
            snapRenderPass,
            pickDynamicState,
          );
        } finally {
          // Same contract as the occluder phase: a throwing command must never
          // leave the encoder with an open render pass.
          endPickRenderPass(context, snapRenderPass);
        }
      }
    }
    completed = true;
  } finally {
    if (scene.mode === 2 /* SceneMode.SCENE2D */) {
      scene2DCamera.position.z = initialHeight2D;
    }
    // The pick branch is terminal for this mini-frame. Clear the ended
    // encoder slot and let `pickEnd → context.endFrame()` resolve timestamps,
    // finish, and submit. A pick mini-frame has no canvas texture to resume.
    context._currentRenderPassEncoder = null;
    if (!config.deferComposite || !completed) {
      context._pickClassificationDepthView = null;
    }
  }
}

/**
 * Dispatches one pass's resolved snap variants into the payload render pass.
 *
 * This admission is narrower than {@link executePickBatch}. Only a native
 * command resolved to a distinct snap variant can enter the integer payload
 * pass. An unchanged selection supplies no admitted payload command, and the
 * ordinary pick-only markers do not widen this admission because those
 * pipelines target the ordinary pick attachment. Precise-pick pass-two
 * coordination does not apply to snapping.
 */
function executeSnapPayloadBatch(
  frustumCommands: CesiumFrustumCommands,
  passIndex: number,
  scene: CesiumScene,
  context: WebGPUContext,
  snapRenderPass: GPURenderPassEncoder,
  pickDynamicState: WebGPUDynamicStateOverride,
): void {
  const commands = frustumCommands.commands[passIndex];
  const count: number = frustumCommands.indices[passIndex];
  if (count === 0) {
    return;
  }
  context.uniformState?.updatePass(passIndex);

  for (let i = 0; i < count; i++) {
    const command = commands[i];
    if (!command) {
      continue;
    }
    if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
      continue;
    }
    const dispatched = selectCommandVariant(command, scene, true, true);
    if (dispatched === command || dispatched.isWebGPUDrawCommand !== true) {
      continue;
    }
    dispatched.execute(snapRenderPass, pickDynamicState);
  }
}

/**
 * Execute a batch of commands for a specific pass during pick rendering.
 * Commands are executed on the pick render pass encoder.
 */
function executePickBatch(
  frustumCommands: CesiumFrustumCommands,
  passIndex: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
  pickRenderPass: GPURenderPassEncoder,
  pickDynamicState: WebGPUDynamicStateOverride,
): void {
  const commands = frustumCommands.commands[passIndex];
  const count: number = frustumCommands.indices[passIndex];
  if (count === 0) {
    return;
  }
  context.uniformState?.updatePass(passIndex);

  // The binding and every access below sit inside debug pragmas, so
  // `censusRow` does not exist in a release build.
  //>>includeStart('debug', pragmas.debug);
  const censusRow = diagPickCensusRow(context, passIndex);
  if (censusRow) {
    censusRow.binned += count;
  }
  //>>includeEnd('debug');

  for (let i = 0; i < count; i++) {
    const command = commands[i];
    if (!command) {
      continue;
    }

    // Skip commands that don't participate in picking
    if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
      //>>includeStart('debug', pragmas.debug);
      if (censusRow) {
        censusRow.skippedDebugFilter++;
      }
      //>>includeEnd('debug');
      continue;
    }

    // Resolve the applicable picking or metadata variant. Native renderers
    // may instead emit dedicated commands marked `pickOnly` or
    // `_isPickCommand`.
    const dispatched = selectCommandVariant(command, scene, true);

    // WebGPU validates pipeline targets against render-pass attachments at
    // draw time. An unchanged base command can target the scene framebuffer
    // and invalidate this single-target command buffer, so admit only native
    // resolved variants or native dedicated-pick commands.
    const resolvedPickVariant = dispatched !== command;
    const cmdMarkers = command as {
      pickOnly?: boolean;
      _isPickCommand?: boolean;
    };
    // Two established dedicated-pick markers: `pickOnly` (collections,
    // mirrors WebGL `DrawCommand.pickOnly`) and `_isPickCommand`
    // (geometry-primitive path in WebGPUPrimitiveCommands.js). Either
    // means the command's pipeline already targets the single pick
    // attachment, so it is safe to dispatch into the pick render pass.
    const isDedicatedPick =
      cmdMarkers.pickOnly === true || cmdMarkers._isPickCommand === true;
    // The WebGPU mini-frame can encode only native WebGPU draw commands.
    // Legacy WebGL DrawCommands can also carry `pickOnly`; dispatching one
    // through WebGPUContext.draw eventually calls
    // `GPURenderPassEncoder.draw(DrawCommand, PassState)` and fails WebIDL's
    // unsigned-long conversion. Standalone ClassificationPrimitive retains
    // such compatibility commands alongside its native feature-renderer
    // command, so the marker alone is not a sufficient admission test.
    const isNativeWebGPU = dispatched.isWebGPUDrawCommand === true;
    const selectedVoxelOwner = (
      scene.frameState as unknown as { _pickVoxelPrimitive?: unknown }
    )._pickVoxelPrimitive;
    const dispatchedVoxelOwner = (
      dispatched as CesiumAnyDrawCommand & { _voxelPickOwner?: unknown }
    )._voxelPickOwner;
    const isSelectedVoxelPayload =
      !scene.frameState.passes.pickVoxel ||
      (selectedVoxelOwner !== undefined &&
        dispatchedVoxelOwner === selectedVoxelOwner);
    //>>includeStart('debug', pragmas.debug);
    if (censusRow) {
      if (isDedicatedPick) {
        censusRow.dedicatedPickBinned++;
      }
      if (!isNativeWebGPU) {
        censusRow.skippedNonNative++;
      } else if (!resolvedPickVariant && !isDedicatedPick) {
        censusRow.skippedNoPickVariant++;
      } else if (!isSelectedVoxelPayload) {
        censusRow.skippedWrongVoxelOwner++;
      } else {
        censusRow.dispatched++;
      }
    }
    //>>includeEnd('debug');
    if (
      !isNativeWebGPU ||
      (!resolvedPickVariant && !isDedicatedPick) ||
      !isSelectedVoxelPayload
    ) {
      continue;
    }

    dispatched.execute(pickRenderPass, pickDynamicState);

    // For a precise pick, execute the matching depth/stencil pass and
    // depth-equal color pass consecutively in the same render pass. The
    // per-primitive interleave preserves the attachment state that the color
    // pass tests, while ordinary depth testing selects the nearer survivor.
    if (
      scene.frameState?.passes?.pickMode === "precise" &&
      command.derivedCommands?.picking?.pickPrecisePass2Command
    ) {
      const pass2 = command.derivedCommands.picking.pickPrecisePass2Command;
      if (pass2.isWebGPUDrawCommand === true) {
        pass2.execute(pickRenderPass, pickDynamicState);
      }
    }
  }
}
