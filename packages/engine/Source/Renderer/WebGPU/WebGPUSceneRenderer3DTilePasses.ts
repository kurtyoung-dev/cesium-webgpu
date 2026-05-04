/**
 * 3D-tile pass orchestration extracted from `WebGPUSceneRenderer`.
 *
 * Batch 137 of the audit-recommended SceneRenderer decomposition.
 * Moves `_execute3DTilePasses` (~277 LOC) — the most intricate pass
 * orchestration in the SceneRenderer — to a focused module.
 *
 * Three optional FBO redirects layered on top of the standard
 * `firstPasses → onAfterTileMainPass → classificationPasses` chain:
 *
 *   1. **Edge FBO redirect** (C-R8-EDGE-FBO, Batch 44): redirects
 *      `Pass.CESIUM_3D_TILE_EDGES` into the dedicated edge MRT
 *      framebuffer when `_edgeFramebuffer` is allocated and ready.
 *      The resolved edge views (`edgeColorView` / `edgeIdView` /
 *      `edgeDepthView`) get published on the context for downstream
 *      composite consumers. When edges aren't ready / no edge
 *      commands, all three context slots are nulled to prevent
 *      stale views leaking into the composite from a previous frame.
 *
 *   2. **InvertClassification FBO redirect** (C-R8-INVERT-CLASS-FBO-REDIRECT,
 *      Batch 39): when the scene has invert-classification enabled
 *      AND the invert FBO + feature-renderer cache are ready,
 *      `firstPasses` (CESIUM_3D_TILE) writes tile color into
 *      `InvertClassification.classifiedTexture` instead of the scene
 *      color attachment, and CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
 *      runs against the same FBO with stencil writes. The regular
 *      CESIUM_3D_TILE_CLASSIFICATION pass continues to run on the
 *      scene FB. Falls back to the default chain if any required
 *      resource is missing.
 *
 *   3. **Indirect-draw fast path**: when
 *      `context.useIndirectDrawForTiles === true` OR the per-pass
 *      command count >= INDIRECT_BATCH_MIN (32), `runPass` dispatches
 *      via `executeBatchIndirect` instead of `executeBatch`.
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
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUEdgeFramebuffer } from "./WebGPUEdgeFramebuffer.js";
import {
  buildInvertClassificationColorAttachment,
  buildInvertClassificationDepthStencilAttachment,
  isInvertClassificationReady,
  getInvertClassificationSampleCount,
} from "./WebGPUInvertClassification.js";
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
  _resumeScenePass(context: WebGPUContext): void;
}

/**
 * Indirect-draw fast path threshold. Activated automatically when a
 * pass has at least this many tile commands. `executeBatchIndirect`
 * falls back per-command for runs that don't satisfy its homogeneous-
 * batch criteria, so this is a "don't bother below this count" floor
 * rather than a strict gate.
 */
const INDIRECT_BATCH_MIN = 32;

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
 *   classification reads tile-augmented depth (Batch 35 / C-R8).
 */
