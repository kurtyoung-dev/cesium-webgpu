/**
 * Multi-frustum dispatch loop for
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Walks the frustum list far to near and dispatches every per-frustum
 * pass:
 *
 *   - SCENE2D per-frustum depth setup
 *   - capturedFrustumRanges bookkeeping for the debug overlay
 *   - frustum uniform refresh + currentFrustumIndex update
 *   - depth/stencil clear (gated on debugShowDepthAsColor)
 *   - ENVIRONMENT pass (farthest frustum only)
 *   - GLOBE pass + globe-depth copy (when useGlobeDepthFramebuffer)
 *   - TERRAIN_CLASSIFICATION pass + optional clearGlobeDepth +
 *     depth-plane render
 *   - 3D-tile chain with depth-update hook between main + classification
 *   - VOXELS sort + dispatch
 *   - OPAQUE pass
 *   - GAUSSIAN_SPLATS — immediate draw or opt-in translucent staging
 *   - second frustum-uniform refresh (use exact near for translucent
 *     to avoid blending artifacts)
 *   - KHR_materials_transmission refraction capture
 *   - TRANSLUCENT pass
 *   - packed translucent-depth publication for classification
 *   - per-frustum pick-depth copy
 *
 * `FrustumLoopHost` enumerates the SceneRenderer surface used by the
 * loop.
 *
 * @module WebGPUSceneRendererFrustumLoop
 */

import Pass from "../../Renderer/Pass.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import type { WebGPUOIT } from "./WebGPUOIT.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";
import { getInvertClassificationDepthTexture } from "./WebGPUInvertClassification.js";
import {
  finalizeWebGPUPointCloudEDLFrame,
  prepareWebGPUPointCloudEDLCommands,
  renderWebGPUPointCloudEDLCommands,
} from "./WebGPUPointCloudEyeDomeLighting.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import {
  sortCommandsBackToFront,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";
import type { WebGPUCpuPassProfiler } from "./WebGPUCpuPassProfiler.js";
import {
  publishCurrentFrustumState,
  publishLogDepthEncodeNearFar,
} from "./WebGPUSceneRendererFrustumState.js";

/**
 * SceneRenderer surface the frustum-loop helper reaches back to.
 * Fields precede method callbacks.
 */
export interface FrustumLoopHost {
  // Field reads
  _globeDepth: WebGPUGlobeDepth | null;
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  _oit: WebGPUOIT | null;
  _translucentTileClassification: WebGPUTranslucentTileClassification | null;
  _cpuPassProfiler: WebGPUCpuPassProfiler;
  // OIT deferral for Gaussian splats is opt-in. The default value, false,
  // keeps WebGL-parity inline execution. See the flag on WebGPUSceneRenderer.
  _splatOITDeferral: boolean;

  // Field writes
  _capturedFrustumRanges: { near: number; far: number }[];
  _currentFrustumIndex: number;
  _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null;

  // Method callbacks
  _updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void;
  _clearDepthStencil(context: WebGPUContext): void;
  _executePassCommands(
    frustumCommands: CesiumFrustumCommands,
    passIndex: number,
    scene: CesiumScene,
    context: WebGPUContext,
    passState: CesiumPassState,
  ): void;
  _executeGlobePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: "scene" | "pick",
  ): void;
  _execute3DTilePasses(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
    onAfterTileMainPass?: () => void,
  ): void;
  _executeOpaquePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _executeTranslucentPass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _captureRefractionScene(config: WebGPURenderFrameConfig): void;
  _resumeScenePass(context: WebGPUContext): void;
}

/**
 * Walk the frustum list far-to-near and dispatch every per-frustum
 * pass. The caller, `WebGPUSceneRenderer.executeCommands`, handles the
 * per-frame state reset and scene-framebuffer redirect before the loop,
 * then runs overlays, the depth plane, environment effects, compositing,
 * velocity, and post-processing afterward.
 *
 * @param host - The owning SceneRenderer.
 * @param config - Render-frame config from `executeCommands`.
 * @param opaqueFrustumNearOffset - Per-frame offset (default 0.9999)
 *   applied to non-nearest-frustum near planes to avoid tearing.
 */
