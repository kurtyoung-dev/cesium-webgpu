/**
 * 3D-tile pass orchestration extracted from `WebGPUSceneRenderer`.
 *
 * Moves `_execute3DTilePasses` (~277 LOC) — the most intricate pass
 * orchestration in the SceneRenderer — to a focused module.
 *
 * Three optional FBO redirects layered on top of the standard
 * `firstPasses → onAfterTileMainPass → classificationPasses` chain:
 *
 *   1. **Edge FBO redirect**: redirects
 *      `Pass.CESIUM_3D_TILE_EDGES` into the dedicated edge MRT
 *      framebuffer when `_edgeFramebuffer` is allocated and ready.
 *      The resolved edge views (`edgeColorView` / `edgeIdView` /
 *      `edgeDepthView`) get published on the context for downstream
 *      composite consumers. When edges aren't ready / no edge
 *      commands, all three context slots are nulled to prevent
 *      stale views leaking into the composite from a previous frame.
 *
 *   2. **InvertClassification FBO redirect**: when the scene has
 *      invert-classification enabled
 *      AND the invert FBO + feature-renderer cache are ready,
 *      `firstPasses` (CESIUM_3D_TILE) writes tile color into
 *      `InvertClassification.classifiedTexture` instead of the scene
 *      color attachment, and CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
 *      runs against the same FBO with stencil writes. The regular
 *      CESIUM_3D_TILE_CLASSIFICATION pass continues to run on the
 *      scene FB. Falls back to the default chain if any required
 *      resource is missing.
 *
 *   3. **Indirect-draw fast path**: controlled by the contained
 *      `never | auto | always` policy. The legacy boolean bridge maps
 *      `false → never` and `true → always`; default `false` can no longer
 *      threshold-auto-activate or allocate the manager.
 *      `executeBatchIndirect` falls back per-command for any run that
 *      doesn't satisfy its homogeneous-batch criteria, so the
 *      threshold is just a "don't bother below this point" floor.
 *
 * The `_3DTilePassesHost` interface exposes the SceneRenderer fields
 * + the `_resumeScenePass` method the orchestration body needs.
 *
 * @module WebGPUSceneRenderer3DTilePasses
 */

import Pass from "../../Renderer/Pass.js";
import {
  bindEdgePipelinesForPass,
  type EdgeRetargetableCommand,
} from "./WebGPUEdgeVisibilityEmitter.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUEdgeFramebuffer } from "./WebGPUEdgeFramebuffer.js";
import {
  buildInvertClassificationColorAttachment,
  buildInvertClassificationDepthStencilAttachment,
  isInvertClassificationReady,
  getInvertClassificationSampleCount,
} from "./WebGPUInvertClassification.js";
import {
  prepareWebGPUPointCloudEDLCommands,
  renderWebGPUPointCloudEDLCommands,
} from "./WebGPUPointCloudEyeDomeLighting.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import {
  executeBatch,
  executeBatchIndirect,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * The SceneRenderer surface that the extracted 3D-tile-passes
 * orchestration reaches back to. Visibility-flipped fields and the
 * `_resumeScenePass` method on the SceneRenderer satisfy this
 * contract.
 */
export interface _3DTilePassesHost {
  _edgeFramebuffer: WebGPUEdgeFramebuffer | null;
  _edgeTexturesPopulated: boolean;
  _invertClassStencilReady: boolean;
  _width: number;
  _height: number;
  _tileIndirectStatus: TileIndirectStatus;
  _tileIndirectStatusFrame: number;
  _currentFrustumIndex: number;
  _resumeScenePass(context: WebGPUContext): void;
}

export type TileIndirectMode = "never" | "auto" | "always";

export interface TileIndirectStatus {
  requestedMode: TileIndirectMode;
  requested: boolean;
  capable: boolean;
  active: boolean;
  fallbackReason: string | null;
}

/**
 * Indirect-draw fast path threshold used only by the explicit `auto`
 * characterization mode. `executeBatchIndirect` falls back per-command
 * for runs that don't satisfy its homogeneous-batch criteria, so this is
 * a "don't bother below this count" floor rather than a strict gate.
 */
const INDIRECT_BATCH_MIN = 32;

/**
 * Normalize the internal tri-state policy while preserving the legacy boolean
 * bridge. Unknown values fail closed.
 */