export function execute3DTilePasses(
  host: _3DTilePassesHost,
  frustumCommands: CesiumFrustumCommands,
  config: WebGPURenderFrameConfig,
  onAfterTileMainPass?: () => void,
): void {
  const { scene, context, passState } = config;
  // C-R8 (Batch 35) — passes are split so `onAfterTileMainPass` can
  // run between `CESIUM_3D_TILE` and `CESIUM_3D_TILE_CLASSIFICATION`.
  // WebGL's `SceneRenderer.js:544-560` calls `globeDepth.executeUpdateDepth`
  // at that hook so tile classification reads the updated globe depth
  // (now including 3D-tile contributions), not the pre-tile terrain-only
  // depth. Without it, overlay / decal / classification primitives
  // Z-fight against 3D tile surfaces.
  // C-R8-EDGE-FBO (Batch 44) — CESIUM_3D_TILE_EDGES is pulled out of
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

  // C-R8-INVERT-CLASS-FBO-REDIRECT (Batch 39) — When the scene has
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
  // Indirect-draw fast path. Activated automatically when a pass has
  // enough tile commands for batching to pay off (INDIRECT_BATCH_MIN).
  // Users can force on via `context.useIndirectDrawForTiles = true`
  // for testing / profiling, or force off by leaving the flag at its
  // default (auto mode still applies unless disabled explicitly).
  //
  // `executeBatchIndirect` falls back per-command for any run that
  // doesn't satisfy its homogeneous-batch criteria, so enabling this
  // on small counts is safe (just wasted overhead), which is why we
  // gate on count rather than a hard opt-in.
  const hasIndirectInfra =
    !!context.indirectDrawManager && !!context.currentRenderPassEncoder;
  const explicitlyEnabled = context.useIndirectDrawForTiles === true;
  const runPass = (passIndex: number): void => {
    const cmds = frustumCommands.commands[passIndex];
    const cnt: number = frustumCommands.indices[passIndex];
    if (cnt > 0) {
      context.uniformState?.updatePass(passIndex);
      const useIndirect =
        hasIndirectInfra && (explicitlyEnabled || cnt >= INDIRECT_BATCH_MIN);
      if (useIndirect) {
        executeBatchIndirect(cmds, cnt, scene, context, passState);
      } else {
        executeBatch(cmds, cnt, scene, context, passState);
      }
    }
  };
  // C-R8-EDGE-FBO (Batch 44) — Edges pass. Redirects
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
    // to the pre-Batch-44 path; no edge textures are populated.
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

  // Track whether the stencil-gated composite can run. Set to true
  // once the CLASSIFICATION_IGNORE_SHOW pass actually ran inside the
  // invert FBO (writing stencil bits). If false, the composite falls
  // back to the single-pass tint (Batch 39 behavior).
  let invertHasStencilData = false;

  if (redirectToInvertFBO && invertOwner) {
    // End the default scene render pass so the invert pass can open.
    context.endCurrentRenderPass?.();

    const colorAttachment =
      buildInvertClassificationColorAttachment(invertOwner);
    // C-R8-INVERT-CLASS-STENCIL (Batch 40) — use the invert FBO's own
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
        for (const passIndex of firstPasses) {
          runPass(passIndex);
        }
        context.endCurrentRenderPass?.();
      }

      // C-R8 (Batch 35) — depth update hook runs BETWEEN the tile
      // main pass and the classification passes. It reads depth from
      // the scene framebuffer currently, not the invert FBO's depth;
      // tracked as `C-R8-INVERT-DEPTH-SOURCE` that for invert-on,
      // globe-depth should sample the invert FBO's depth instead.
      // Until that's wired, downstream ground/overlay primitives
      // may still Z-fight against tiles when invert is on.
      if (onAfterTileMainPass) {
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
          // AUDIT_2026_05_02 A.2 — be honest about whether stencil
          // bits were actually written. Two preconditions must hold:
          //
          //   (1) IGNORE_SHOW commands actually existed for this
          //       frustum (count > 0). Pre-fix this was assumed.
          //
          //   (2) Those commands' pipelines write stencil. Post-
          //       ADR-2026-04-28 the depth-sample classifier
          //       architecture (see `WebGPUGroundPrimitiveRenderer.js`,
          //       `WebGPUVector3DTilePrimitiveRenderer.js`, etc.)
          //       collapses three classifier passes into one and
          //       no longer emits stencil-write commands. So even
          //       if classifier renderers DID emit IGNORE_SHOW
          //       commands today (they don't), the redirected pass
          //       wouldn't actually mark the stencil buffer.
          //
          // Net effect: this flag stays false on WebGPU until a
          // stencil-write classifier variant lands
          // (NEW-INVERT-CLASS-STENCIL-CLASSIFIER, DEFERRED_WORK).
          // The composite then takes the single-pass-tint fallback,
          // which matches WebGL's "no classification primitives"
          // case — every tile pixel gets tinted by `highlightColor`.
          // For scenes that DO have classification primitives, the
          // per-pixel mask is missing, so classified regions also
          // get tinted (visible regression vs WebGL — surfaced via
          // the one-time warning below).
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
      for (const passIndex of firstPasses) {
        runPass(passIndex);
      }
      if (onAfterTileMainPass) {
        onAfterTileMainPass();
      }
      for (const passIndex of classificationPasses) {
        runPass(passIndex);
      }
    }
  } else {
    for (const passIndex of firstPasses) {
      runPass(passIndex);
    }
    // C-R8 (Batch 35) — depth update hook. Fires after the main 3D tile
    // pass so classification can read tile-augmented depth.
    if (onAfterTileMainPass) {
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