export function executeFrustumLoop(
  host: FrustumLoopHost,
  config: WebGPURenderFrameConfig,
  opaqueFrustumNearOffset: number,
): void {
  const { scene, context, passState, picking } = config;
  const view = scene._view;
  const frustumCommandsList = view.frustumCommandsList;
  const numFrustums = frustumCommandsList.length;
  const uniformState = context.uniformState;

  // Retain the persistent camera altitude for multi-frustum SCENE2D.
  // `SceneRenderer.js` shifts `camera.position.z` for each frustum,
  // compresses its range to [1, far - near + 1], and calls
  // `uniformState.update(frameState)` so orthographic depth precision
  // remains uniform across slice boundaries. `Camera.position` is
  // initialized in `Camera.js` but omitted from the ambient
  // `CesiumCamera` shape, so cast to read it.
  const scene2DCamera = scene.camera as unknown as {
    position: { z: number };
  };
  const initialHeight2D =
    scene.mode === 2 /* SceneMode.SCENE2D */ ? scene2DCamera.position.z : 0;

  // Publish the persistent camera frustum used to encode logarithmic globe
  // depth before `_updateFrustumUniforms` replaces
  // `UniformState.currentFrustum` with each slice. Depth-sampling classifiers
  // decode eye distance with this encode range and unproject with the current
  // slice projection.
  publishLogDepthEncodeNearFar(scene, uniformState);

  // Iterate far to near, matching `SceneRenderer.js`'s
  // `numFrustums - i - 1` ordering.
  for (let i = 0; i < numFrustums; i++) {
    const index = numFrustums - i - 1;
    const frustumCommands = frustumCommandsList[index];

    // `SceneRenderer.js` applies the SCENE2D camera shift and range
    // compression unconditionally. WebGPU applies it only with multiple
    // frustums because a single-frustum shift moves `camera.position.z` to
    // about 1 and lets the near plane clip the entire planar globe.
    let near;
    let far;
    if (scene.mode === 2 /* SceneMode.SCENE2D */ && numFrustums > 1) {
      scene2DCamera.position.z = initialHeight2D - frustumCommands.near + 1.0;
      far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
      near = 1.0;
      // Refresh the view and projection after shifting the camera so tile
      // uniform buffers use the per-frustum position, matching
      // `SceneRenderer.js`'s `uniformState.update(frameState)` call.
      const us = uniformState as unknown as {
        update: (fs: typeof scene._frameState) => void;
      };
      us.update?.(scene._frameState);
    } else if (scene.mode === 2 /* SceneMode.SCENE2D */) {
      // A single SCENE2D frustum uses the camera's full visible range
      // because its potentially-visible-set band can exclude the planar
      // globe. This deliberately diverges from `SceneRenderer.js`'s
      // unconditional shift and compression.
      const camFrust = scene._frameState.camera?.frustum as
        { near?: number; far?: number } | undefined;
      near = camFrust?.near ?? frustumCommands.near;
      far = camFrust?.far ?? frustumCommands.far;
    } else {
      // Apply opaque near offset to avoid tearing artifacts between adjacent frustums
      // (except for the nearest frustum which uses the actual near value)
      near =
        index !== 0
          ? frustumCommands.near * opaqueFrustumNearOffset
          : frustumCommands.near;
      far = frustumCommands.far;
    }

    // Store the range by natural frustum index (0 = nearest)
    // so `WebGPUDebugFrustumOverlay` can match the WebGL DebugInspector
    // bitmask order. `index` already points to the natural order.
    host._capturedFrustumRanges[index] = {
      near: frustumCommands.near,
      far,
    };

    host._updateFrustumUniforms(uniformState, near, far, scene);
    // Shared with the auxiliary pick loop; collection/classification
    // bind-group resolvers require the exact slice projection and index.
    publishCurrentFrustumState(host, context, uniformState, i, near, far);

    // Clear depth/stencil per frustum (but not color — color accumulates across frustums).
    //
    // When `debugShowDepthAsColor` is enabled, retain depth from earlier
    // frustums after the initial clear so the overlay can sample the whole
    // far-to-near range. Clearing every iteration leaves only the nearest
    // frustum and can make a far-frustum globe appear absent. The diagnostic
    // frame accepts stale far-frustum depth, which can incorrectly occlude
    // nearer geometry.
    const debugDepthViz = scene?._frameState?.debugShowDepthAsColor === true;
    if (!debugDepthViz || i === 0) {
      host._clearDepthStencil(context);
    }

    // Pass.ENVIRONMENT executes once in the farthest frustum.
    if (i === 0) {
      host._cpuPassProfiler.beginPass("environment");
      try {
        host._executePassCommands(
          frustumCommands,
          Pass.ENVIRONMENT,
          scene,
          context,
          passState,
        );
      } finally {
        host._cpuPassProfiler.endPass("environment");
      }
    }

    host._cpuPassProfiler.beginPass("globe");
    try {
      host._executeGlobePass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("globe");
    }

    // Copy globe depth for terrain clamping and picking. Pass the scene
    // framebuffer depth explicitly because WebGPU globe rendering writes
    // there; `WebGPUGlobeDepth`'s `_outputTarget` fallback is not a
    // scene-depth producer.
    if (host._globeDepth && config.useGlobeDepthFramebuffer) {
      const encoder: GPUCommandEncoder | undefined =
        context._currentCommandEncoder;
      if (encoder) {
        const depthSource: GPUTexture | undefined =
          host._sceneFramebuffer?.colorTarget?.getDepthTexture();
        // End current render pass so the depth texture is available for reading
        context.endCurrentRenderPass?.();
        host._globeDepth.executeCopyDepth(encoder, depthSource);
        // Resume the scene-framebuffer pass for subsequent commands,
        // not the canvas pass. `resumeDefaultRenderPass` would redirect
        // every following draw to the canvas swap-chain, leaving the
        // scene FB empty for the post-process chain to blit.
        host._resumeScenePass(context);
        // Publish target-owned packed-depth resources on the context so model
        // fragment bind groups can sample globe depth without reaching through
        // the renderer hierarchy. Target recreation on resize or device
        // generation supplies a new view identity.
        const packedDepth = host._globeDepth.globeDepthTexture;
        // Also publish the underlying texture for consumers that own their
        // aspect and view policy; ordinary effects key on the stable
        // renderer-owned view.
        context._globeDepthTexture = packedDepth ?? null;
        context._globeDepthView =
          host._globeDepth.globeDepthTextureView ?? null;
      }
    }

    host._executePassCommands(
      frustumCommands,
      Pass.TERRAIN_CLASSIFICATION,
      scene,
      context,
      passState,
    );

    // Clear globe depth if needed for primitives-on-top rendering.
    // Use the same diagnostic-depth bypass as the inter-frustum clear so the
    // overlay sees globe and 3D Tiles depth together rather than a
    // mid-frustum clear.
    if (config.clearGlobeDepth && !debugDepthViz) {
      host._clearDepthStencil(context);
      if (config.useDepthPlane) {
        host._renderDepthPlane(config, "scene");
      }
    }

    // Run the 3D Tiles pass chain with a depth-update hook between the main
    // tile pass and classification. `SceneRenderer.js` calls
    // `globeDepth.executeUpdateDepth` after
    // `performPass(Pass.CESIUM_3D_TILE)` and before classification so
    // classifiers sample tile-augmented rather than terrain-only depth.
    //
    // Under invert classification, tile geometry writes the invert
    // framebuffer's depth attachment. Pass that texture explicitly, matching
    // `SceneRenderer.js`'s invert-classification branch; sampling scene depth
    // would publish only globe depth and make classifiers z-fight tiles.
    host._cpuPassProfiler.beginPass("3dTiles");
    try {
      host._execute3DTilePasses(frustumCommands, config, () => {
        if (host._globeDepth && config.useGlobeDepthFramebuffer) {
          const enc: GPUCommandEncoder | undefined =
            context._currentCommandEncoder;
          if (enc) {
            // Scene depth is the default explicit source. Invert
            // classification overrides it with the invert framebuffer depth
            // because the tile pass wrote there.
            let depthSource: GPUTexture | undefined =
              host._sceneFramebuffer?.colorTarget?.getDepthTexture();
            if (config.useInvertClassification) {
              const invertOwner = (
                scene as unknown as {
                  _invertClassification?: CesiumObjectWithWebGPUCache;
                }
              )._invertClassification;
              if (invertOwner) {
                const invertDepth =
                  getInvertClassificationDepthTexture(invertOwner);
                if (invertDepth) {
                  depthSource = invertDepth;
                }
              }
            }
            context.endCurrentRenderPass?.();
            host._globeDepth.executeUpdateDepth(enc, depthSource);
            host._resumeScenePass(context);
          }
        }
      });
    } finally {
      host._cpuPassProfiler.endPass("3dTiles");
    }

    // Keep Pass.VOXELS before Pass.OPAQUE so volumetric media are ordered
    // against opaque depth. `SceneRenderer.js` runs `performVoxelsPass`
    // before `performPass(Pass.OPAQUE)`. Sort voxel commands back to front
    // before dispatch.
    {
      const voxCount: number = frustumCommands.indices[Pass.VOXELS];
      if (voxCount > 0) {
        sortCommandsBackToFront(
          frustumCommands.commands[Pass.VOXELS],
          voxCount,
          scene,
        );
      }
    }
    host._cpuPassProfiler.beginPass("voxels");
    try {
      host._executePassCommands(
        frustumCommands,
        Pass.VOXELS,
        scene,
        context,
        passState,
      );
    } finally {
      host._cpuPassProfiler.endPass("voxels");
    }

    // Pass.OPAQUE EDL preflight is deliberately bucket-local: only
    // commands that belong to this frustum and whose replay/composite
    // resources are ready are disabled. A pending/failed EDL resource leaves
    // the original command enabled, so the normal draw remains fail-open.
    const opaqueCommands = frustumCommands.commands[Pass.OPAQUE];
    const opaqueCount: number = frustumCommands.indices[Pass.OPAQUE] ?? 0;
    const sceneEDLTargetIdentity = context as unknown as object;
    const sceneSampleCount = context._msaaSamples ?? 1;
    const sceneTargetCount = isSceneFBMrtMode() ? 2 : 1;
    let opaqueEDLCount = 0;
    if (!picking && opaqueCount > 0) {
      opaqueEDLCount = prepareWebGPUPointCloudEDLCommands(
        context,
        scene._frameState,
        opaqueCommands,
        opaqueCount,
        Pass.OPAQUE,
        i,
        "scene",
        sceneEDLTargetIdentity,
        context.scenePipelineFormat,
        sceneSampleCount,
        sceneTargetCount,
      );
    }
    host._cpuPassProfiler.beginPass("opaque");
    try {
      host._executeOpaquePass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("opaque");
    }

    // Composite only this frustum's OPAQUE EDL groups before depth repacking
    // and translucency. Each processor is replayed/composited independently,
    // preserving its strength/radius and stable update order.
    if (opaqueEDLCount > 0) {
      renderWebGPUPointCloudEDLCommands(
        context,
        scene._frameState,
        opaqueCommands,
        opaqueCount,
        Pass.OPAQUE,
        i,
        "scene",
        sceneEDLTargetIdentity,
        context.scenePipelineFormat,
        sceneSampleCount,
        sceneTargetCount,
        () => {
          host._resumeScenePass(context);
          return context._currentRenderPassEncoder ?? null;
        },
      );
    }

    // Repack scene depth after Pass.OPAQUE so `pickPosition` and `pickFromRay`
    // over opaque Model and Primitive surfaces read the model rather than the
    // globe behind it. Models write the scene-framebuffer depth attachment,
    // while the preceding globe and 3D Tiles publications occur before opaque
    // rendering. `SceneRenderer.js` passes the live
    // `globeDepth.depthStencilTexture` to `pickDepth.update` after
    // `performPass(Pass.OPAQUE)`; WebGPU updates the packed RGBA8 depth here
    // before the per-frustum pick-depth copy at the end of the loop body. Both
    // operations run on the non-picking frame.
    if (
      !picking &&
      host._globeDepth &&
      config.useGlobeDepthFramebuffer &&
      scene._picking &&
      // Repack only when opaque or voxel rendering, or the post-globe clear,
      // could have changed the live depth attachment.
      ((frustumCommands.indices[Pass.OPAQUE] ?? 0) > 0 ||
        (frustumCommands.indices[Pass.VOXELS] ?? 0) > 0 ||
        (config.clearGlobeDepth && !debugDepthViz))
    ) {
      const enc: GPUCommandEncoder | undefined = context._currentCommandEncoder;
      if (enc) {
        const depthSource: GPUTexture | undefined =
          host._sceneFramebuffer?.colorTarget?.getDepthTexture();
        context.endCurrentRenderPass?.();
        host._globeDepth.executeUpdateDepth(enc, depthSource);
        host._resumeScenePass(context);
      }
    }

    // Pass.CESIUM_3D_TILE_EDGES_DIRECT runs after Pass.OPAQUE and before
    // Pass.GAUSSIAN_SPLATS, matching
    // `performCesium3DTileEdgesDirectPass` in `SceneRenderer.js`. These CAD
    // wireframe commands use a single-target pipeline on the active scene
    // pass, unlike the optionally MRT-redirected Pass.CESIUM_3D_TILE_EDGES.
    // `_executePassCommands` returns immediately when this bucket is empty.
    host._executePassCommands(
      frustumCommands,
      Pass.CESIUM_3D_TILE_EDGES_DIRECT,
      scene,
      context,
      passState,
    );

    // Pass.GAUSSIAN_SPLATS stages the entire active splat prefix for later
    // translucent handling when the opt-in flag is set, OIT reports support
    // and is requested, the frame is not picking, and the first splat command
    // has an OIT pipeline. The helper's OIT decision examines only ordinary
    // Pass.TRANSLUCENT commands. When it does not encode an OIT accumulation
    // pass, it sorts and executes the staged prefix inline. Once OIT runs,
    // only staged commands with their own OIT pipeline are encoded. Splats
    // that are not staged render inline here with standard alpha blending and
    // scene-depth testing, matching WebGL. See `_splatOITDeferral` on
    // WebGPUSceneRenderer.
    {
      const splatCommands = frustumCommands.commands[Pass.GAUSSIAN_SPLATS];
      const splatCount: number = frustumCommands.indices[Pass.GAUSSIAN_SPLATS];
      const hasOITSplats =
        host._splatOITDeferral &&
        host._oit?.isSupported &&
        config.useOIT &&
        !config.picking &&
        splatCount > 0 &&
        splatCommands[0]?._oitPipeline;

      if (hasOITSplats) {
        // The translucent pass owns this staged prefix; its OIT path executes
        // only entries that carry an OIT pipeline.
        host._deferredOITSplats = {
          commands: splatCommands,
          count: splatCount,
        };
      } else {
        if (splatCount > 0) {
          // Gaussian splats use alpha accumulation, so the non-OIT path sorts
          // back to front.
          // Splats use a box-center distance metric (see
          // `backToFrontSplats` in Scene/CommandSorter.js) rather than the
          // sphere `distanceSquaredTo` used by generic translucent geometry.
          sortGaussianSplatsBackToFront(splatCommands, splatCount, scene);
        }
        host._executePassCommands(
          frustumCommands,
          Pass.GAUSSIAN_SPLATS,
          scene,
          context,
          passState,
        );
      }
    }

    // Use the actual near plane for ordinary translucent commands to avoid
    // blending artifacts.
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

    // Capture accumulated scene color before Pass.TRANSLUCENT so transmissive
    // surfaces can sample their backdrop without including their own
    // contribution. The snapshot includes splats rendered immediately above
    // but excludes splats staged for the later translucent handler, even if
    // that handler ultimately flushes them inline. The capture is a no-op
    // unless `context._sceneHasTransmission` is set, and each frustum records
    // its current backdrop.
    host._captureRefractionScene(config);

    // Pass.TRANSLUCENT uses OIT when enabled and ready.
    host._cpuPassProfiler.beginPass("translucent");
    try {
      host._executeTranslucentPass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("translucent");
    }

    // After Pass.TRANSLUCENT, refresh the reusable packed depth view when this
    // frustum has 3D Tiles classification commands and an eligible translucent
    // request. Single-sample scenes copy live scene depth before packing;
    // multisampled scenes pack sample 0 directly. Each qualifying frustum
    // overwrites the same target. Classifiers bind that texture directly, so
    // no color accumulation or composite is involved. Regular 3D Tiles
    // classification for this frustum already ran earlier in the loop, so
    // this publication cannot feed that same-frustum dispatch.
    const tcc = host._translucentTileClassification;
    const has3DTileClassification =
      (frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] ?? 0) > 0;
    if (
      !picking &&
      tcc &&
      has3DTileClassification &&
      tcc.isSupported() &&
      host._sceneFramebuffer?.colorTarget
    ) {
      // Depth capture and packing record commands on the active command
      // encoder outside the scene render pass, so end that pass first.
      const enc: GPUCommandEncoder | undefined = context._currentCommandEncoder;
      if (enc) {
        // Scan this frustum's Pass.TRANSLUCENT bucket for the capture flag.
        // `Cesium3DTile.update` sets it on tile commands whose pass is
        // `Pass.TRANSLUCENT` or `Pass.GAUSSIAN_SPLATS`. This loop does not scan
        // `Pass.GAUSSIAN_SPLATS`, so a splat-only request does not trigger
        // capture.
        //
        // The flag gates the full-texture capture; it does not select depth
        // contributors. Once any scanned command requests capture, the source
        // remains the shared post-translucent scene depth attachment. It
        // includes every command that wrote depth and cannot recover
        // translucent draws rendered without depth writes. No per-command
        // depth-only pass executes here.
        const translucentCmds = frustumCommands.commands[Pass.TRANSLUCENT];
        const translucentCount =
          (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) >>> 0;
        let flaggedCommandsPresent = false;
        for (let ti = 0; ti < translucentCount; ++ti) {
          const cmd = translucentCmds[ti] as unknown as
            | {
                depthForTranslucentClassification?: boolean;
              }
            | undefined;
          if (cmd?.depthForTranslucentClassification === true) {
            flaggedCommandsPresent = true;
            break;
          }
        }
        context.endCurrentRenderPass?.();
        const sceneDepthTex =
          host._sceneFramebuffer.colorTarget.getDepthTexture?.() ?? null;
        tcc.executeTranslucentDepthPass(
          enc,
          sceneDepthTex,
          flaggedCommandsPresent,
        );
        // Pack captured depth into a texture that classification pipelines can
        // sample. This exits internally when `_hasTranslucentDepth` is false.
        const opaqueSampleableView =
          host._sceneFramebuffer.colorTarget.getDepthSampleableView?.() ?? null;
        tcc.executePackDepth(enc, opaqueSampleableView);
        // Publish the packed view so WebGPUGroundPrimitiveRenderer can prefer
        // it to `_globeDepthView` for translucent-on-translucent
        // classification. A missing capture is published as null. The
        // renderer-owned view remains stable until its target is recreated;
        // classifiers rebuild bind groups when the source-view identity
        // changes.
        context._packedTranslucentDepthView =
          tcc.packedTranslucentDepthView ?? null;
        host._resumeScenePass(context);
      }
    }

    // Copy packed depth per frustum for pickPosition support.
    if (
      !picking &&
      config.useGlobeDepthFramebuffer &&
      host._globeDepth &&
      scene._picking
    ) {
      const pickDepth = scene._picking.getPickDepth(scene, index);
      // Pass the RGBA8 packed texture maintained by executeCopyDepth and
      // executeUpdateDepth so PickDepth can read it via buffer copy and
      // mapAsync.
      const packedDepthTex = host._globeDepth.globeDepthTexture;
      if (pickDepth && packedDepthTex) {
        pickDepth.update(context, packedDepthTex);
      }
    }
  }

  // If EDL was toggled off or every candidate was culled this frame, release
  // the full-resolution targets promptly while retaining small immutable
  // pipelines for still-live processors.
  if (!picking) {
    finalizeWebGPUPointCloudEDLFrame(
      context,
      scene._frameState?.frameNumber ?? -1,
    );
  }
}