export function normalizeTileIndirectMode(value: unknown): TileIndirectMode {
  if (value === true) return "always";
  if (value === "auto" || value === "always") return value;
  return "never";
}

/**
 * Resolve one pass's indirect policy. The `never` path deliberately does not
 * touch `indirectDrawManager`, whose context getter allocates GPU resources.
 */
export function resolveTileIndirectPolicy(
  context: WebGPUContext,
  commandCount: number,
): TileIndirectStatus {
  const requestedMode = normalizeTileIndirectMode(
    (context as unknown as { useIndirectDrawForTiles?: unknown })
      .useIndirectDrawForTiles,
  );
  const requested = requestedMode !== "never";
  const hasRenderPass = !!context.currentRenderPassEncoder;
  const capable = !!context.device;

  if (!requested) {
    return {
      requestedMode,
      requested: false,
      capable,
      active: false,
      fallbackReason: "not-requested",
    };
  }

  if (!capable) {
    return {
      requestedMode,
      requested: true,
      capable: false,
      active: false,
      fallbackReason: "unsupported",
    };
  }

  const thresholdReached =
    requestedMode === "always" || commandCount >= INDIRECT_BATCH_MIN;
  if (!thresholdReached) {
    return {
      requestedMode,
      requested: true,
      capable: true,
      active: false,
      fallbackReason: "below-threshold",
    };
  }

  if (!hasRenderPass) {
    return {
      requestedMode,
      requested: true,
      capable: true,
      active: false,
      fallbackReason: "no-active-render-pass",
    };
  }

  const active = !!context.indirectDrawManager;
  return {
    requestedMode,
    requested: true,
    capable: true,
    active,
    fallbackReason: active ? null : "manager-unavailable",
  };
}

/**
 * Run the 3D-tile pass chain for a single frustum. Mirrors the WebGL
 * `SceneRenderer.js:506-600` orchestration (edge MRT redirect +
 * invert-classification redirect + main + classification chain).
 *
 * @param host - The owning SceneRenderer (or any
 *   {@link _3DTilePassesHost}).
 * @param frustumCommands - Per-frustum command list bucket.
 * @param config - Render-frame config from `executeCommands`.
 * @param onAfterTileMainPass - Optional hook fired between the
 *   CESIUM_3D_TILE main pass and the CESIUM_3D_TILE_CLASSIFICATION
 *   passes. WebGL calls `globeDepth.executeUpdateDepth` here so
 *   classification reads tile-augmented depth.
 */
export function execute3DTilePasses(
  host: _3DTilePassesHost,
  frustumCommands: CesiumFrustumCommands,
  config: WebGPURenderFrameConfig,
  onAfterTileMainPass?: () => void,
): void {
  const { scene, context, passState } = config;
  const frameNumber = scene?._frameState?.frameNumber ?? -1;
  if (host._tileIndirectStatusFrame !== frameNumber) {
    const requestedMode = normalizeTileIndirectMode(
      (context as unknown as { useIndirectDrawForTiles?: unknown })
        .useIndirectDrawForTiles,
    );
    host._tileIndirectStatusFrame = frameNumber;
    const status = host._tileIndirectStatus;
    status.requestedMode = requestedMode;
    status.requested = requestedMode !== "never";
    status.capable = !!context.device;
    status.active = false;
    status.fallbackReason =
      requestedMode === "never" ? "not-requested" : "no-tile-commands";
  }
  // Passes are split so `onAfterTileMainPass` can
  // run between `CESIUM_3D_TILE` and `CESIUM_3D_TILE_CLASSIFICATION`.
  // WebGL's `SceneRenderer.js:544-560` calls `globeDepth.executeUpdateDepth`
  // at that hook so tile classification reads the updated globe depth
  // (now including 3D-tile contributions), not the pre-tile terrain-only
  // depth. Without it, overlay / decal / classification primitives
  // Z-fight against 3D tile surfaces.
  // CESIUM_3D_TILE_EDGES is pulled out of
  // `firstPasses` so it can route to the dedicated edge MRT
  // framebuffer (separate color format, separate stencil reset,
  // separate clear semantics). The main-tile pass (CESIUM_3D_TILE)
  // continues in `firstPasses`. Edges run FIRST (matching WebGL's
  // `SceneRenderer.js:506` which calls `performCesium3DTileEdgesPass`
  // before OPAQUE — the edge textures are sampled by later passes).
  const firstPasses = [Pass.CESIUM_3D_TILE];
  const classificationPasses = [
    Pass.CESIUM_3D_TILE_CLASSIFICATION,
    Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
  ];
  // A full-screen depth pack plus scene-pass reopen is only required when the
  // main tile pass actually wrote depth.
  const hasTileMainCommands =
    (frustumCommands.indices[Pass.CESIUM_3D_TILE] ?? 0) > 0;
  // When the scene has
  // invert-classification enabled, `firstPasses` must write tile
  // color into `InvertClassification.classifiedTexture` instead of
  // the scene color attachment. The final composite (dispatched
  // after the scene pass ends in `_runInvertClassificationComposite`)
  // pulls those tile pixels back onto scene color, optionally tinted
  // by `invertClassificationColor`. Mirrors WebGL's
  // `SceneRenderer.js:563-600`.
  //
  // Falls back to the default path when:
  //  - `useInvertClassification` is false (most frames)
  //  - `scene._invertClassification` isn't initialized
  //  - The invert feature-renderer cache isn't ready (first frame
  //    after enable, pre-`FramebufferOrchestrator.update`)
  const invertOwner = (
    scene as unknown as {
      _invertClassification?: CesiumObjectWithWebGPUCache;
    }
  )._invertClassification;
  const redirectToInvertFBO =
    !!config.useInvertClassification &&
    !!invertOwner &&
    isInvertClassificationReady(invertOwner);
  // Default `false` maps to `never`; only explicit `auto` or
  // `always` may allocate/access the indirect manager.
  const runPass = (passIndex: number): void => {
    const cmds = frustumCommands.commands[passIndex];
    const cnt: number = frustumCommands.indices[passIndex];
    if (cnt > 0) {
      context.uniformState?.updatePass(passIndex);
      if (host._tileIndirectStatus.requestedMode === "never") {
        executeBatch(cmds, cnt, scene, context, passState);
        return;
      }
      const policy = resolveTileIndirectPolicy(context, cnt);
      const status = host._tileIndirectStatus;
      status.requestedMode = policy.requestedMode;
      status.requested = policy.requested;
      status.capable ||= policy.capable;
      status.active ||= policy.active;
      status.fallbackReason = status.active ? null : policy.fallbackReason;
      if (policy.active) {
        executeBatchIndirect(cmds, cnt, scene, context, passState);
      } else {
        executeBatch(cmds, cnt, scene, context, passState);
      }
    }
  };

  const tileCommands = frustumCommands.commands[Pass.CESIUM_3D_TILE];
  const tileCount: number = frustumCommands.indices[Pass.CESIUM_3D_TILE] ?? 0;
  const sceneTargetIdentity = context as unknown as object;
  const sceneSampleCount = context._msaaSamples ?? 1;
  const sceneTargetCount = isSceneFBMrtMode() ? 2 : 1;

  /** Run tile-main into the ordinary scene target, with frustum-local EDL. */
  const runSceneTileMain = (): void => {
    const edlCount = config.picking
      ? 0
      : prepareWebGPUPointCloudEDLCommands(
          context,
          scene._frameState,
          tileCommands,
          tileCount,
          Pass.CESIUM_3D_TILE,
          host._currentFrustumIndex,
          "scene",
          sceneTargetIdentity,
          context.scenePipelineFormat,
          sceneSampleCount,
          sceneTargetCount,
        );
    for (const passIndex of firstPasses) {
      runPass(passIndex);
    }
    if (edlCount > 0) {
      renderWebGPUPointCloudEDLCommands(
        context,
        scene._frameState,
        tileCommands,
        tileCount,
        Pass.CESIUM_3D_TILE,
        host._currentFrustumIndex,
        "scene",
        sceneTargetIdentity,
        context.scenePipelineFormat,
        sceneSampleCount,
        sceneTargetCount,
        () => {
          host._resumeScenePass(context);
          return context._currentRenderPassEncoder ?? null;
        },
      );
    }
  };
  // Edges pass. Redirects
  // `Pass.CESIUM_3D_TILE_EDGES` into the dedicated edge MRT
  // framebuffer when the scene has edge visibility enabled. Mirrors
  // WebGL's `SceneRenderer.js:242-278 performCesium3DTileEdgesPass`.
  // When the FBO isn't allocated (no `_enableEdgeVisibility`) or
  // there are no edge commands, this runs as a plain pass on the
  // scene framebuffer — matches the WebGL path which also only
  // redirects when `_enableEdgeVisibility && view.edgeFramebuffer`.
  const edgeCommandCount = frustumCommands.indices[Pass.CESIUM_3D_TILE_EDGES];
  const edgeFB = host._edgeFramebuffer;
  const redirectEdgesToFBO = edgeCommandCount > 0 && !!edgeFB && edgeFB.isReady;
  if (redirectEdgesToFBO && edgeFB) {
    context.endCurrentRenderPass?.();
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (encoder) {
      const edgePass = context.beginRenderPass?.({
        label: `EdgeFramebuffer tile-edges pass (${edgeFB.sampleCount}x)`,
        colorAttachments: edgeFB.buildColorAttachments(),
        depthStencilAttachment: edgeFB.buildDepthStencilAttachment(),
      });
      if (edgePass) {
        edgePass.setViewport(0, 0, host._width, host._height, 0, 1);
        edgePass.setScissorRect(0, 0, host._width, host._height);
        // The MRT pass is now open: bind the three-target variant on every
        // emitter command before any of them records a draw.
        bindEdgePipelinesForPass(
          // Every command in the edges pass is an edge command; the emitter's
          // variants are optional on it and the binder skips commands without them.
          frustumCommands.commands[Pass.CESIUM_3D_TILE_EDGES] as ReadonlyArray<
            EdgeRetargetableCommand | undefined
          >,
          edgeCommandCount,
          true,
        );
        runPass(Pass.CESIUM_3D_TILE_EDGES);
        context.endCurrentRenderPass?.();
      }
    }
    host._resumeScenePass(context);

    // Expose the resolved edge textures on the context for the
    // composite consumer (`_runEdgeComposite`) to pick up. Matches
    // WebGL's `uniformState.edgeColorTexture = ...` assignment at
    // `SceneRenderer.js:513-533`.
    context._edgeColorView = edgeFB.colorSampleableView ?? null;
    context._edgeIdView = edgeFB.idSampleableView ?? null;
    context._edgeDepthView = edgeFB.depthSampleableView ?? null;
    host._edgeTexturesPopulated = true;
  } else if (edgeCommandCount > 0) {
    // Edges present but FBO isn't ready (scene just enabled
    // `_enableEdgeVisibility` this frame, or allocation raced with
    // resize). Run on the current scene target — visually equivalent
    // to the plain, non-redirected pass; no edge textures are populated.
    bindEdgePipelinesForPass(
      // Every command in the edges pass is an edge command; the emitter's
      // variants are optional on it and the binder skips commands without them.
      frustumCommands.commands[Pass.CESIUM_3D_TILE_EDGES] as ReadonlyArray<
        EdgeRetargetableCommand | undefined
      >,
      edgeCommandCount,
      false,
    );
    runPass(Pass.CESIUM_3D_TILE_EDGES);
    context._edgeColorView = null;
    context._edgeIdView = null;
    context._edgeDepthView = null;
    host._edgeTexturesPopulated = false;
  } else {
    // No edge commands this frame — clear the context slots so a
    // stale view from a previous frame doesn't leak into the
    // composite (which gates on `_edgeTexturesPopulated`).
    context._edgeColorView = null;
    context._edgeIdView = null;
    context._edgeDepthView = null;
    host._edgeTexturesPopulated = false;
  }

  // `CESIUM_3D_TILE_EDGES_DIRECT`
  // (Pass slot 12, EDGES_ONLY CAD wireframe) is deliberately not run
  // in this module. The MRT block above handles `CESIUM_3D_TILE_EDGES`
  // (slot 4) only — slot 12 is a distinct, non-redirected pass that
  // draws straight onto the scene framebuffer on top of opaque
  // surfaces. WebGL dispatches it from `performCesium3DTileEdgesDirectPass`
  // after `performPass(Pass.OPAQUE)` (`SceneRenderer.js:663-666`), not
  // inside the 3D-tile chain (which runs before opaque). Running it here
  // would (a) z-occlude later opaque models against edge depth and
  // (b) double-render against the post-opaque dispatch. The slot-12
  // execution therefore lives in `WebGPUSceneRendererFrustumLoop` right
  // after the OPAQUE pass via `host._executePassCommands(..., slot 12, ...)`.
  // This note prevents a future "slot 12 is binned but never executed
  // here" mis-fix from adding a duplicate dispatch inside the tile chain.

  // Track whether the stencil-gated composite can run. Set to true
  // once the CLASSIFICATION_IGNORE_SHOW pass actually ran inside the
  // invert FBO (writing stencil bits). If false, the composite falls
  // back to the single-pass tint.
  let invertHasStencilData = false;

  if (redirectToInvertFBO && invertOwner) {
    // End the default scene render pass so the invert pass can open.
    context.endCurrentRenderPass?.();

    const colorAttachment =
      buildInvertClassificationColorAttachment(invertOwner);
    // Use the invert FBO's own
    // depth-stencil texture (not scene depth). Tile depth writes now
    // land in the invert FBO; the classification-ignore-show pass
    // tests against that depth and writes stencil bits. This matches
    // WebGL's `SceneRenderer.js:567` which sets
    // `passState.framebuffer = scene._invertClassification._fbo.framebuffer`
    // whose attached depth-stencil texture is distinct from the
    // scene's depth.
    const depthAttachment = buildInvertClassificationDepthStencilAttachment(
      invertOwner,
      "clear",
      "clear",
    );
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;

    if (encoder && colorAttachment && depthAttachment) {
      const invertSamples = getInvertClassificationSampleCount(invertOwner);
      const invertFormat =
        (
          invertOwner._webgpuCache as
            { colorFormat?: GPUTextureFormat } | undefined
        )?.colorFormat ?? context.scenePipelineFormat;
      const invertTargetIdentity = invertOwner as unknown as object;

      // Pass 1: tile main passes (EDGES + CESIUM_3D_TILE) into invert
      // FBO (color + depth + stencil all clear).
      const tilePassDesc: GPURenderPassDescriptor = {
        label: `InvertClassification tile pass (${invertSamples}x)`,
        colorAttachments: [colorAttachment],
        depthStencilAttachment: depthAttachment,
      };
      const tilePass = context.beginRenderPass?.(tilePassDesc);
      if (tilePass) {
        tilePass.setViewport(0, 0, host._width, host._height, 0, 1);
        tilePass.setScissorRect(0, 0, host._width, host._height);
        const invertEDLCount = config.picking
          ? 0
          : prepareWebGPUPointCloudEDLCommands(
              context,
              scene._frameState,
              tileCommands,
              tileCount,
              Pass.CESIUM_3D_TILE,
              host._currentFrustumIndex,
              "invert",
              invertTargetIdentity,
              invertFormat,
              invertSamples,
              1,
            );
        for (const passIndex of firstPasses) {
          runPass(passIndex);
        }
        context.endCurrentRenderPass?.();
        if (invertEDLCount > 0) {
          renderWebGPUPointCloudEDLCommands(
            context,
            scene._frameState,
            tileCommands,
            tileCount,
            Pass.CESIUM_3D_TILE,
            host._currentFrustumIndex,
            "invert",
            invertTargetIdentity,
            invertFormat,
            invertSamples,
            1,
            () => {
              const edlColor =
                buildInvertClassificationColorAttachment(invertOwner);
              const edlDepth = buildInvertClassificationDepthStencilAttachment(
                invertOwner,
                "load",
                "load",
              );
              if (!edlColor || !edlDepth) {
                return null;
              }
              edlColor.loadOp = "load";
              const edlTargetPass = context.beginRenderPass?.({
                label: `InvertClassification EDL composite (${invertSamples}x)`,
                colorAttachments: [edlColor],
                depthStencilAttachment: edlDepth,
              });
              edlTargetPass?.setViewport(0, 0, host._width, host._height, 0, 1);
              edlTargetPass?.setScissorRect(0, 0, host._width, host._height);
              return edlTargetPass ?? null;
            },
          );
          // Classification and globe-depth publication consume the invert
          // target only after the point EDL composite has published its exact
          // device depth and 3D-tile stencil bit.
          context.endCurrentRenderPass?.();
        }
      }

      // Depth update hook runs between the tile
      // main pass and the classification passes. It reads depth from
      // the scene framebuffer currently, not the invert FBO's depth;
      // globe-depth should sample the invert FBO's depth instead when
      // invert-on. Until that's wired, downstream ground/overlay primitives
      // may still Z-fight against tiles when invert is on.
      if (hasTileMainCommands && onAfterTileMainPass) {
        onAfterTileMainPass();
      }

      // Pass 2: CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW redirected
      // into invert FBO (loadOp=load for both color and depth so tile
      // contributions are preserved; stencil is loaded too — starts
      // at 0 from Pass 1's clear, classification primitives will write
      // stencil bits here). The regular CESIUM_3D_TILE_CLASSIFICATION
      // pass continues to run on the scene FB (below).
      const ignoreShowColor =
        buildInvertClassificationColorAttachment(invertOwner);
      const ignoreShowDepth = buildInvertClassificationDepthStencilAttachment(
        invertOwner,
        "load",
        "load",
      );
      // Override loadOp on the color — we want to preserve tile color
      // (not clear it) so the composite still sees the tiles.
      if (ignoreShowColor) {
        ignoreShowColor.loadOp = "load";
      }
      if (ignoreShowColor && ignoreShowDepth) {
        const ignoreShowDesc: GPURenderPassDescriptor = {
          label: `InvertClassification ignore-show pass (${invertSamples}x)`,
          colorAttachments: [ignoreShowColor],
          depthStencilAttachment: ignoreShowDepth,
        };
        const ignoreShowPass = context.beginRenderPass?.(ignoreShowDesc);
        if (ignoreShowPass) {
          ignoreShowPass.setViewport(0, 0, host._width, host._height, 0, 1);
          ignoreShowPass.setScissorRect(0, 0, host._width, host._height);
          runPass(Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW);
          context.endCurrentRenderPass?.();
          // All four depth-sample classifier renderers
          // emit dedicated IGNORE_SHOW stencil-write commands for 3D-Tile
          // classification:
          //   - `WebGPUGroundPrimitiveRenderer.js`
          //   - `WebGPUGroundPolylineRenderer.js`
          //   - `WebGPUVector3DTilePrimitiveRenderer.js`
          //   - `WebGPUVector3DTileClampedPolylinesRenderer.js`
          // Each pushes a `pass = 7` stencil-write command alongside its
          // color command (gated on `frameState.invertClassification` at
          // each renderer's dispatch site). The stencil-write pipeline has
          // `writeMask: 0` on the color target and `passOp: replace` with
          // `stencilReference: 0xff` so every classified-surface pixel the
          // volume covers marks the invert FBO's stencil. The composite
          // (`WebGPUInvertClassification.classifiedPipeline` /
          // `unclassifiedPipeline`) then reads those bits to gate which
          // tile pixels get the invert tint.
          const ignoreShowCount =
            frustumCommands.indices[
              Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
            ] ?? 0;
          if (ignoreShowCount > 0) {
            invertHasStencilData = true;
          }
        }
      }

      // Resume scene pass for the normal CLASSIFICATION pass which
      // runs on scene color (regular behavior, not redirected).
      host._resumeScenePass(context);
      runPass(Pass.CESIUM_3D_TILE_CLASSIFICATION);
    } else {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[WebGPU:SceneRenderer] InvertClassification FBO redirect ` +
          `missing resources — encoder=${!!encoder} ` +
          `colorAttachment=${!!colorAttachment} ` +
          `depthAttachment=${!!depthAttachment}. Falling back to ` +
          `default tile pass.`,
      );
      //>>includeEnd('debug');
      host._resumeScenePass(context);
      runSceneTileMain();
      if (hasTileMainCommands && onAfterTileMainPass) {
        onAfterTileMainPass();
      }
      for (const passIndex of classificationPasses) {
        runPass(passIndex);
      }
    }
  } else {
    runSceneTileMain();
    // Depth update hook. Fires after the main 3D tile
    // pass so classification can read tile-augmented depth.
    if (hasTileMainCommands && onAfterTileMainPass) {
      onAfterTileMainPass();
    }
    for (const passIndex of classificationPasses) {
      runPass(passIndex);
    }
  }

  // Stash the stencil-readiness flag for the end-of-scene composite.
  // Using a per-frame slot on the renderer (not on `config`) because
  // `config` is a plain struct, and multi-frustum rendering may reach
  // this method more than once per frame — we want `true` if ANY
  // frustum produced stencil data.
  if (invertHasStencilData) {
    host._invertClassStencilReady = true;
  }
}
