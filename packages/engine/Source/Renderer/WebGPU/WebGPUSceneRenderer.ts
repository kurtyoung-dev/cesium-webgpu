/// <reference types="@webgpu/types" />
/**
 * WebGPU Scene Renderer — Multi-frustum command execution orchestrator
 *
 * This is the WebGPU equivalent of the `executeCommands()` function in Scene.js.
 * It owns and manages all scene-level rendering resources:
 *   - WebGPUSceneFramebuffer (main color + depth + ID render targets)
 *   - WebGPUOIT (order-independent transparency)
 *   - WebGPUGlobeDepth (globe depth framebuffer for picking/clamping)
 *   - WebGPUDepthPlane (depth-only quad at ellipsoid surface)
 *   - WebGPUPostProcessPipeline (tonemapping, FXAA, custom effects)
 *
 * Derived-command variants (pick / depth-only / log-depth / velocity) are
 * produced by the centralized `WebGPUDerivedCommand` factory at the
 * renderer layer and dispatched here via `selectCommandVariant`.
 *
 * For each frustum (far to near):
 *   1. Update uniform state with frustum near/far
 *   2. Clear depth/stencil (per-frustum, preserving color)
 *   3. Execute GLOBE pass commands → GlobeDepth framebuffer
 *   4. Copy depth for shader access
 *   5. Execute TERRAIN_CLASSIFICATION pass
 *   6. Execute CESIUM_3D_TILE* passes
 *   7. Execute OPAQUE pass → main framebuffer
 *   8. Execute TRANSLUCENT pass → OIT framebuffer
 *   9. OIT composite over opaque
 *   10. Execute VOXELS, GAUSSIAN_SPLATS
 *
 * After frustum loop:
 *   - Execute OVERLAY pass (once)
 *   - Render depth plane (if enabled)
 *   - Run post-processing pipeline (if enabled)
 *
 * @private
 */

import Pass from "../../Renderer/Pass.js";
import {
  DEFAULT_COMMAND_MATERIAL_SORT_ID,
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  getCommandDistanceSquaredForSort,
  isCommandOrderingGPUEncodable,
  normalizeCommandOrderingList,
  normalizeCommandMaterialSortId,
  normalizeCommandSortByte,
} from "../../Renderer/CommandOrdering.js";
import {
  backToFront as _commandSorterBackToFront,
  backToFrontSplats as _commandSorterBackToFrontSplats,
  frontToBack as _commandSorterFrontToBack,
} from "../../Scene/CommandSorter.js";
import { applySceneAtmosphereDerivedLighting } from "../../Scene/AtmosphereDerivedLighting.js";
import FeatureRendererKey from "../FeatureRendererKey.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import { WebGPUEdgeFramebuffer } from "./WebGPUEdgeFramebuffer.js";
import { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";
// Model edges composite inline inside `ModelPBRComplete.wgsl` through
// `applyEdgeOverlay()`, where the full per-feature gates are visible.
// Primitive shaders do not emit edge commands. A producer that adds a
// `Pass.CESIUM_3D_TILE_EDGES` command must either extend the inline stage to
// its shader family or restore a post-process composite for that pass.
import { WebGPUOIT } from "./WebGPUOIT.js";
import { WebGPUClusteredLightingDispatcher } from "./WebGPUClusteredLightingDispatcher.js";
import { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import {
  WebGPUDepthPlane,
  type WebGPUDepthPlanePassKind,
} from "./WebGPUDepthPlane.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { applyProjectionJitterToScratch } from "./WebGPUTAAEffect.js";
import { dispatchGBufferNormalsFromDepth } from "./WebGPUGBufferRenderer.js";
import type { GBufferComputeHost } from "./WebGPUGBufferRenderer.js";
import { WebGPUDebugDepthOverlay } from "./WebGPUDebugDepthOverlay.js";
import { WebGPUDebugGBufferOverlay } from "./WebGPUDebugGBufferOverlay.js";
import { WebGPUDebugFrustumOverlay } from "./WebGPUDebugFrustumOverlay.js";
import { WebGPUBoundingVolumeDebugPass } from "./WebGPUBoundingVolumeDebugPass.js";
import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";
import { executePickPass } from "./WebGPUSceneRendererPickPass.js";
import { executeEnvironmentalEffects } from "./WebGPUSceneRendererEnvironmentalEffects.js";
import { shouldExecuteWebGPUSceneFrame } from "./WebGPUSceneRendererEnvironmentDemand.js";
import {
  dispatchClusteredLighting,
  getClusteredLightingBuffers,
  type ClusteredLightingBuffers,
} from "./WebGPUSceneRendererClusteredLighting.js";
import { executeGlobeDispatch } from "./WebGPUSceneRendererGlobePass.js";
import { executeTranslucentPass } from "./WebGPUSceneRendererTranslucentPass.js";
import {
  execute3DTilePasses,
  type TileIndirectStatus,
} from "./WebGPUSceneRenderer3DTilePasses.js";
import {
  setupSceneFramebufferRenderPass,
  buildMrtSlot1Attachment,
} from "./WebGPUSceneRendererPassRedirect.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import { resetPerFrameState } from "./WebGPUSceneRendererFrameReset.js";
import { executeFrustumLoop } from "./WebGPUSceneRendererFrustumLoop.js";
import { executePostFrustumChain } from "./WebGPUSceneRendererPostFrustumChain.js";
import {
  ensureDepthPlane,
  ensureResources,
} from "./WebGPUSceneRendererEnsureResources.js";
import {
  WebGPUCpuPassProfiler,
  type CpuPassProfile,
  type CpuScenePhaseName,
} from "./WebGPUCpuPassProfiler.js";
import {
  buildInvertClassificationColorAttachment,
  buildInvertClassificationDepthStencilAttachment,
  isInvertClassificationReady,
  executeInvertClassificationComposite,
  getInvertClassificationSampleCount,
  getInvertClassificationDepthTexture,
} from "./WebGPUInvertClassification.js";

/**
 * Configuration for a single frame's rendering.
 */
export interface WebGPURenderFrameConfig {
  scene: CesiumScene;
  context: WebGPUContext;
  passState: CesiumPassState;
  backgroundColor: { red: number; green: number; blue: number; alpha: number };
  picking: boolean;
  useGlobeDepthFramebuffer: boolean;
  clearGlobeDepth: boolean;
  useOIT: boolean;
  useDepthPlane: boolean;
  useInvertClassification: boolean;
  usePostProcess?: boolean;
  useHDR?: boolean;
  shadowState?: CesiumFrameState["shadowState"];
  // Scene 2D infinite-scroll wrapping.
  // `execute2DViewportCommands` (ViewportExecutor.js) renders the 2D map in
  // two viewport halves through two `executeCommands` calls per frame, each with
  // its own off-center frustum + `passState.viewport` sub-rect. WebGL
  // accumulates both halves into one framebuffer (clear on the first half
  // only). The WebGPU renderer mirrors that by accumulating both halves into
  // the scene framebuffer and blitting once:
  //   - `sceneFbLoad`: when true, open the scene-FB pass with color
  //     loadOp="load" (preserve the first half) instead of "clear". Set on the
  //     second half. Undefined/false means clear for a single-pass frame.
  //   - `deferComposite`: when true, skip the post-frustum chain (env effects,
  //     composite, velocity, post-process blit) and the performance-manager
  //     endFrame so the first half just accumulates into the scene FB. Set on
  //     the first half of a split. The second (or single) pass runs the chain,
  //     which blits the fully-accumulated scene FB once.
  // The performance-manager beginFrame is correspondingly skipped on the
  // second half. CPU pass accounting is owned by the outer Scene frame, so
  // both viewport halves naturally accumulate into one logical sample.
  sceneFbLoad?: boolean;
  deferComposite?: boolean;
}

// --------------- Module-level helpers ---------------

// A module-level weak map keeps warning state per context without adding
// ad-hoc properties or `as any` casts to the context itself.
const _warnedCommandsMap = new WeakMap<WebGPUContext, Set<string>>();
function _getWarnedCommands(context: WebGPUContext): Set<string> {
  let set = _warnedCommandsMap.get(context);
  if (!set) {
    set = new Set();
    _warnedCommandsMap.set(context, set);
  }
  return set;
}

/**
 * Backend-agnostic derived-command dispatcher that mirrors the
 * polymorphic selection in {@link Scene/SceneRenderer.js#executeCommand}
 * so WebGPU honours `logDepth` / `hdr` / `picking` / `pickingMetadata` /
 * `depth-only` / `shadows.receive` variants when a feature renderer has
 * populated them on the command.
 *
 * Empty `derivedCommands` (the common case for WebGPU-native feature
 * renderers that handle variants internally) falls through to the base
 * command, keeping their execute path unchanged.
 *
 * `isPickPass = true` is how `_executePickBatch` signals that it is
 * rendering to the pick FBO; the WebGL path infers this from
 * `frameState.passes.pick`, but the WebGPU pick pass runs as a separate
 * branch so we pass the signal explicitly to keep the dispatcher a pure
 * function.
 */
// The pick-pass module and `executeWebGPUCommand` share this dispatcher so
// both paths select derived commands identically.
export function selectCommandVariant(
  command: CesiumAnyDrawCommand,
  scene: CesiumScene,
  isPickPass: boolean,
  /**
   * Select the snapping variant instead of the
   * pick variant. Deliberately a caller-supplied axis rather than a read of
   * `frameState.passes.snap`: a snapping mini-frame runs two phases over the
   * same frame state, and the occluder phase must keep selecting the ordinary
   * pick variants (that is what writes the depth the payload phase tests
   * against). Only the payload phase passes `true`, so every non-snap caller
   * and the occluder phase keep selecting their ordinary variants.
   */
  snapVariant: boolean = false,
): CesiumAnyDrawCommand {
  const derived = command.derivedCommands;
  if (!derived) {
    return command;
  }

  const frameState = scene.frameState;
  const passes = frameState.passes;
  const isPicking = isPickPass || passes.pick || passes.pickVoxel;
  const isDepth = passes.depth;
  let cmd: CesiumAnyDrawCommand = command;

  // Log depth is a depth-write variant — swap before the other gates so
  // downstream reads see the log-depth command's own `derivedCommands` chain
  // (matching SceneRenderer.executeCommand line 49-51). During a pick pass,
  // the pick command is attached to the base command's
  // `derivedCommands.picking.pickCommand` (attachPickToColorCommand), not to
  // the log-depth variant. Swapping first hides it, so the pick check below
  // falls through and returns the log-depth color command — whose MRT
  // scene-framebuffer attachments are incompatible with the single-target
  // pick render pass, so WebGPU drops every pick draw and the pick FBO stays
  // empty, making every pick return undefined. The pick pass renders its
  // own self-consistent depth in the pick FBO, so it doesn't need the
  // log-depth variant.
  if (frameState.useLogDepth && !isPicking && derived.logDepth?.command) {
    cmd = derived.logDepth.command;
  }

  // HDR variant — only swap when rendering to an HDR framebuffer, which
  // never happens during pick/depth/pickVoxel passes.
  const hdrVariant = cmd.derivedCommands?.hdr?.command;
  if (!isPicking && !isDepth && scene.highDynamicRange && hdrVariant) {
    cmd = hdrVariant;
  }

  // Pick / depth passes short-circuit: if the command has the right
  // variant, use it; otherwise fall through to the base command so the
  // dispatcher never silently drops a command (same as WebGL).
  if (isPicking || isDepth) {
    const d = cmd.derivedCommands;
    if (isPicking && !isDepth) {
      // Snapping payload phase. A command with a
      // snap variant renders it (writing the RGBA32F snap payload); a command
      // without one returns unchanged, which the pass executor reads as "skip"
      // — its occlusion contribution was already made in the occluder phase,
      // and its pick pipeline targets an incompatible attachment format. This
      // short-circuits ahead of the metadata/pick slots so a snapping pass can
      // never accidentally dispatch an RGBA8 pick pipeline into the RGBA32F
      // payload pass.
      if (snapVariant) {
        const snapCommand = d?.snapping?.snapCommand;
        return snapCommand ?? cmd;
      }
      if (
        frameState.pickingMetadata &&
        d?.pickingMetadata?.pickMetadataCommand
      ) {
        return d.pickingMetadata.pickMetadataCommand;
      }
      // Route to the hover or precise pick variant when the scene-level mode
      // flag is set.
      // Falls through to default pickCommand if the requested variant
      // isn't materialized (e.g., precise pass 1 fallback for
      // OPAQUE/MASK alphaMode where there's no separate pass 2).
      //
      // For 'precise' mode the dispatcher returns pass 1 here. The
      // pick-pass executor (WebGPUSceneRendererPickPass) detects
      // `precisePass2Command` after the dispatch and emits it as a
      // follow-up draw within the same render pass — see
      // `executePickPassCommand` for the 2-pass coordination.
      const pickMode = frameState.passes.pickMode;
      if (!frameState.pickingMetadata && d?.picking) {
        const picking = d.picking;
        // A pickVoxel pass routes to the per-cell
        // pick variant (packs {megatextureIndex, sampleIndex} like WebGL's
        // VoxelFS.glsl PICKING_VOXEL branch) ahead of the object-pick color.
        // Additive: only voxel commands populate the slot; every other
        // command keeps falling through to its regular pickCommand —
        // mirroring WebGL, where the pickVoxel pass renders non-voxel
        // commands' regular pick IDs (SceneRenderer executeIdCommand).
        if (passes.pickVoxel && picking.pickVoxelCommand) {
          return picking.pickVoxelCommand;
        }
        if (pickMode === "hover" && picking.pickHoverCommand) {
          return picking.pickHoverCommand;
        }
        if (pickMode === "precise" && picking.pickPrecisePass1Command) {
          return picking.pickPrecisePass1Command;
        }
        if (picking.pickCommand) {
          return picking.pickCommand;
        }
      }
    } else if (d?.depth?.depthOnlyCommand) {
      return d.depth.depthOnlyCommand;
    }
    return cmd;
  }

  // Shadow receive variant — only on render passes when shadows are
  // enabled and the command opts in via `receiveShadows`.
  const shadowState = frameState.shadowState;
  const shadowReceive = cmd.derivedCommands?.shadows?.receiveCommand;
  if (shadowState?.lightShadowsEnabled && cmd.receiveShadows && shadowReceive) {
    return shadowReceive;
  }

  return cmd;
}

function executeWebGPUCommand(
  command: CesiumAnyDrawCommand,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
    return;
  }

  // Run the base command through the derived-command dispatcher so
  // WebGPU inherits WebGL's logDepth/hdr/shadows-receive variant selection.
  const dispatched = selectCommandVariant(command, scene, false);

  // Detect command type via duck-typing:
  // - WebGPU commands have `pipeline` or `_pipeline` -> execute(renderPass, context)
  // - WebGL commands have `shaderProgram` -> execute(context, passState)
  // - isWebGPUDrawCommand also supported for backwards compat
  const isGPU =
    dispatched.isWebGPUDrawCommand === true ||
    dispatched.pipeline !== undefined ||
    dispatched._pipeline !== undefined;

  if (isGPU) {
    const renderPass = context.currentRenderPassEncoder;
    if (renderPass) {
      dispatched.execute(renderPass, context);
    }
    return;
  }
  if (dispatched.execute) {
    dispatched.execute(context, passState);
    return;
  }
}

/**
 * Back-to-front comparator delegating to `Scene/CommandSorter.js#backToFront`
 * for WebGL-parity semantics: sortLayer → sortKey → sortPriority →
 * eye-distance-squared. CommandSorter preserves the ordering prefix and safely
 * returns zero for the distance term when a WebGPU command lacks a sphere.
 */
function _backToFrontComparator(
  a: CesiumAnyDrawCommand,
  b: CesiumAnyDrawCommand,
  position: { x: number; y: number; z: number },
): number {
  return _commandSorterBackToFront(a, b, position);
}

/**
 * Gaussian splat comparator delegating to
 * `Scene/CommandSorter.js#backToFrontSplats`. Splats sort on raw center
 * rather than `distanceSquaredTo(sphere)` because their bounding volume
 * is usually an oriented box whose center better reflects draw depth
 * than a conservative sphere radius would.
 */
function _backToFrontSplatsComparator(
  a: CesiumAnyDrawCommand,
  b: CesiumAnyDrawCommand,
  position: { x: number; y: number; z: number },
): number {
  return _commandSorterBackToFrontSplats(a, b, position);
}

function _frontToBackComparator(
  a: CesiumAnyDrawCommand,
  b: CesiumAnyDrawCommand,
  position: { x: number; y: number; z: number },
): number {
  return _commandSorterFrontToBack(a, b, position);
}

type ActiveCommandComparator = (
  a: CesiumAnyDrawCommand,
  b: CesiumAnyDrawCommand,
  position: { x: number; y: number; z: number },
) => number;

const activeSortScratch = new WeakMap<
  CesiumAnyDrawCommand[],
  CesiumAnyDrawCommand[]
>();

function sortActiveCommandRange(
  commands: CesiumAnyDrawCommand[],
  count: number,
  comparator: ActiveCommandComparator,
  position: { x: number; y: number; z: number },
): void {
  normalizeCommandOrderingList(commands, count);
  let scratch = activeSortScratch.get(commands);
  if (!scratch) {
    scratch = [];
    activeSortScratch.set(commands, scratch);
  }
  if (scratch.length < count) {
    scratch.length = count;
  }

  let source = commands;
  let target = scratch;
  for (let width = 1; width < count; width *= 2) {
    for (let left = 0; left < count; left += width * 2) {
      const middle = Math.min(left + width, count);
      const right = Math.min(left + width * 2, count);
      let leftIndex = left;
      let rightIndex = middle;
      for (let output = left; output < right; output++) {
        if (
          rightIndex >= right ||
          (leftIndex < middle &&
            comparator(source[leftIndex], source[rightIndex], position) <= 0)
        ) {
          target[output] = source[leftIndex++];
        } else {
          target[output] = source[rightIndex++];
        }
      }
    }
    const previousSource = source;
    source = target;
    target = previousSource;
  }
  if (source !== commands) {
    for (let i = 0; i < count; i++) {
      commands[i] = source[i];
    }
  }
}

/**
 * Sort the first `count` entries of `commands` back-to-front by eye distance.
 * Slots at [count, length) are preserved for next-frame command reuse.
 * Without OIT, alpha compositing is order-dependent — overlapping translucent
 * geometry renders wrong in command-push order.
 */
// The translucent-pass module and the in-file alpha-blend fallback share this
// sorter so their back-to-front ordering cannot diverge.
export function sortCommandsBackToFront(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
): void {
  if (count <= 1 || !scene?.camera?.positionWC) {
    return;
  }
  sortActiveCommandRange(
    commands,
    count,
    _backToFrontComparator,
    scene.camera.positionWC,
  );
}

/** Sort active pick/depth commands front-to-back for early-Z and nearest wins. */
export function sortCommandsFrontToBack(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
): void {
  if (count <= 1 || !scene?.camera?.positionWC) {
    return;
  }
  sortActiveCommandRange(
    commands,
    count,
    _frontToBackComparator,
    scene.camera.positionWC,
  );
}

/**
 * Gaussian-splat-specific back-to-front sort — uses `backToFrontSplats` so
 * the camera-distance metric comes from the box center, not the sphere's
 * conservative `distanceSquaredTo`.
 */
// The per-frustum loop and the inline path share this splat-distance sorter.
export function sortGaussianSplatsBackToFront(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
): void {
  if (count <= 1 || !scene?.camera?.positionWC) {
    return;
  }
  sortActiveCommandRange(
    commands,
    count,
    _backToFrontSplatsComparator,
    scene.camera.positionWC,
  );
}

// The globe-pass module uses the same dispatcher as the other scene passes.
export function executeBatch(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  for (let i = 0; i < count; i++) {
    try {
      executeWebGPUCommand(commands[i], scene, context, passState);
    } catch (e: unknown) {
      // Log once per command type rather than flooding — the command might
      // fail every frame, but we don't want to stop all rendering.
      const cmd = commands[i];
      const label =
        cmd?.owner?.constructor?.name ?? cmd?.constructor?.name ?? "unknown";
      const warned = _getWarnedCommands(context);
      const msg = (e as Error).message;
      const key = `${label}:${msg?.substring(0, 60)}`;
      if (!warned.has(key)) {
        warned.add(key);
        context.log?.("warn", `Command execution failed (${label}): ${msg}`);
      }
    }
  }
}

/**
 * Indirect-draw fast path for tile passes.
 *
 * Walks the command list and groups consecutive commands that share the
 * same pipeline and bind group identity and that already have an attached
 * indexed vertex/index buffer pair. Each homogeneous run is submitted to
 * `WebGPUIndirectDrawManager.submitBatch()` and executed via a single
 * `executeBatchIndexed()` call on the active render pass — collapsing N
 * setPipeline/setBindGroup/draw calls into 1 setPipeline + 1 setBindGroup
 * + N drawIndexedIndirect.
 *
 * Anything that doesn't fit (heterogeneous neighbour, missing index
 * buffer, command without `instanceCount`/`indexCount` fields, or a
 * one-element "run") falls back to the per-command executeBatch path.
 *
 * Activation is resolved by the contained tile policy before this function is
 * called. The legacy context boolean maps `false -> never` and
 * `true -> always`; an internal `auto` value remains available for threshold
 * characterization. The existing per-command path is the default.
 */
// The 3D Tiles pass module shares this fast path with the in-file pass runner.
export function executeBatchIndirect(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  const renderPass = context.currentRenderPassEncoder;
  const manager = context.indirectDrawManager;
  if (!renderPass || !manager) {
    executeBatch(commands, count, scene, context, passState);
    return;
  }

  // Reset the manager once per pass invocation. The manager owns its
  // staging buffer + GPU indirect buffer, so the cost is a counter reset.
  manager.beginFrame();

  let runStart = 0;
  while (runStart < count) {
    const head = commands[runStart];
    if (
      !head ||
      !head.isWebGPUDrawCommand ||
      !head.indexBuffer ||
      head.indexCount === undefined ||
      !(head.pipeline || head._pipeline)
    ) {
      try {
        executeWebGPUCommand(head, scene, context, passState);
      } catch (e: unknown) {
        const warned = _getWarnedCommands(context);
        const label =
          head?.owner?.constructor?.name ??
          head?.constructor?.name ??
          "unknown";
        const msg = (e as Error).message;
        const key = `${label}:${msg?.substring(0, 60)}`;
        if (!warned.has(key)) {
          warned.add(key);
          context.log?.(
            "warn",
            `Indirect path command failed (${label}): ${msg}`,
          );
        }
      }
      runStart++;
      continue;
    }

    // Greedily extend the run while neighbours share pipeline + bind
    // groups + index buffer (the three things that drawIndexedIndirect
    // pulls from the bound state rather than the per-call params).
    const headPipeline = head.pipeline ?? head._pipeline;
    const headBindGroups = head.bindGroups;
    const headDynamicOffsets = head.bindGroupDynamicOffsets;
    const headVertexBuffers = head.vertexBuffers;
    const headIndexBuffer = head.indexBuffer;
    const headIndexFormat = head.indexFormat ?? "uint16";

    let runEnd = runStart + 1;
    while (runEnd < count) {
      const next = commands[runEnd];
      if (!next || !next.isWebGPUDrawCommand) break;
      const nextPipeline = next.pipeline ?? next._pipeline;
      if (nextPipeline !== headPipeline) break;
      if (next.indexBuffer !== headIndexBuffer) break;
      // Cheap structural check on bind groups: same length, same refs.
      if (!sameBindGroupArray(next.bindGroups, headBindGroups)) break;
      // Bind-group identity alone is insufficient. Under a
      // dynamic-offset arena two different models on the same ring page share
      // one group-0 bind group and differ only in their byte offset, so
      // merging them into one run would draw the second with the first's
      // camera block. The offsets are part of the bound state a
      // `drawIndexedIndirect` inherits, so they must match to merge.
      if (
        !sameDynamicOffsetArray(
          next.bindGroupDynamicOffsets,
          headDynamicOffsets,
        )
      ) {
        break;
      }
      if (!sameVertexBufferArray(next.vertexBuffers, headVertexBuffers)) break;
      if ((next.indexFormat ?? "uint16") !== headIndexFormat) break;
      runEnd++;
    }

    const runLen = runEnd - runStart;
    if (runLen < 2) {
      // No batching benefit — execute as a normal draw and continue.
      try {
        executeWebGPUCommand(head, scene, context, passState);
      } catch (e: unknown) {
        // A run of one still failed to draw, so report it through the same
        // deduped channel as the non-batchable head above. Swallowing it here
        // made an identical throw silent at every log level purely because
        // the command happened not to merge with a neighbour.
        const warned = _getWarnedCommands(context);
        const label =
          head?.owner?.constructor?.name ??
          head?.constructor?.name ??
          "unknown";
        const msg = (e as Error).message;
        const key = `${label}:${msg?.substring(0, 60)}`;
        if (!warned.has(key)) {
          warned.add(key);
          context.log?.(
            "warn",
            `Indirect path command failed (${label}): ${msg}`,
          );
        }
      }
      runStart = runEnd;
      continue;
    }

    // Submit the homogeneous slice to the indirect manager and execute it.
    const slice = commands.slice(runStart, runEnd);
    const firstIndex = manager.submitBatch(slice);
    if (firstIndex < 0) {
      // Overflow — fall back to per-command for this run only.
      for (let i = runStart; i < runEnd; i++) {
        executeWebGPUCommand(commands[i], scene, context, passState);
      }
      runStart = runEnd;
      continue;
    }
    manager.flush();

    // Bind the shared state once and emit the indirect draws.
    renderPass.setPipeline(headPipeline);
    if (headBindGroups) {
      for (let g = 0; g < headBindGroups.length; g++) {
        // Every command in this run carries identical
        // dynamic offsets above, so binding the head's is binding all of them.
        const offsets = headDynamicOffsets?.[g];
        if (offsets !== undefined) {
          renderPass.setBindGroup(g, headBindGroups[g], offsets);
        } else {
          renderPass.setBindGroup(g, headBindGroups[g]);
        }
      }
    }
    if (headVertexBuffers) {
      for (let v = 0; v < headVertexBuffers.length; v++) {
        renderPass.setVertexBuffer(
          v,
          (headVertexBuffers[v] as { buffer: GPUBuffer }).buffer,
        );
      }
    }
    renderPass.setIndexBuffer(
      (headIndexBuffer as { buffer: GPUBuffer }).buffer,
      headIndexFormat,
    );
    manager.executeBatchIndexed(renderPass, firstIndex, runLen);

    runStart = runEnd;
  }
}

function sameBindGroupArray(
  a: ReadonlyArray<unknown> | undefined,
  b: ReadonlyArray<unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Structural equality for per-group dynamic-offset arrays. Compares by value,
 * not by reference: two commands built from the same arena slice
 * legitimately hold different array instances holding the same offset, and
 * refusing to merge those would silently undo the indirect batching win.
 */
function sameDynamicOffsetArray(
  a: ReadonlyArray<number[] | undefined> | undefined,
  b: ReadonlyArray<number[] | undefined> | undefined,
): boolean {
  if (a === b) return true;
  const aLength = a?.length ?? 0;
  const bLength = b?.length ?? 0;
  if (aLength !== bLength) return false;
  for (let i = 0; i < aLength; i++) {
    const ai = a![i];
    const bi = b![i];
    if (ai === bi) continue;
    if (ai === undefined || bi === undefined) return false;
    if (ai.length !== bi.length) return false;
    for (let j = 0; j < ai.length; j++) {
      if (ai[j] !== bi[j]) return false;
    }
  }
  return true;
}

function sameVertexBufferArray(
  a: ReadonlyArray<unknown> | undefined,
  b: ReadonlyArray<unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Execute commands as depth-only derived variants.
 * Used for globe depth pass — renders only to depth buffer (no color writes).
 */
function executeBatchDepthOnly(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  for (let i = 0; i < count; i++) {
    const cmd = commands[i];
    if (!cmd) continue;
    // Mark command for depth-only pipeline variant selection
    const savedDepthOnly = cmd._depthOnly;
    const savedColorWrite = cmd._colorWriteMask;
    cmd._depthOnly = true;
    cmd._colorWriteMask = 0;
    executeWebGPUCommand(cmd, scene, context, passState);
    cmd._depthOnly = savedDepthOnly;
    cmd._colorWriteMask = savedColorWrite;
  }
}

/**
 * Execute commands with translucency-derived blend state.
 * Used for globe translucency — selects blend/cull/depth based on
 * the _webgpuTranslucencyDerived type marker.
 */
// The globe-pass module shares this executor with the in-file path.
export function executeBatchTranslucent(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  for (let i = 0; i < count; i++) {
    const cmd = commands[i];
    if (!cmd) continue;
    // `WebGPUGlobeTranslucencyState.update*()` populates
    // `_webgpuTranslucencyDerived[0..N-1]` with one derived
    // descriptor per pass (front-faces, back-faces, depth-only, etc.).
    // Iterate the full count because globe translucency commonly needs several
    // derived passes. Omitting any entry loses its blend or depth contribution.
    if (cmd._webgpuTranslucencyDerived) {
      const derivedCount =
        cmd._webgpuTranslucencyDerivedCount ??
        cmd._webgpuTranslucencyDerived.length ??
        0;
      if (derivedCount === 0) {
        executeWebGPUCommand(cmd, scene, context, passState);
        continue;
      }
      const saved = {
        blend: cmd._blendEnabled,
        depthWrite: cmd._depthWriteEnabled,
        cullMode: cmd._cullMode,
      };
      try {
        for (let d = 0; d < derivedCount; d++) {
          const derived = cmd._webgpuTranslucencyDerived[d];
          if (!derived) continue;
          cmd._blendEnabled = derived.blendEnabled ?? saved.blend;
          cmd._depthWriteEnabled =
            derived.depthWriteEnabled ?? saved.depthWrite;
          cmd._cullMode = derived.cullMode ?? saved.cullMode;
          executeWebGPUCommand(cmd, scene, context, passState);
        }
      } finally {
        cmd._blendEnabled = saved.blend;
        cmd._depthWriteEnabled = saved.depthWrite;
        cmd._cullMode = saved.cullMode;
      }
    } else {
      executeWebGPUCommand(cmd, scene, context, passState);
    }
  }
}

// Debug capture returned by `getGpuSortConsumeSnapshot()` for the
// acceptance probe. Only populated under the debug pragma.
interface GpuSortDebugCapture {
  validCount: number;
  originalCount: number;
  sortMode: number;
  cameraPosition: { x: number; y: number; z: number };
  distanceSquared: number[];
  renderLayers: number[];
  sortPriorities: number[];
  materialSortIds: number[];
  sortedCompactedIndices: number[];
  compactedToOriginal: number[];
  skipped: number[];
  appliedOrderLength: number;
  consumeEnabled: boolean;
}

// An opaque tag travels through the dispatcher's readback ring so the decoded
// compacted sorted indices
// stay paired with the exact compaction map from the dispatch that
// produced them, even though the ring surfaces the decode 1-2 frames
// later. `debug` is populated only under the debug pragma.
interface GpuSortReadbackTag {
  validCount: number;
  originalCount: number;
  compactedToOriginal: Uint32Array;
  skipped: number[];
  debug?: GpuSortDebugCapture;
}

interface UnsafePathStatus {
  requested: boolean;
  capable: boolean;
  active: boolean;
  fallbackReason: string | null;
}

interface ModeUnsafePathStatus<Mode extends string> extends UnsafePathStatus {
  requestedMode: Mode;
}

// --------------- Main class ---------------

export class WebGPUSceneRenderer {
  private _isDestroyed: boolean = false;
  // Reused clone of the camera frustum for per-slice near/far and TAA jitter.
  // The persistent camera frustum is renderer-shared state; mutating its
  // cached projection made freeze/reset correctness depend on cache misses.
  private _frustumScratch: object | null = null;
  private _projectionJitterRestore: Float64Array | null = null;
  private _infiniteProjectionJitterRestore: Float64Array | null = null;

  // Cache the context during `_executeOpaquePass` so
  // diagnostic surfaces (`getHighDensityCullStats`) can read CSM
  // renderer state without threading the context through every
  // call. The renderer is owned by a single Scene tied to a single
  // Context, so caching here is safe.
  private _lastContext: WebGPUContext | null = null;

  // The per-frame scene reference lets `_resumeScenePass` and
  // `_clearDepthStencil` reach `scene._view.gBufferFramebuffer`
  // when re-opening the scene-FB render pass with the MRT slot-1
  // attachment. Stashed at the top of `executeCommands` (the only
  // method that's already wired with `config.scene`) and cleared at
  // frame end. Cheaper than threading scene through all 8+ callers of
  // the two re-open methods.
  public _scene: unknown = null;

  // Scene-level rendering resources (lazy-initialized)
  // Public underscore shared with the executeCommands helper modules.
  public _sceneFramebuffer: WebGPUSceneFramebuffer | null = null;
  // MRT framebuffer for the
  // CESIUM_3D_TILE_EDGES pass (edge color + id + packed depth + depth-
  // stencil). Lazily allocated on first frame where
  // `scene._enableEdgeVisibility` is true; it stays null otherwise to
  // avoid paying the allocation cost for scenes that don't use edges.
  // Public underscore shared with the 3D Tiles pass module.
  public _edgeFramebuffer: WebGPUEdgeFramebuffer | null = null;
  // Translucent tile classification resources. Needed when a frame produces
  // classification commands and has translucent geometry that needs depth
  // capture. They allocate eagerly during scene initialization because the
  // first-cut depth-capture path uses `copyTextureToTexture` from the
  // scene framebuffer — cheap to keep allocated.
  // Public underscore shared with the frame-reset and per-frustum helpers.
  public _translucentTileClassification: WebGPUTranslucentTileClassification | null =
    null;
  // Public underscore shared with the translucent-pass module.
  public _oit: WebGPUOIT | null = null;
  // The public Scene OIT option remains a request, while this
  // renderer-owned safety gate controls whether the currently unsafe WebGPU
  // MRT implementation may allocate or execute. Default false preserves the
  // complete alpha-blend fallback.
  public _webgpuOITEnabled: boolean = false;
  public _lastOITRequested: boolean = false;
  public _webgpuOITActiveThisFrame: boolean = false;
  // Public underscore shared with the executeCommands frustum-loop helper.
  public _globeDepth: WebGPUGlobeDepth | null = null;
  // Public underscore shared with the resource-ensure helper.
  public _depthPlane: WebGPUDepthPlane | null = null;
  // Public underscore shared with the post-frustum chain helper.
  public _postProcess: WebGPUPostProcessPipeline | null = null;
  // Fullscreen depth visualization, constructed lazily
  // on first request so production frames pay nothing.
  // Public underscore shared with the resource-ensure helper.
  public _debugDepthOverlay: WebGPUDebugDepthOverlay | null = null;
  private _depthOverlayWarningLogged: boolean = false;
  // Debug overlay that visualizes the G-buffer normal texture as a fullscreen
  // blit. Constructed lazily on
  // first invocation; null when `scene.debugShowGBufferNormals` is off.
  public _debugGBufferOverlay: WebGPUDebugGBufferOverlay | null = null;
  private _gbufferProducerWarnedNoDepth: boolean = false;
  // Frustum and command tint overlay, equivalent to WebGL's
  // `debugShowFrustums` / `debugShowCommands`). Lazy.
  // Public underscore shared with the resource-ensure helper.
  public _debugFrustumOverlay: WebGPUDebugFrustumOverlay | null = null;
  // Per-command `debugShowBoundingVolume` red-wireframe pass, equivalent to
  // SceneDebug's WebGL bounding-volume draw). Lazy; null until the first
  // frame that has a flagged command.
  public _boundingVolumeDebugPass: WebGPUBoundingVolumeDebugPass | null = null;
  // Captured during the frustum loop so the post-process debug overlay
  // can tint pixels by which frustum drew them. Reset each frame.
  // Public underscore shared with the frame-reset and per-frustum helpers.
  public _capturedFrustumRanges: { near: number; far: number }[] = [];

  // Set by `_execute3DTilePasses`
  // when it successfully runs the CLASSIFICATION_IGNORE_SHOW pass into
  // the invert FBO, meaning the depth-stencil view carries stencil
  // bits the final composite can use to split classified vs
  // unclassified tile pixels. Reset per-frame at the start of the
  // scene render loop; consumed by `_runInvertClassificationComposite`.
  // Public underscore shared with the 3D Tiles pass module. This is the
  // stencil-readiness flag for the invert composite.
  public _invertClassStencilReady: boolean = false;

  // Set by `_execute3DTilePasses` when the
  // CESIUM_3D_TILE_EDGES pass actually ran into the edge MRT
  // framebuffer and produced content. Reset per-frame; the model fragment
  // shader's inline edge stage reads it through `context._edge*View` to
  // decide whether to gate the overlay or skip.
  // Public underscore shared with the 3D Tiles pass module.
  public _edgeTexturesPopulated: boolean = false;
  // Public underscore shared with the resource-ensure helper.
  public _initialized: boolean = false;
  // Public underscore shared with the 3D Tiles pass module.
  public _width: number = 0;
  public _height: number = 0;
  public _tileIndirectStatus: TileIndirectStatus = {
    requestedMode: "never",
    requested: false,
    capable: false,
    active: false,
    fallbackReason: "not-requested",
  };
  public _tileIndirectStatusFrame: number = -1;
  // The per-frame viewport is derived from
  // `passState.viewport` when present, else the full canvas. Used by
  // every `setViewport` / `setScissorRect` call in the scene-FB
  // render-pass setup so split-screen / sub-viewport callers see
  // their requested rectangle. WebGL takes `passState.viewport`
  // directly via `Context.uniformState.viewport`; the WebGPU
  // equivalent threads through this cached quad instead of accepting
  // the BoundingRectangle each call.
  public _viewportX: number = 0;
  public _viewportY: number = 0;
  public _viewportWidth: number = 0;
  public _viewportHeight: number = 0;
  // Track the last-applied HDR mode so a runtime toggle of
  // `scene.useHDR` triggers a framebuffer recreate even when the
  // window dimensions don't change. Initial value `null` so the
  // first `update()` call always reaches `_sceneFramebuffer.update`
  // regardless of the initial HDR setting. Pipeline-cache invalidation is
  // required with the recreate; without it, pipelines have the old canvas
  // format baked in and produce validation warnings against the
  // recreated rgba16float scene FB).
  // Public underscore shared with the resource-ensure helper.
  public _lastHDR: boolean | null = null;

  // Forward+ clustered-lighting dispatcher.
  // Lazily constructed on first use (the device isn't available at
  // SceneRenderer construction time). Owns the cluster-bounds +
  // cluster-assign compute renderers + the params uniform; consumer
  // pipelines bind its public buffers at @group(4) via the chunk in
  // ClusteredLighting.wgsl.
  //
  // Inert when scene.clusteredLightingEnabled === false or when zero
  // lights are configured — the dispatcher returns activeLightCount=0
  // and the consumer FS chunk early-outs without touching the storage
  // buffers.
  // Public underscore so `WebGPUSceneRendererClusteredLighting` can construct
  // and read it through the `ClusteredLightingHost` surface, matching the
  // other scene-renderer helper hosts such as `_postProcess` and
  // `_sceneFramebuffer`.
  public _clusteredLightingDispatcher: WebGPUClusteredLightingDispatcher | null =
    null;
  // Track the previous MSAA sample count so the
  // scene framebuffer recreate path AND the render bundle cache
  // invalidation both fire when `scene.msaaSamples` changes. The
  // bridge in `prepareFrame` writes `context._msaaSamples`; that
  // value alone doesn't trigger a recreate because the framebuffer
  // already exists at the old sample count.
  // The initial value is `1`, not null, so the first
  // frame after the bridge re-enable correctly detects the
  // 1→4 transition and triggers framebuffer recreate + bundle
  // invalidation. A null sentinel would skip the change detection
  // on the very frame the bridge first takes effect.
  public _lastMsaaSamples: number = 1;
  private _depthPlaneWarned: boolean = false;

  // ── Debug log-once guards (pragma-stripped in production) ──
  // `_renderPassRedirectLogged` is public so the render-pass-redirect module
  // can read and write it through the
  // host interface. Production builds strip the declaration along
  // with the pragma block; the new module's reads/writes are also
  // inside their own pragma blocks, so production never touches the
  // field. Visibility is TS-only — no runtime cost difference.
  //>>includeStart('debug', pragmas.debug);
  private _execDebugLogged: boolean = false;
  private _debugLogged: boolean = false;
  private _postInitDebugLogged: boolean = false;
  public _renderPassRedirectLogged: boolean = false;
  // Public so the post-frustum chain can read and write through the host
  // interface. The field declaration stays inside
  // the surrounding pragma block.
  public _ppDebugLogged: boolean = false;
  private _globeValidationDone: boolean = false;
  private _globePassRPLogged: boolean = false;
  private _globeCountLogged: boolean = false;
  private _globeCountLogFrame: number = -1;
  private _globePassLastLog: number = 0;
  //>>includeEnd('debug');

  // Runtime state shared with the frustum-loop helper through public
  // underscore fields.
  public _currentFrustumIndex: number = 0;
  // Public underscore shared with the translucent-pass module.
  public _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null = null;
  // Opt-in Gaussian-splat weighted-sum-rendering deferral to OIT. It defaults
  // to false for WebGL parity. WebGL executes Gaussian splats inline in the scene
  // pass (`GaussianSplatPrimitive.js` pushes its DrawCommand — depthTest on,
  // depthMask off, premultiplied-alpha blend — into `commandList`; the splat
  // pass draws it right after opaque and never routes it through OIT). Deferral
  // sends splats carrying an `_oitPipeline` to translucent OIT accumulation.
  // `executeTranslucentPass` returns early when a frame has no translucent
  // commands, which is common for a bare globe with splats, so the armed path
  // also carries a never-drop seatbelt that executes deferred splats.
  public _splatOITDeferral: boolean = false;
  // Per-frustum opaque-pass readback slots. Each frustum dispatches against its own
  // culler instance and stores its readback under its own frustum
  // index, so multi-frustum scenes (typical with log-depth) get full
  // GPU cull benefit without sibling frustums overwriting one another.
  private _lastCullResultsByFrustum: Map<number, GPUCullResults> = new Map();
  // Guard each frustum's in-flight readback. The GPU culler's staging buffer is
  // mapped with `mapAsync` while `readResults`
  // resolves; re-running `prepareReadback` (copyBufferToBuffer into that
  // staging buffer) on the next frame while it is still mapped raises
  // "[Buffer] used in submit while mapped", invalidating the whole command
  // buffer → dense-scene black screen. Mirrors `_hiZReadbackInFlight`.
  private _gpuCullReadbackInFlight: Set<number> = new Set();
  // A separate readback slot for the translucent pass ensures
  // its readback (keyed on the translucent command count) doesn't
  // race / mismatch with the opaque pass's. Same 1-frame latency
  // contract.
  private _lastCullResultsTranslucent: GPUCullResults | null = null;
  private _gpuCullFilterPoolTranslucent: CesiumAnyDrawCommand[] = [];
  // Reusable filter output array for
  // `gpuCullCommands`. Allocating a fresh `[]` every frame at high
  // density (10K+ commands) creates GC pressure; the consumer
  // (`_executeOpaquePass`) reads the result synchronously and
  // immediately, so we can hand back the same array next frame
  // after `length = 0`. Two separate pools — gpuCuller for the
  // frustum filter, _hiZFilterPool below for the occlusion filter —
  // because both can be active in the same frame and the second's
  // input is the first's output.
  private _gpuCullFilterPool: CesiumAnyDrawCommand[] = [];
  private _gpuCullingRequestedMode: "auto" | "always" | "never" = "never";

  // Threshold-gated HiZ occlusion state.
  //
  // Activates only when the opaque batch reaches `_hiZThreshold` (much
  // higher than the gpuCuller threshold of 256, since HiZ pays for an
  // additional depth-pyramid build + occlusion test). Designed for the
  // 10K+ models density target.
  //
  // Pattern: each frame, if a previous-frame visibility readback is
  // available, filter this frame's opaque commands against it. After
  // the opaque pass writes depth, dispatch the build-pyramid + test
  // for the NEXT frame and queue the readback. The 1-frame latency
  // matches `gpuCullCommands` and is acceptable for dense scenes.
  //
  // SOA scratch is allocated lazily at first use sized to the largest
  // count seen so far; GC churn matters when this runs every frame.
  private static readonly HI_Z_THRESHOLD = 2000;
  private static readonly HI_Z_THRESHOLD_HI = 2400;
  private static readonly HI_Z_THRESHOLD_LO = 1600;
  // Renderer-owned consumer activation flag, disabled by default. Keeping
  // this per instance prevents one scene's diagnostic toggle from changing
  // another scene/context and makes visibility consumption an explicit opt-in.
  //
  // The Hi-Z pyramid build + OcclusionTest dispatch + async readback run
  // whenever the density gate is active; when this flag is true the visibility
  // result is allowed to drop occluded commands.
  //
  // The pyramid must not use `context.depthOnlyTextureView`: the WebGPU scene
  // never writes that default depth texture because post-process rendering
  // targets `_sceneFramebuffer`. Reading its clear value of 1.0 would make the
  // whole pyramid all-far, so `sphereNearZ > maxHiZ` could never hold and the
  // hit ratio would stay at zero. A mip off-by-one or four-corner background
  // bleed can only under-cull because sky overhang produces maxHiZ=1.0; those
  // cases remain conservative and cannot hide visible geometry.
  // `_dispatchHiZForNextFrame` therefore sources
  // `_sceneFramebuffer.depthSampleableView` (the same MSAA-resolved
  // sampleable depth velocity/AO/DoF bind), and the dispatcher picks the
  // texture_2d<f32> mip-0 pipeline for the r16float MSAA-resolved view vs the
  // texture_depth_2d pipeline for single-sample.
  //
  // `probe-fork41-occlusion-v2.mjs` measures an occludable scene with a
  // wide near "lid" over 2500 cubes it fully hides) culls the cubes
  // (hitRatio 1.0, hiZFiltered 397/992897) and the consume-ON image is
  // 0.007% different from GPU-cull-forced-off; the dropped cubes are hidden,
  // so the visible result is unchanged. The sky-overhanging tall-box scene in
  // `probe-fork41-occlusion.mjs` checks that the conservative case does not
  // false-cull. Toggle the consumer for A/B comparisons through
  // `setHiZConsumeEnabled` / `CesiumDebug.hiZConsume`.
  private _hiZConsumeEnabled: boolean = false;

  /**
   * Enable or disable consumer-side application of Hi-Z occlusion visibility.
   * It remains disabled until result identity is tied to the producing frame,
   * frustum, and command list.
   * The build/dispatch/readback can still run in an explicitly requested
   * producer mode; this toggle only controls result consumption.
   */
  setHiZConsumeEnabled(value: boolean): void {
    this._hiZConsumeEnabled = value === true;
  }

  /** Whether occluded commands are actually dropped. */
  get hiZConsumeEnabled(): boolean {
    return this._hiZConsumeEnabled;
  }

  /**
   * Set the consumer-side activation mode for the GPU-produced front-to-back
   * sort order. `"never"` is the contained default. `"auto"` applies whenever
   * the opaque-command-count
   * gate is active and `"always"` force-applies; `"never"` is the off-gate (the
   * key generation, bitonic sort, readback, and permutation consumer are all
   * disabled, so the ordinary CPU ordering path remains unchanged).
   * Reordering opaque commands is output-invariant, so every mode is
   * byte-neutral for the final image; the mode only trades early-Z cost.
   */
  setGpuSortConsumeMode(mode: "auto" | "always" | "never"): void {
    if (mode === "auto" || mode === "always" || mode === "never") {
      this._gpuSortConsumeMode = mode;
    }
  }

  /** Current GPU-sort consumer activation mode. */
  get gpuSortConsumeMode(): "auto" | "always" | "never" {
    return this._gpuSortConsumeMode;
  }

  /**
   * Compatibility boolean for the GPU-sort consumer. `true` maps to the
   * `"always"` mode (force-apply); `false` maps to `"never"` (the
   * off-gate). Callers that need the production `"auto"` heuristic use
   * `setGpuSortConsumeMode`; a boolean cannot express it. Used by
   * `CesiumDebug.gpuSortConsume` for comparison probes.
   */
  setGpuSortConsumeEnabled(value: boolean): void {
    this._gpuSortConsumeMode = value === true ? "always" : "never";
  }

  /**
   * Whether the GPU sort order is applied while the density gate is active,
   * meaning the mode is not `"never"`. In `"auto"` or `"always"`
   * the consumer applies; in `"never"` it does not.
   */
  get gpuSortConsumeEnabled(): boolean {
    return this._gpuSortConsumeMode !== "never";
  }

  /** Internal comparison gate for the contained WebGPU OIT path. */
  setWebGPUOITEnabled(value: boolean): void {
    this._webgpuOITEnabled = value === true;
  }

  /** Whether the unsafe WebGPU OIT implementation was explicitly forced. */
  get webgpuOITEnabled(): boolean {
    return this._webgpuOITEnabled;
  }
  // Per-frustum gate state.
  private _hiZActiveByFrustum: Map<number, boolean> = new Map();
  // HiZ effectiveness counters.
  private _hiZDispatchCount: number = 0;
  private _hiZLastInput: number = 0;
  private _hiZLastFiltered: number = 0;
  // Public by the file's underscore convention because the device-invalidation
  // callback in WebGPUSceneRendererEnsureResources resets them through the
  // EnsureResourcesHost shape.
  public _hiZAllocated: boolean = false;
  public _hiZAllocatedFor = { width: 0, height: 0, capacity: 0 };
  private _hiZSphereSoA: {
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    radius: Float32Array;
    capacity: number;
  } | null = null;
  // Last successful HiZ readback. `count` lets us only filter when
  // this frame's opaque count matches — order shifts can mis-classify
  // a few commands but for the dense-static-scene target the prior
  // frame is a good predictor.
  private _lastHiZVisibility: { flags: Uint32Array; count: number } | null =
    null;
  // True while a readback Promise is in flight; prevents stacking
  // duplicate readback calls per frame.
  private _hiZReadbackInFlight: boolean = false;
  private _hiZConsumedThisFrame: boolean = false;
  // Reusable filter output for
  // `_filterByHiZVisibility`. Same lifetime model as
  // `_gpuCullFilterPool` above.
  private _hiZFilterPool: CesiumAnyDrawCommand[] = [];

  // Threshold-gated GPU sort-key generation. It produces packed 64-bit keys
  // (`sortKeysHigh`, `sortKeysLow`, and command indices), feeds the bitonic
  // sort pipeline, and queues the tagged readback consumed below.
  //
  // Threshold is intentionally high (5000) — JS sort is faster than
  // dispatch+readback round-trip below this density. SOA scratch is
  // allocated lazily, sized to the largest count seen.
  private static readonly GPU_SORT_KEYS_THRESHOLD = 5000;
  private static readonly GPU_SORT_KEYS_THRESHOLD_HI = 6000;
  private static readonly GPU_SORT_KEYS_THRESHOLD_LO = 4000;
  // Per-frustum gate state.
  private _gpuSortActiveByFrustum: Map<number, boolean> = new Map();
  // Public for the same reason as the Hi-Z allocation epoch above.
  public _sortKeysAllocatedFor: number = 0;
  private _sortKeysSoA: {
    distanceSquared: Float32Array;
    renderLayers: Uint32Array;
    sortPriorities: Uint32Array;
    materialSortIds: Uint32Array;
    capacity: number;
  } | null = null;
  private _sortKeysDispatches: number = 0;
  // Sorted-indices readback state.
  // `_lastSortedIndices` is the most-recent decoded readback; the
  // consumer reorders the opaque command list using it (1-2 frame
  // latency via the dispatcher's deferred-readback ring, which handles
  // map-vs-submit races internally — no consumer-level in-flight flag).
  // The readback carries the compaction map so the permutation indexes the
  // original command array, not the compacted SOA. Canonical-distance
  // dispatches require every command to be encodable, so this map is identity
  // and `skipped` is empty today; retaining both fields keeps delayed readback
  // tags self-describing and backwards-compatible with existing probes.
  // `originalCount` gates staleness (only apply when this frame's opaque
  // count matches, same 1-frame-latency contract as HiZ/gpuCull).
  private _lastSortedIndices: {
    indices: Uint32Array;
    count: number;
    originalCount: number;
    compactedToOriginal: Uint32Array;
    skipped: number[];
  } | null = null;
  // Reusable output for `_applySortedOrder` — same pooled-lifetime model
  // as `_hiZFilterPool` / `_gpuCullFilterPool` (consumed synchronously
  // inside executeBatch, never retained across frames).
  private _sortOrderPool: CesiumAnyDrawCommand[] = [];
  // Reusable compaction scratch (grown on demand). Rebuilt every
  // dispatch; the valid slice + skipped list are copied into the
  // readback's `_lastSortedIndices` so this can be reused next frame.
  private _sortCompactionScratch: {
    compactedToOriginal: Uint32Array;
    skipped: number[];
  } | null = null;
  // Consumer-side activation has three modes matching
  // `Scene.gpuCullingHint` semantics:
  //   - "auto":  explicit threshold-characterization mode. The consumer applies
  //              the GPU front-to-back permutation whenever the per-frustum
  //              opaque-command-count gate (`gpuSortActive`, hysteresis
  //              GPU_SORT_KEYS_THRESHOLD_HI/LO) is active. This is the
  //              live path; the count threshold is the heuristic, so no
  //              extra flag is needed for a dense scene to benefit.
  //   - "always": force-apply whenever a readback exists for comparisons.
  //   - "never" (default): force-off; neither the sort producer nor consumer
  //              runs. This avoids ending the render pass, uploading keys,
  //              sorting, and mapping a readback whose result cannot be used.
  // Reordering opaque commands is output-invariant (depth test resolves
  // overlap) so every mode is byte-neutral for the final image; the mode
  // only trades early-Z efficiency. `_hiZConsumeEnabled`, a sibling consumer,
  // is also explicitly opt-in while identity hazards remain.
  // Toggle via `setGpuSortConsumeMode` / `setGpuSortConsumeEnabled` /
  // `CesiumDebug.gpuSortConsume`.
  private _gpuSortConsumeMode: "auto" | "always" | "never" = "never";
  // Consumer diagnostic counters surfaced through `getHighDensityCullStats`.
  private _sortConsumeApplied: number = 0;
  private _sortConsumeSkipped: number = 0;
  private _sortConsumeAppliedThisFrame: boolean = false;
  // Debug-only capture of the last dispatched compacted SOA + readback,
  // for the acceptance probe to verify the GPU order matches the CPU
  // comparator. Populated only under the debug pragma.
  private _gpuSortDebugCapture: GpuSortDebugCapture | null = null;

  // Track the device-invalidation unsubscribe so
  // re-calls to `_ensureResources` don't stack duplicate subscribers.
  // Public underscore shared with the resource-ensure helper.
  public _deviceInvalidationUnsub: (() => void) | null = null;

  // CPU-side per-pass recording-cost profiler. Disabled by default;
  // toggle via `setCpuPassProfiling(true)`
  // (or `CesiumDebug.cpuPassCost(true)`). Shared with the frustum-loop
  // slice via the host interface so per-frustum sub-passes accumulate
  // into per-frame buckets.
  public _cpuPassProfiler: WebGPUCpuPassProfiler = new WebGPUCpuPassProfiler(
    false,
  );

  // Lazy initialization.

  /**
   * Early-frame hook that recreates the scene framebuffer and bumps the
   * scene-pipeline-format generation before primitives'
   * update methods run. Called from `Scene.render()` between
   * `context.beginFrame()` and `scene.updateEnvironment()`.
   *
   * Without this hook, the framebuffer recreation lives inside
   * `_ensureResources` which runs from `executeCommands` after
   * primitives have already populated the command list. On the
   * runtime HDR toggle frame, primitives like SkyAtmosphere would
   * emit commands referencing the old-format pipeline because the
   * generation hadn't bumped yet), then `_ensureResources` would
   * bump the generation too late, producing one transient
   * pipeline-vs-attachment validation warning per toggle direction.
   *
   * The function is idempotent — calling `_ensureResources` later
   * in the same frame is a no-op for the scene-framebuffer block
   * because `needsRecreate` is now false (HDR is the same as
   * `_lastHDR` after this method ran).
   *
   * @param config Subset of WebGPURenderFrameConfig with the fields
   *   we need (scene + context + useHDR). Full config isn't built
   *   yet at this point in the frame.
   */
  /**
   * Derive this frame's sun light and sky-irradiance ambient from the
   * atmosphere, in place of the scene's plain sun light.
   *
   * The scene publishes its own light and then offers the frame state here.
   * Owning the decision in the renderer is what keeps the shared scene code
   * free of a backend test: a backend that registers no scene renderer never
   * reaches this, and its frame state keeps the light the scene published.
   *
   * @param scene The scene whose frame state is being prepared.
   * @param frameState The frame state to publish onto.
   */
  updateDerivedLighting(
    scene: CesiumScene,
    frameState: CesiumFrameState,
  ): void {
    applySceneAtmosphereDerivedLighting(scene, frameState);
  }

  prepareFrame(config: {
    scene: CesiumScene;
    context: WebGPUContext;
    useHDR: boolean;
  }): void {
    const { context } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    // The MSAA bridge is enabled because every downstream scene-framebuffer
    // pipeline is sample-count-aware (SkyAtmosphere, Sun, Moon, CubeMapPanorama,
    // DepthPlane, Globe terrain, Model PBR + velocity + classification,
    // OIT composite, InvertClassification, TranslucentTileClassification,
    // GlobeDepth — every path that targets the scene FB now reads
    // `context._msaaSamples` and bakes the matching `multisample.count`
    // into its pipeline).
    //
    // `scene.msaaSamples` (default 4 from `Scene.js:405`) is
    // capped at 4 and propagated into `context._msaaSamples`. Triggers
    // - Scene framebuffer recreation at the new sample count through
    //   `_lastMsaaSamples` drift detection
    // - Render bundle cache invalidation through the `msaaChanged` branch
    // - `_scenePipelineFormatGeneration` bump → every generation-keyed
    //   pipeline cache (Globe, Model, OIT, InvertClassification, etc.)
    //   refreshes on the next frame
    //
    // Setting `scene.msaaSamples = 1` selects the non-multisampled path.
    //
    // TAA forces the effective sample count to 1, implementing the contract documented
    // on `Scene.taaEnabled` ("Disables MSAA when active — the two are
    // incompatible"). The velocity pass pairs the
    // single-sample rg16float velocity texture with the scene depth
    // attachment, and a 4x multisampled depth in that pass descriptor is
    // a validation error that kills the whole pass. `scene.msaaSamples`
    // itself is left untouched — toggling TAA off restores the user's
    // MSAA setting via the existing sample-count drift detection below.
    const scene = config.scene;
    const taaActive = scene.taaEnabled === true;
    const requestedSamples = taaActive
      ? 1
      : Math.max(
          1,
          Math.min(
            4,
            (scene as unknown as { msaaSamples?: number }).msaaSamples ?? 1,
          ),
        );
    if (context._msaaSamples !== requestedSamples) {
      context._msaaSamples = requestedSamples;
    }

    const canvas: HTMLCanvasElement | OffscreenCanvas | undefined =
      context._canvas;
    const width = canvas?.width ?? 1;
    const height = canvas?.height ?? 1;
    const needsResize = width !== this._width || height !== this._height;
    const hdr = config.useHDR ?? false;
    const hdrChanged = this._lastHDR !== null && this._lastHDR !== hdr;
    // Detect MSAA sample-count drift. When the
    // bridge above writes `context._msaaSamples` from
    // `scene.msaaSamples`, the framebuffer needs recreation at the
    // new sample count and the render bundle cache must be invalidated
    // (bundles bake their pipeline's sample count at record time).
    const msaaChanged = this._lastMsaaSamples !== requestedSamples;
    const needsRecreate =
      !this._initialized || needsResize || hdrChanged || msaaChanged;
    this._lastHDR = hdr;
    this._lastMsaaSamples = requestedSamples;

    if (!this._sceneFramebuffer) {
      this._sceneFramebuffer = new WebGPUSceneFramebuffer();
    }
    if (needsRecreate) {
      const numSamples: number = requestedSamples;
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      this._sceneFramebuffer.update(
        device,
        width,
        height,
        hdr,
        numSamples,
        canvasFormat,
      );
      context._refractionSceneView = null;
      // Resize, HDR, or MSAA changes recreate the resolve
      // texture; force the next consumer to resolve into the fresh target so
      // post-process can never sample an uninitialized resolve (Trap 6).
      context._sceneColorResolvePending = true;
    }

    const previousSceneColorFormat = context._sceneColorFormat;
    context._sceneColorFormat =
      this._sceneFramebuffer.colorFormat ?? context._sceneColorFormat;
    const colorFormatChanged =
      context._sceneColorFormat !== undefined &&
      context._sceneColorFormat !== previousSceneColorFormat;
    if (colorFormatChanged || msaaChanged) {
      context._scenePipelineFormatGeneration += 1;
      // Every cached `GPURenderBundle` bakes its pipeline's color attachment
      // formats and sample count. When
      // either the scene color format flips (HDR toggle) or the MSAA
      // sample count changes, bundles that
      // reference the old pipeline are stale and produce validation
      // errors when replayed against the new pass encoder. Wipe the
      // bundle cache here. The shared
      // `_scenePipelineFormatGeneration` counter is also bumped so
      // generation-keyed pipeline caches (model PBR, billboards,
      // polylines, etc.) refresh on the next frame.
      context.renderBundleManager?.invalidateAll?.();
    }
  }

  /**
   * Ensure scene-level resources are created and sized.
   * Called once per frame before the frustum loop.
   */
  private _ensureResources(config: WebGPURenderFrameConfig): void {
    // Keep this wrapper because `executeCommands` calls the resource-ensure
    // helper through `this._ensureResources(config)`.
    ensureResources(this, config);
  }
  executeCommands(config: WebGPURenderFrameConfig): void {
    const { scene, context, passState, picking } = config;
    this._lastContext = context;
    this._lastOITRequested = config.useOIT === true;
    this._webgpuOITActiveThisFrame = false;
    this._gpuCullingRequestedMode =
      (scene as { gpuCullingHint?: "auto" | "always" | "never" })
        .gpuCullingHint ?? "never";

    // Stash the scene for `_resumeScenePass` and
    // `_clearDepthStencil` so they can read `scene._view.gBufferFramebuffer`
    // when MRT mode is on. Cleared in the picking-early-return below
    // and at the natural end of this method.
    this._scene = scene;

    // Snapshot the requested viewport once
    // per frame. `passState.viewport` is the BoundingRectangle the
    // caller (Scene / pick / OIT) requested; falls back to full canvas
    // when undefined. Bound + clamp to canvas so a stale rectangle
    // from a previous resize doesn't blow past the texture extents.
    const vp = (
      passState as unknown as {
        viewport?: { x: number; y: number; width: number; height: number };
      }
    ).viewport;
    // Bound against the LIVE canvas, not the cached resource pair. The cache
    // is republished by `_ensureResources`, which runs later in this same
    // method, so on the first frame after a resize it still holds the
    // previous extent — too large after a shrink, which is precisely the
    // overrun this clamp exists to prevent. `prepareFrame` has already
    // rebuilt the scene framebuffer at the current canvas size by this point.
    const clampCanvas: HTMLCanvasElement | OffscreenCanvas | undefined =
      context._canvas;
    const clampWidth = clampCanvas?.width ?? this._width;
    const clampHeight = clampCanvas?.height ?? this._height;
    if (vp) {
      this._viewportX = Math.max(0, vp.x | 0);
      this._viewportY = Math.max(0, vp.y | 0);
      // The `Math.max(0, ...)` outer clamp
      // prevents negative width/height when a stale split-screen rect
      // has its origin past the just-shrunk canvas. Negative
      // dimensions trip a WebGPU validation error and drop the frame;
      // clamping to 0 produces a degenerate-but-valid pass that
      // writes nothing this frame and recovers next.
      this._viewportWidth = Math.max(
        0,
        Math.min(clampWidth - this._viewportX, vp.width | 0),
      );
      this._viewportHeight = Math.max(
        0,
        Math.min(clampHeight - this._viewportY, vp.height | 0),
      );
    } else {
      this._viewportX = 0;
      this._viewportY = 0;
      this._viewportWidth = clampWidth;
      this._viewportHeight = clampHeight;
    }

    // --- PICK PASS: Render to pick framebuffer ---
    if (picking) {
      this._cpuPassProfiler.beginFrame();
      this._cpuPassProfiler.beginPass("pick");
      try {
        this._executePickPass(config);
      } finally {
        this._cpuPassProfiler.endPass("pick");
        this._cpuPassProfiler.endFrame();
      }
      // Pick frames also call
      // `modelFr.update`, which sets `_sceneHasTransmission` when a
      // transmissive primitive is in view. The pick branch doesn't run
      // the regular capture step and exits before the end-of-frame
      // reset, so the flag would leak into the next regular frame and
      // trigger an unnecessary capture there. Reset here to keep the
      // flag scoped to the frame that set it.
      context._sceneHasTransmission = false;
      // Clear the stashed scene reference on a pick
      // early-return so a regular frame that follows doesn't see a
      // stale scene ref if it somehow skips the executeCommands entry.
      this._scene = null;
      return;
    }

    const view = scene._view;
    const { frustumCommandsList } = view;
    const numFrustums: number = frustumCommandsList.length;
    const { uniformState } = context;

    // One-time diagnostic: confirm executeCommands is reached and show
    // the frustum count + usePostProcess value. If this never appears in
    // the console, the WebGPU scene renderer isn't being invoked at all.
    //>>includeStart('debug', pragmas.debug);
    if (!this._execDebugLogged) {
      this._execDebugLogged = true;
      console.log(
        `[WebGPU:SceneRenderer] executeCommands called — ` +
          `numFrustums=${numFrustums} ` +
          `usePostProcess=${config.usePostProcess} ` +
          `_postProcess=${!!this._postProcess} ` +
          `picking=${config.picking} ` +
          `sceneFramebuffer=${!!this._sceneFramebuffer}`,
      );
    }
    //>>includeEnd('debug');

    // A command-empty view can still contain screen-space environmental
    // content (most importantly a volumetric cloud deck while looking wholly
    // above the globe). Keep the original zero-work fast path only when no
    // environmental consumer is active. Demanded empty frames continue below:
    // the scene framebuffer is cleared, post-process reaches the canvas, and
    // the environmental chain composites over that valid empty scene.
    if (!shouldExecuteWebGPUSceneFrame(numFrustums, scene, context)) {
      return;
    }

    //>>includeStart('debug', pragmas.debug);
    // Temporary debug: log command counts once on first frame
    if (!this._debugLogged) {
      this._debugLogged = true;
      const passNames: Record<number, string> = {
        0: "ENVIRONMENT",
        2: "GLOBE",
        3: "TERRAIN_CLASS",
        8: "OPAQUE",
        9: "TRANSLUCENT",
      };
      for (let f = 0; f < numFrustums; f++) {
        const fc = frustumCommandsList[f];
        const counts: string[] = [];
        for (const [idx, name] of Object.entries(passNames)) {
          const cnt = fc.indices[Number(idx)] ?? 0;
          if (cnt > 0) counts.push(`${name}=${cnt}`);
        }
        if (counts.length > 0) {
          console.log(`[WebGPU] Frustum ${f}: ${counts.join(", ")}`);
        }
      }
    }
    //>>includeEnd('debug');

    // Ensure rendering resources are created/sized
    this._ensureResources(config);

    // Post-init diagnostic: log the ACTUAL resource state after
    // _ensureResources has had a chance to create everything. This is the
    // diagnostic that matters — the earlier one fires before init.
    //>>includeStart('debug', pragmas.debug);
    if (!this._postInitDebugLogged) {
      this._postInitDebugLogged = true;
      const sf = this._sceneFramebuffer;
      const pp = this._postProcess;
      console.log(
        `[WebGPU:SceneRenderer] POST-INIT state — ` +
          `_postProcess=${!!pp} hasActiveStages=${pp?.hasActiveStages} ` +
          `sceneFramebuffer=${!!sf} colorTarget=${!!sf?.colorTarget} ` +
          `depthStencilTexture=${!!sf?.depthStencilTexture} ` +
          `canvasTextureView=${!!context.currentTextureView} ` +
          `encoder=${!!context._currentCommandEncoder} ` +
          `oit=${!!this._oit} globeDepth=${!!this._globeDepth} ` +
          `depthPlane=${!!this._depthPlane}`,
      );
    }
    //>>includeEnd('debug');

    // Performance infrastructure: begin frame for render bundles, indirect draws, profiling
    //
    // In the Scene 2D two-pass wrap, `beginFrame` runs only on the
    // first pass (`sceneFbLoad` false) and `endFrame` only on the last pass
    // (`deferComposite` false), so the begin/end pair stays balanced across
    // the two `executeCommands` calls that render one frame.
    const perfManager = context.performanceManager;
    if (perfManager && !config.sceneFbLoad) {
      perfManager.beginFrame();
    }

    // Dispatch clustered-lighting compute passes once per frame before any
    // material draws. The dispatcher
    // internally checks scene.clusteredLightingEnabled + light count
    // and skips both compute passes when disabled or empty. Output
    // storage buffers + params uniform are bound by consumer
    // pipelines at @group(4) through the chunk in ClusteredLighting.wgsl.
    this._dispatchClusteredLighting(config);

    // Shadow casting is not dispatched here.
    // `SceneRenderer.executeShadowMapCastCommands` is the canonical,
    // backend-neutral site and the only place that populates
    // `ShadowMap.passes[j].commandList` (light-frustum + per-cascade culling of
    // `shadowState.casterCommands`), and it delegates to
    // `context.executeShadowMapCastCommands` immediately afterwards, before
    // `executeCommands` is ever reached.
    //
    // `WebGPUContext.executeShadowMapCastCommands` empties the per-pass command
    // lists when it finishes. Dispatching again here would collect no casters,
    // take the caster-less transition-clear branch, and wipe the depth written
    // by the canonical dispatch on the same command encoder before the color
    // pass samples it. Every receiver would then read an all-far depth map and
    // report fully lit.
    //
    // The `shadow` CPU-pass-profiler bucket goes with it: the dispatch no longer
    // happens inside the renderer's frame. `shouldClearShadowCastTarget` also
    // prevents a caster-less re-entry from wiping same-frame content.

    // Bias the opaque near plane to avoid cracks between adjacent frustums.
    const opaqueFrustumNearOffset: number =
      scene.opaqueFrustumNearOffset ?? 0.9999;

    // Redirect rendering from the canvas to the scene framebuffer.
    setupSceneFramebufferRenderPass(this, context, config);

    // Reset per-frame state before entering the frustum loop.
    resetPerFrameState(this, context);

    // The multi-frustum helper also owns 2D jitter because the jitter feeds
    // only that loop.
    this._beginDepthPlanePass(config, numFrustums);
    executeFrustumLoop(this, config, opaqueFrustumNearOffset);

    // The post-frustum chain owns overlays, the depth plane, environmental
    // effects, the invert composite, velocity, post-process, and teardown.
    //
    // On the first half of the Scene 2D wrap (`deferComposite`), skip
    // the chain entirely: the half just accumulates its draws into the scene
    // framebuffer. The pass it left open is closed + reopened with
    // loadOp="load" by the second half's `setupSceneFramebufferRenderPass`,
    // and the second half runs the chain once over the fully-accumulated FB.
    if (!config.deferComposite) {
      this._cpuPassProfiler.beginPass("postFrustumChain");
      try {
        executePostFrustumChain(this, context, config, frustumCommandsList);
      } finally {
        this._cpuPassProfiler.endPass("postFrustumChain");
      }
    }
  }

  // --- Pick pass: render to offscreen pick framebuffer ---

  /**
   * Execute the pick pass — renders all pickable commands to the pick
   * framebuffer using pick color output. The pick FBO info comes from
   * config.passState.framebuffer (set by WebGPUPickFramebuffer.begin()).
   *
   * During the pick pass, primitives push their pick commands (with pick
   * shaders that output pick color) to the commandList. We render those
   * commands to the pick FBO so readback can identify picked objects.
   *
   * Environment commands (sky, sun, moon, atmosphere) are skipped since
   * they do not generate pick IDs.
   */
  private _executePickPass(config: WebGPURenderFrameConfig): void {
    // Keep this wrapper because `executeCommands` calls the pick-pass helper as
    // `this._executePickPass(config)`.
    // A pick can be the first work after recovery. Rebuild only this resource
    // family here; do not allocate the full scene/postprocess graph on a pick
    // hot path. Device identity is part of the helper's exact reuse contract.
    ensureDepthPlane(this, config);
    const maximumDraws = config.scene._view.frustumCommandsList.length;
    this._beginDepthPlanePass(config, maximumDraws);
    executePickPass(this, config);
  }

  // --- Frustum state ---

  // Public underscore shared with the pick-pass module and the in-file callers.
  public _updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void {
    // Create a working frustum from the camera and update uniform state
    // This mirrors the WebGL path which creates a clone and sets near/far on it
    const camera = scene._frameState.camera;
    const cameraFrustum = camera.frustum;
    type CloneableFrustum = typeof cameraFrustum & {
      clone?: (result?: object) => CloneableFrustum;
      _near?: number;
      _far?: number;
      getProjectionMatrix?: (
        convention: WebGPUContext["clipSpaceConvention"],
      ) => CesiumMatrix4;
      getInfiniteProjectionMatrix?: (
        convention: WebGPUContext["clipSpaceConvention"],
      ) => CesiumMatrix4;
    };
    const sourceFrustum = cameraFrustum as CloneableFrustum;
    if (sourceFrustum && sourceFrustum.near !== undefined) {
      // Every built-in Cesium frustum implements clone(result). Reusing one
      // same-prototype clone keeps the per-frustum hot path allocation-free
      // while isolating near/far and projection-cache mutations from Camera.
      const existingScratch = this._frustumScratch as CloneableFrustum | null;
      const compatibleScratch =
        existingScratch !== null &&
        Object.getPrototypeOf(existingScratch) ===
          Object.getPrototypeOf(sourceFrustum)
          ? existingScratch
          : undefined;
      const frustum =
        typeof sourceFrustum.clone === "function"
          ? sourceFrustum.clone(compatibleScratch)
          : sourceFrustum;
      const usingScratch = frustum !== sourceFrustum;
      if (usingScratch) {
        this._frustumScratch = frustum;
      }
      const origNear = sourceFrustum.near;
      const origFar = sourceFrustum.far;
      frustum.near = near;
      frustum.far = far;
      // Force a near/far cache miss for this frustum band. The projection
      // query below and UniformState both receive the context convention
      // explicitly, so construction order cannot change clip-z semantics.
      frustum._near = NaN;
      frustum._far = NaN;

      // Apply the raster-space NDC jitter to the cloned frustum only.
      // UniformState clones both projections before the `finally` block
      // restores their exact cached values. The homogeneous-row translation
      // works for perspective and orthographic matrices and includes the
      // WebGPU framebuffer-Y conversion used by the resolve shader.
      const taaScene = scene as unknown as {
        taaEnabled?: boolean;
        _snapshotMode?: { isFrozen?: boolean };
        _alternateSceneRenderer?: {
          _postProcess?: {
            taaEffect?: {
              projectionJitterNdcX: number;
              projectionJitterNdcY: number;
            };
          };
        };
      };
      const taaEffect =
        taaScene._alternateSceneRenderer?._postProcess?.taaEffect;
      const jitterActive =
        taaScene.taaEnabled === true &&
        taaEffect !== undefined &&
        scene._frameState?.passes?.render === true &&
        taaScene._snapshotMode?.isFrozen !== true;
      let projection: CesiumMatrix4 | undefined;
      let infiniteProjection: CesiumMatrix4 | undefined;
      try {
        if (jitterActive) {
          const context = scene._frameState.context as unknown as WebGPUContext;
          projection = frustum.getProjectionMatrix?.(
            context.clipSpaceConvention,
          );
          if (projection === undefined) {
            throw new Error(
              "WebGPU frustum must support explicit clip-space projection",
            );
          }

          const projectionRestore =
            this._projectionJitterRestore ?? new Float64Array(16);
          this._projectionJitterRestore = projectionRestore;
          for (let i = 0; i < 16; i++) {
            projectionRestore[i] = projection[i];
          }
          applyProjectionJitterToScratch(
            projection,
            taaEffect.projectionJitterNdcX,
            taaEffect.projectionJitterNdcY,
          );

          if (typeof frustum.getInfiniteProjectionMatrix === "function") {
            infiniteProjection = frustum.getInfiniteProjectionMatrix(
              context.clipSpaceConvention,
            );
            const infiniteRestore =
              this._infiniteProjectionJitterRestore ?? new Float64Array(16);
            this._infiniteProjectionJitterRestore = infiniteRestore;
            for (let i = 0; i < 16; i++) {
              infiniteRestore[i] = infiniteProjection[i];
            }
            applyProjectionJitterToScratch(
              infiniteProjection,
              taaEffect.projectionJitterNdcX,
              taaEffect.projectionJitterNdcY,
            );
          }
        }

        uniformState.updateFrustum(frustum);
      } finally {
        if (projection !== undefined && this._projectionJitterRestore) {
          for (let i = 0; i < 16; i++) {
            projection[i] = this._projectionJitterRestore[i];
          }
        }
        if (
          infiniteProjection !== undefined &&
          this._infiniteProjectionJitterRestore
        ) {
          for (let i = 0; i < 16; i++) {
            infiniteProjection[i] = this._infiniteProjectionJitterRestore[i];
          }
        }
        // Custom frustum implementations may not provide clone(). Retain the
        // historical fallback but restore their public near/far in all cases.
        if (!usingScratch) {
          sourceFrustum.near = origNear;
          sourceFrustum.far = origFar;
        }
      }
    }
  }

  /**
   * Resume the scene-framebuffer render pass with `loadOp: "load"` on both
   * color and depth attachments — used after operations that must end the
   * pass to read the underlying textures (globe-depth copy, OIT depth peel,
   * 3D-tile depth update, edge MRT redirect, etc.). Mirrors the canvas-side
   * `resumeDefaultRenderPass`, but targets the scene framebuffer so that
   * downstream commands keep accumulating into the scene color + depth
   * textures the post-process chain reads from. Without this, every
   * intra-frame pass-end fell through to `resumeDefaultRenderPass`, which
   * re-opens the canvas swap-chain pass — silently redirecting all
   * subsequent draws away from the scene framebuffer and producing an
   * all-black canvas because the post-process chain blits an empty FB.
   */
  // Public underscore shared with the 3D Tiles pass module and in-file callers.
  public _resumeScenePass(context: WebGPUContext): void {
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    if (!colorTarget || !context._currentCommandEncoder) {
      // No scene FB yet, or no encoder — fall back to the canvas pass.
      context.resumeDefaultRenderPass?.();
      return;
    }
    // Open the resumed scene segment without an eager color resolve
    // (`resolve:false`); scene color resolves on demand via
    // `_ensureSceneColorResolved`. With no resolveTarget upstream the spread
    // below copies none through (I1), so no map-time deletion is needed.
    const rawColor: GPURenderPassColorAttachment[] | undefined =
      colorTarget.getColorAttachments?.(undefined, {
        resolve: context._sceneColorResolveElisionEnabled !== true,
      });
    let colorAttachments = rawColor?.map((a) => ({
      ...a,
      loadOp: "load" as GPULoadOp,
    }));
    const rawDepth = colorTarget.getDepthStencilAttachment?.();
    const depthStencilAttachment = rawDepth
      ? ({
          ...rawDepth,
          depthLoadOp: "load" as GPULoadOp,
          stencilLoadOp: "load" as GPULoadOp,
        } as GPURenderPassDepthStencilAttachment)
      : undefined;
    if (!colorAttachments?.length) {
      context.resumeDefaultRenderPass?.();
      return;
    }
    // Append the MRT slot-1 G-buffer attachment when
    // MRT mode is on. loadOp="load" preserves writes accumulated in the
    // pass that was just ended.
    const slot1 = buildMrtSlot1Attachment(this._scene, "load");
    if (slot1) {
      colorAttachments = [...colorAttachments, slot1];
    }
    // End through the context helper so the tracked pass target is
    // nulled alongside the encoder (a raw inline end would leave it stale).
    context.endCurrentRenderPass?.();
    const passDesc: GPURenderPassDescriptor = {
      label: "Scene Framebuffer Render Pass",
      colorAttachments,
      depthStencilAttachment,
    };
    const passEncoder = context.beginRenderPass(passDesc, "scene-framebuffer");
    if (!passEncoder) {
      return;
    }
    // Use the per-frame cached viewport so
    // split-screen and sub-viewport callers see their requested
    // rectangle. Falls through to full canvas via the snapshot in
    // `executeCommands`.
    passEncoder.setViewport(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
      0,
      1,
    );
    passEncoder.setScissorRect(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
    );
  }

  /**
   * Demand-driven resolve-on-consume for scene color. Scene-framebuffer
   * segments open without a `resolveTarget`
   * (`getColorAttachments({ resolve:false })`), so the multisampled color is no
   * longer resolved eagerly at every `pass.end()`, avoiding approximately ten
   * resolves per frame. Instead every resolved-color consumer (refraction capture,
   * OIT composite, invert-classification composite, bounding-volume debug, and
   * always the pre-post-process blit) calls this immediately before reading
   * `colorTarget.getColorTextureView(0)` / `context._sceneColorView`.
   *
   * Idempotent + conservative:
   * - `_msaaSamples <= 1` → no resolve target exists, and the resolve view is
   *   the attachment view, so this is inert and the non-multisampled path is
   *   unchanged.
   * - `_sceneColorResolvePending === false` → nothing has drawn to the scene FB
   *   since the last resolve; skip (this is what keeps a write-consumer's
   *   output — e.g. the fallback invert composite that draws into the
   *   single-sample resolve view — from being stomped by a redundant re-resolve
   *   before post-process, since `resumeDefaultRenderPass` opens the canvas
   *   pass and never re-dirties scene color).
   *
   * The resolve is a raw zero-draw pass on the frame command encoder (mirrors
   * `WebGPUSceneFramebuffer._clearTarget`) so it never touches the context's
   * tracked pass state (`_activePassTarget` / canvas-demand bookkeeping).
   *
   * @param context - The active WebGPU context.
   */
  public _ensureSceneColorResolved(context: WebGPUContext): void {
    if (context._sceneColorResolveElisionEnabled !== true) {
      // Kill switch off — the open sites baked eager resolveTargets, so the
      // resolve view is already current; the demand pass is inert.
      return;
    }
    if ((context._msaaSamples ?? 1) <= 1) {
      return;
    }
    if (context._sceneColorResolvePending !== true) {
      return;
    }
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const desc = colorTarget?.createColorResolvePassDescriptor?.();
    if (!desc) {
      // No resolve target (single-sample) or non-single-color target —
      // leave the flag set (conservative) and skip.
      return;
    }
    // Consumers already end their pass before reading; keep the call
    // idempotent so a stray active pass can't leak into the resolve.
    context.endCurrentRenderPass?.();
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (!encoder) {
      // No encoder (e.g. truncated frame) — leave dirty so a later
      // consumer with a valid encoder resolves.
      return;
    }
    const pass = encoder.beginRenderPass(desc);
    pass.end();
    context._sceneColorResolvePending = false;
    const actual = context._attachmentDemandActual;
    if (actual) {
      actual.sceneColorResolveOpens += 1;
    }
  }

  // Public underscore shared with the frustum-loop helper.
  public _clearDepthStencil(context: WebGPUContext): void {
    // ── Multi-frustum depth clear — CRITICAL for correct rendering ──
    //
    // Cesium splits the scene into multiple depth-range frustums to preserve
    // depth precision across ~10^7 meters of view distance. Between frustums
    // WebGL calls `gl.clear(DEPTH_BUFFER_BIT)` — depth is wiped while color
    // accumulates. This MUST happen or frustum N's depth values will
    // stomp the depth test in frustum N+1, producing black wedges across
    // the globe where far-frustum tiles occlude near-frustum tiles through
    // a corrupted depth buffer.
    //
    // WebGPU forbids mid-pass clears, so we end the active scene-framebuffer
    // pass and open a new one with `colorLoadOp: "load"` (preserve accumulated
    // color) + `depthLoadOp: "clear"` (reset depth). `getDepthStencilAttachment`
    // already defaults to depthLoadOp="clear", so we only override color.
    //
    // Decide from scene-framebuffer availability rather than the active pass
    // label. Per-frustum globe-depth copies, tile-depth updates, and translucent
    // depth capture can resume under the generic scene-pass label. A label gate
    // would then route the clear and subsequent draws to the canvas, leave the
    // scene framebuffer empty, and produce a black post-process blit.
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    if (colorTarget && context._currentCommandEncoder) {
      // A depth-clear re-open preserves accumulated color (`loadOp:"load"`)
      // but must not eagerly resolve it; scene color resolves
      // on demand (`resolve:false`).
      const rawColor: GPURenderPassColorAttachment[] | undefined =
        colorTarget.getColorAttachments?.(undefined, {
          resolve: context._sceneColorResolveElisionEnabled !== true,
        });
      let colorAttachments = rawColor?.map((a) => ({
        ...a,
        loadOp: "load" as GPULoadOp,
      }));
      const depthStencilAttachment = colorTarget.getDepthStencilAttachment?.();

      if (colorAttachments?.length) {
        // Append the MRT slot-1 G-buffer attachment
        // (loadOp="load" preserves accumulated writes from the prior
        // frustum's globe pass).
        const slot1 = buildMrtSlot1Attachment(this._scene, "load");
        if (slot1) {
          colorAttachments = [...colorAttachments, slot1];
        }
        context.endCurrentRenderPass?.();
        const passDesc: GPURenderPassDescriptor = {
          label: "Scene Framebuffer Render Pass",
          colorAttachments,
          depthStencilAttachment,
        };
        const passEncoder = context.beginRenderPass(
          passDesc,
          "scene-framebuffer",
        );
        if (!passEncoder) {
          return;
        }
        // Use the per-frame viewport.
        passEncoder.setViewport(
          this._viewportX,
          this._viewportY,
          this._viewportWidth,
          this._viewportHeight,
          0,
          1,
        );
        passEncoder.setScissorRect(
          this._viewportX,
          this._viewportY,
          this._viewportWidth,
          this._viewportHeight,
        );
        return;
      }
    }

    // Fallback for non-scene-FB passes (canvas direct, pick buffer, etc.)
    context.clear?.({ depth: 1.0, stencil: 0, color: false });
  }

  // Globe pass with GlobeDepth integration.

  // Public underscore shared with the frustum-loop helper.
  public _executeGlobePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const commands = frustumCommands.commands[Pass.GLOBE];
    const count: number = frustumCommands.indices[Pass.GLOBE];
    if (count === 0) {
      return;
    }

    // One-time GPU validation error scope on first globe pass
    const device: GPUDevice | undefined = context._device;
    if (device && !this._globeValidationDone) {
      this._globeValidationDone = true;
      device.pushErrorScope("validation");
      // Pop after frame to check for silent errors
      Promise.resolve().then(() => {
        device.popErrorScope().then((error: GPUError | null) => {
          if (error) {
            console.error(
              `[WebGPU:GlobePass] GPU VALIDATION ERROR: ${error.message}`,
            );
          } else {
            //>>includeStart('debug', pragmas.debug);
            console.log("[WebGPU:GlobePass] No GPU validation errors");
            //>>includeEnd('debug');
          }
        });
      });
    }

    context.uniformState?.updatePass(Pass.GLOBE);

    //>>includeStart('debug', pragmas.debug);
    // Diagnostic: is the render pass pointing at the scene framebuffer?
    if (!this._globePassRPLogged) {
      this._globePassRPLogged = true;
      const rp = context.currentRenderPassEncoder;
      console.warn(
        `[WebGPU:GlobePass] RENDER PASS CHECK — ` +
          `hasRenderPass=${!!rp} label="${rp?.label ?? "none"}" ` +
          `count=${count}`,
      );
    }

    // Diagnostic: log globe command count periodically
    if (
      !this._globeCountLogged ||
      this._globeCountLogFrame !== context._frameCount
    ) {
      // Throttle GlobePass log to once per 3 seconds
      const _now = performance.now();
      if (!this._globePassLastLog || _now - this._globePassLastLog > 3000) {
        this._globePassLastLog = _now;
        const hasPass = !!context.currentRenderPassEncoder;
        console.log(
          `[WebGPU:GlobePass] ${count} globe commands, ` +
            `renderPass=${hasPass}, frustumIdx=${this._currentFrustumIndex ?? "?"}`,
        );
      }
    }
    //>>includeEnd('debug');

    // Keep the diagnostic prelude here because its fields are stripped from
    // production builds. Updating the globe uniform pass at the end of the
    // prelude is required before the delegated dispatch begins.
    executeGlobeDispatch(commands, count, config);
  }

  // --- 3D Tiles passes ---

  // Public because the frustum loop delegates this pass through the renderer.
  public _execute3DTilePasses(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
    onAfterTileMainPass?: () => void,
  ): void {
    // Preserve the renderer entry point while delegating the pass implementation.
    execute3DTilePasses(this, frustumCommands, config, onAfterTileMainPass);
  }

  // --- Opaque pass ---

  // Public because the frustum loop delegates this pass through the renderer.
  public _executeOpaquePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    // Update this every frame so shadow-cascade diagnostics use the current
    // context rather than a context retained from an earlier frame.
    this._lastContext = context as WebGPUContext;
    const commands = frustumCommands.commands[Pass.OPAQUE];
    const count: number = frustumCommands.indices[Pass.OPAQUE];

    // Run frame-start bookkeeping at the top of every opaque pass, even when
    // the GPU cull gate is closed. This serves two purposes:
    //   1. Reset stats accumulators when frustum 0 starts a new
    //      frame, regardless of whether the GPU cull gate fires
    //      (the prior `_statsTickFrameIfNeeded` only ticked on
    //      successful filter calls — frustums where the gate was
    //      off skipped the reset and stats grew forever).
    //   2. Detect frustum-count changes (typical when the user
    //      toggles log-depth) and clear stale per-frustum gate
    //      Maps. Without this the Maps grow over a session and
    //      the cleared-frustum slots hold stale gate states.
    if (!config.picking && this._currentFrustumIndex === 0) {
      this._gpuCullLastInput = 0;
      this._gpuCullLastFiltered = 0;
      this._hiZLastInput = 0;
      this._hiZLastFiltered = 0;
      this._hiZConsumedThisFrame = false;
      this._gpuCullLastTranslucentInput = 0;
      this._gpuCullLastTranslucentFiltered = 0;
      this._sortConsumeAppliedThisFrame = false;
      this._statsLastFrameId++;

      const numFrustums =
        (scene as { _view?: { frustumCommandsList?: { length?: number } } })
          ?._view?.frustumCommandsList?.length ?? 0;
      const trimMap = (m: Map<number, unknown>): void => {
        for (const k of m.keys()) {
          if (k >= numFrustums) m.delete(k);
        }
      };
      trimMap(this._gpuCullActiveByFrustum);
      trimMap(this._gpuCullTranslucentActiveByFrustum);
      trimMap(this._hiZActiveByFrustum);
      trimMap(this._gpuSortActiveByFrustum);
      trimMap(this._lastCullResultsByFrustum);
    }

    if (count === 0) {
      return;
    }
    context.uniformState?.updatePass(Pass.OPAQUE);

    // Threshold-gated GPU culling is reserved for very large opaque batches.
    // CPU culling already runs upstream in `Scene.updateFrameState`,
    // but at the 10K-instance scale the GPU-side fine-grained re-test
    // (frustum from gpuCuller, occlusion from HiZ) still cuts draw-
    // call dispatch. The 1-frame readback latency is acceptable at
    // high densities — visibility doesn't flip frame-to-frame fast
    // enough for popping to be visible. Below the gpuCuller threshold
    // (count < 256) every helper returns the input array untouched,
    // so this path is a no-op for typical scenes.
    //
    // Pick passes skip GPU culling and hierarchical-Z filtering. Picking must
    // test every command the CPU
    // pass produced, including ones GPU culling would mark as
    // occluded — users can pick objects that are visually behind
    // others (e.g., through transparent overlays). Mismatching the
    // filter sets between render and pick produces ghost picks where
    // a visually-clicked pixel maps to the wrong (or no) feature.
    let activeCommands = commands as CesiumAnyDrawCommand[];
    let activeCount = count;

    // Each frustum keeps its own hysteresis state so
    // a 3-frustum scene with (2400, 500, 800) commands no longer
    // collapses through a single shared `_*Active` flag (which would
    // flip T→F→F within one frame, defeating the purpose of
    // hysteresis).
    //
    // `Scene.gpuCullingHint = "never"` short-circuits all three gates.
    //
    // Picking always bypasses these gates, and does not update them, because
    // the gates from pick passes either, since pick framerate is on-
    // demand and would skew hysteresis on the render path.
    const fIdx = this._currentFrustumIndex;
    const hint =
      (scene as { gpuCullingHint?: "auto" | "always" | "never" })
        .gpuCullingHint ?? "never";
    this._gpuCullingRequestedMode = hint;
    const forceOff = hint === "never";
    const gpuSortProducerRequested = this._gpuSortConsumeMode !== "never";

    let gpuCullActive = false;
    let hiZActive = false;
    let gpuSortActive = false;
    if (!config.picking && !forceOff) {
      gpuCullActive = this._updateActivationGate(
        this._gpuCullActiveByFrustum.get(fIdx) ?? false,
        count,
        WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
        WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
      );
      hiZActive = this._updateActivationGate(
        this._hiZActiveByFrustum.get(fIdx) ?? false,
        count,
        WebGPUSceneRenderer.HI_Z_THRESHOLD_HI,
        WebGPUSceneRenderer.HI_Z_THRESHOLD_LO,
      );
      if (gpuSortProducerRequested) {
        gpuSortActive = this._updateActivationGate(
          this._gpuSortActiveByFrustum.get(fIdx) ?? false,
          count,
          WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_HI,
          WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_LO,
        );
      }
    }
    this._gpuCullActiveByFrustum.set(fIdx, gpuCullActive);
    this._hiZActiveByFrustum.set(fIdx, hiZActive);
    this._gpuSortActiveByFrustum.set(fIdx, gpuSortActive);

    if (gpuCullActive) {
      const cv = (scene as { _frameState?: { cullingVolume?: unknown } })
        ?._frameState?.cullingVolume as
        | { planes: Array<{ x: number; y: number; z: number; w: number }> }
        | undefined;
      if (cv && cv.planes && cv.planes.length > 0) {
        // `gpuCullCommands` records a `beginComputePass`
        // ("frustum-N Compute Pass") on the frame encoder; like HiZ/sort it
        // must NOT run while the scene render pass is open (invalidates the
        // whole command buffer → dense-scene black screen). It is
        // asynchronous-latency work that consumes the prior frame's readback
        // synchronously, so bracketing the compute dispatch is sufficient;
        // resume restores the scene pass (loadOp:load) for executeBatch below.
        const wgpuCtx = context as WebGPUContext;
        wgpuCtx.endCurrentRenderPass?.();
        const culled = this.gpuCullCommands(
          activeCommands,
          wgpuCtx,
          cv,
          activeCount,
        );
        this._resumeScenePass(wgpuCtx);
        if (culled !== activeCommands) {
          activeCommands = culled;
          activeCount = culled.length;
        }
      }
    }
    // Apply HiZ visibility on top of the (already CPU + gpuCuller)
    // filtered list. This is a no-op when the per-frustum gate is closed,
    // picking or when no readback is available yet.
    if (hiZActive) {
      const occluded = this._filterByHiZVisibility(activeCommands, activeCount);
      if (occluded !== activeCommands) {
        activeCommands = occluded;
        activeCount = occluded.length;
      }
    }

    // Apply the GPU-produced front-to-back order to the opaque list only when
    // no cull/HiZ filtering dropped commands this frame (`activeCount ===
    // count`): the permutation indexes the ORIGINAL raw `commands` array,
    // so it can only be applied when the executed set is still the full
    // raw set (just possibly copied by the cull/HiZ passes, which
    // preserve order). When filtering dropped commands, cull/HiZ take
    // precedence and the CPU order stands (opaque order is a pure early-Z
    // optimization, so this is correct either way). The consumer defaults to
    // "never"; "auto" remains an explicit threshold probe. See
    // `_applySortedOrder` / `setGpuSortConsumeMode`.
    if (gpuSortActive && activeCount === count) {
      const reordered = this._applySortedOrder(
        commands as CesiumAnyDrawCommand[],
        count,
      );
      if (reordered !== commands && reordered.length === count) {
        activeCommands = reordered;
        activeCount = count;
      }
    }

    executeBatch(
      activeCommands as typeof commands,
      activeCount,
      scene,
      context,
      passState,
    );

    // After this frame's opaque pass writes depth, dispatch the
    // build-pyramid + occlusion test for the NEXT frame using the
    // pre-cull command list so the SOA aligns with what next frame
    // will receive. Below threshold this is a fast no-op.
    //
    // Pick passes skip dispatch because their separate depth target would feed
    // misleading visibility into the next render frame's HiZ
    // filtering. Pick passes also typically run on demand (mouse
    // events) — dispatching there wastes GPU time on a buffer that
    // never feeds a render frame.
    // The producer uses the same per-frustum hysteresis as the consumer.
    // Both hierarchical-Z and GPU-sort-key dispatches record
    // `beginComputePass` on the frame encoder. Doing that while the scene
    // framebuffer render pass is still open is a "CommandEncoder is locked
    // while RenderPassEncoder is open" validation error that invalidates the
    // entire command buffer, black-screening dense WebGPU scenes with at
    // least 2400 opaque commands. Bracket the compute dispatches with
    // endCurrentRenderPass / resumeDefaultRenderPass exactly like the
    // clustered-lighting + velocity compute dispatches do (resume preserves
    // scene-FB contents via loadOp:load, so the frustum loop continues
    // seamlessly). Only pay the pass end/resume when a dispatch will fire.
    if (hiZActive || gpuSortActive) {
      const wgpuCtx = context as WebGPUContext;
      wgpuCtx.endCurrentRenderPass?.();
      if (hiZActive) {
        this._dispatchHiZForNextFrame(
          wgpuCtx,
          commands as CesiumAnyDrawCommand[],
          count,
          frustumCommands,
        );
      }
      if (gpuSortActive) {
        this._dispatchGPUSortKeys(
          wgpuCtx,
          commands as CesiumAnyDrawCommand[],
          count,
        );
      }
      this._resumeScenePass(wgpuCtx);
    }
  }

  // --- Translucent pass (with OIT integration) ---

  // Public because the frustum loop delegates this pass through the renderer.
  public _executeTranslucentPass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    // Preserve the renderer entry point while delegating the pass implementation.
    // The extracted function reaches back via the `TranslucentPassHost`
    // interface for `_oit` (read) and `_deferredOITSplats` (read +
    // null on consume).
    executeTranslucentPass(this, frustumCommands, config);
  }

  // --- Overlay pass ---

  // Public because the post-frustum chain delegates this pass through the renderer.
  public _executeOverlayPass(
    frustumCommandsList: CesiumFrustumCommands[],
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    // Overlay commands are in the nearest frustum (index 0)
    const nearestFrustum = frustumCommandsList[0];
    if (!nearestFrustum) {
      return;
    }
    const commands = nearestFrustum.commands[Pass.OVERLAY];
    const count: number = nearestFrustum.indices[Pass.OVERLAY];
    if (count === 0) {
      return;
    }
    context.uniformState?.updatePass(Pass.OVERLAY);
    executeBatch(commands, count, scene, context, passState);
  }

  // --- Depth plane ---

  /** Reserve exact per-frustum uniform slices before encoding any draw. */
  private _beginDepthPlanePass(
    config: WebGPURenderFrameConfig,
    maximumDraws: number,
  ): void {
    if (!this._depthPlane || !config.useDepthPlane) {
      return;
    }
    const device: GPUDevice | undefined = config.context._device;
    if (!device) {
      return;
    }
    try {
      this._depthPlane.beginPass(
        config.scene._frameState,
        device,
        Math.max(1, maximumDraws),
      );
    } catch (e: unknown) {
      if (!this._depthPlaneWarned) {
        config.context.log(
          "warn",
          `DepthPlane preparation error (suppressed): ${(e as Error).message}`,
        );
        this._depthPlaneWarned = true;
      }
    }
  }

  // Public because the frustum loop delegates this pass through the renderer.
  public _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: WebGPUDepthPlanePassKind,
  ): void {
    if (!this._depthPlane || !config.useDepthPlane) {
      return;
    }
    const { scene, context } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    try {
      // Update depth plane geometry based on camera
      this._depthPlane.update(scene._frameState, device);

      // Execute depth plane draw into the active render pass
      const renderPass: GPURenderPassEncoder | undefined =
        context.currentRenderPassEncoder;
      if (renderPass) {
        this._depthPlane.execute(renderPass, passKind);
      }
    } catch (e: unknown) {
      // Depth plane is non-essential — log warning but don't crash rendering
      if (!this._depthPlaneWarned) {
        context.log(
          "warn",
          `DepthPlane error (suppressed): ${(e as Error).message}`,
        );
        this._depthPlaneWarned = true;
      }
    }
  }

  // --- Environmental effects (clouds, SSR, weather) ---

  /**
   * Execute environmental effects that composite onto the rendered scene.
   * These display-space effects run after the main post-processing pass. Each
   * effect reads scene color and depth and composites its result.
   *
   * Order: Procedural Clouds → SSR → Weather Particles
   * - Clouds are behind geometry (atmosphere-level)
   * - SSR modifies surface reflections
   * - Weather is in front (camera-relative particles)
   */
  // Public because the post-frustum chain delegates this pass through the renderer.
  public _executeEnvironmentalEffects(config: WebGPURenderFrameConfig): void {
    // The implementation has no renderer state dependencies, so it remains a
    // free function behind this stable renderer entry point.
    executeEnvironmentalEffects(config);
  }

  /**
   * Reconstructs screen-space normals from scene depth into
   * `view.gBufferFramebuffer` when the primary pipelines do not populate it.
   *
   * In multiple-render-target mode, per-shader `@location(1)` outputs from
   * converted globe, ellipsoid, and glTF model primitives are the source of
   * truth. The compute producer must not overwrite those fragment values.
   *
   * The compute producer is therefore skipped when that mode is active and
   * the G-buffer is allocated. Three implications follow:
   *
   *   - Pixels covered by an MRT-emitting pipeline (globe + ellipsoid +
   *     Model) keep their real per-fragment data.
   *   - Pixels covered by placeholder pipelines (`writeMask: 0`
   *     on slot 1: sky, billboards, labels, points, etc.) keep the
   *     loadOp=clear sentinel (0,0,0,1).
   *   - The AO / SSR / contact-shadow consumers already check
   *     `length(xyz) < 0.01` and fall back to their own depth-derived
   *     path for sentinel pixels — no consumer change needed.
   *
   * The post-frustum chain calls this after the scene render pass closes and
   * before invert classification, velocity, and post-processing.
   */
  public _executeGBufferProducer(config: WebGPURenderFrameConfig): void {
    const frameState = config.scene.frameState as
      { useDeferredLighting?: boolean } | undefined;
    if (!frameState || frameState.useDeferredLighting !== true) {
      return;
    }
    // Skip the compute producer in multiple-render-target mode. Converted
    // primitives' `@location(1)` outputs are the source
    // of truth; non-emitting primitives leave the loadOp=clear
    // sentinel (0,0,0,1) and consumers fall back to depth-derived for
    // those pixels via the existing length(xyz) < 0.01 check.
    if (isSceneFBMrtMode()) {
      return;
    }
    const context = config.context as unknown as {
      _currentCommandEncoder: GPUCommandEncoder | null;
      device: GPUDevice | null;
      drawingBufferWidth: number;
      drawingBufferHeight: number;
      uniformState?: { inverseProjection?: ArrayLike<number> };
      endCurrentRenderPass?: () => void;
      resumeDefaultRenderPass?: () => void;
    };
    // Close any render pass still open on the shared command encoder before
    // starting a
    // compute pass. WebGPU forbids `beginComputePass` while a render
    // pass is recording on the same encoder. The post-frustum chain
    // calls us right after `_executeEnvironmentalEffects`, which may
    // leave the scene render pass open if it didn't enter
    // post-process mode yet.
    context.endCurrentRenderPass?.();
    const encoder = context._currentCommandEncoder;
    const device = context.device;
    // Read the depth written by the scene framebuffer, which is also the
    // source used by the depth debug overlay. `context.depthOnlyTextureView`
    // belongs to a separate attachment; binding it here produces zero-depth
    // samples, degenerate unprojected positions, and an all-sentinel G-buffer.
    const depthView = this._sceneFramebuffer?.depthSampleableView ?? null;
    if (!encoder || !device || !depthView) {
      // Surface a missing command encoder, device, or sampleable scene-depth
      // view instead of silently omitting the G-buffer producer. Multisampled
      // depth is converted to a sampleable single-sample view when resources
      // are available.
      if (!this._gbufferProducerWarnedNoDepth) {
        this._gbufferProducerWarnedNoDepth = true;
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          "[Phase8a] G-buffer producer skipped: scene depth not sampleable. " +
            "Set `msaaSamples: 1` on the Viewer/Scene to enable. " +
            "MSAA support is tracked as Slice 2d.",
        );
        //>>includeEnd('debug');
      }
      return;
    }

    const scene = config.scene as unknown as {
      _view?: {
        gBufferFramebuffer?: {
          framebuffer?: unknown;
          normalRoughnessTexture: GPUTextureView | null;
        };
      };
    };
    const gBuffer = scene._view?.gBufferFramebuffer;
    const outputView = gBuffer?.normalRoughnessTexture ?? null;
    if (!outputView) return;

    const invProj = context.uniformState?.inverseProjection;
    if (!invProj) return;

    const w = context.drawingBufferWidth || 1;
    const h = context.drawingBufferHeight || 1;
    const invProjArr =
      invProj instanceof Float32Array ? invProj : new Float32Array(invProj);

    // The dispatcher host is the `WebGPUPerformanceManager`, not the
    // SceneRenderer — the PerfMgr owns the compute pipeline cache, the
    // `dispatchCompute` method, and the `_context.supportsComputeShaders`
    // capability flag. The cache slot for G-buffer resources also lives
    // on the PerfMgr (parallel to `_atmosphereLutResources`).
    const ctxWithPerfMgr = config.context as unknown as {
      performanceManager?: GBufferComputeHost;
    };
    const perfMgr = ctxWithPerfMgr.performanceManager;
    if (!perfMgr) return;

    // Pass the scene's sample count so the dispatcher selects the matching
    // depth pipeline. Read from `scene.msaaSamples`
    // directly; this is the same value `SceneFramebuffer.update` uses
    // to build the depth attachment, so the dispatcher's choice of
    // pipeline matches the actual texture's sample count.
    const depthSampleCount =
      (config.scene as unknown as { msaaSamples?: number }).msaaSamples ?? 1;
    dispatchGBufferNormalsFromDepth(perfMgr, encoder, device, {
      inverseProjection: invProjArr,
      viewportWidth: w,
      viewportHeight: h,
      depthView,
      outputView,
      depthSampleCount,
    });
    // Resume the scene render pass for downstream stages (invert
    // classification composite, velocity pass, post-process). Matches
    // the pattern used by `_executeDebugDepthOverlay` /
    // `executeEnvironmentalEffects`.
    context.resumeDefaultRenderPass?.();
  }

  // Models consume edges in their inline fragment stage; primitive shaders do
  // not currently emit edges. A future non-model edge emitter must either add
  // an equivalent inline stage to its shader family or restore a post-process
  // composite.

  // The depth-sample classifier draws translucent tile classification
  // directly into scene color, so there is no accumulation target to
  // composite afterward.

  // --- InvertClassification composite ---

  /**
   * Pairs with the framebuffer redirect in {@link _execute3DTilePasses}. When
   * the redirect is
   * active, 3D-tile pixels go into `InvertClassification.classifiedTexture`
   * instead of scene color; this method composites them back onto the
   * resolved scene color view so the frame has tiles in the final image.
   *
   * Runs after the main scene render pass ends, which is required
   * because the composite targets the single-sample resolved view
   * (`colorTarget.getColorTextureView(0)`) and the MSAA attachment
   * only resolves on pass end. Wrapped in end/resume so post-process
   * continues to see the scene pass active on resume.
   *
   * No-op when InvertClassification is disabled or not ready — the
   * tile pass went to the default path and scene color already has
   * the tiles in place.
   */
  // Public because the post-frustum chain delegates this pass through the renderer.
  public _runInvertClassificationComposite(
    config: WebGPURenderFrameConfig,
  ): void {
    if (!config.useInvertClassification) {
      return;
    }
    const { scene, context } = config;
    const invertOwner = (
      scene as unknown as {
        _invertClassification?: CesiumObjectWithWebGPUCache;
      }
    )._invertClassification;
    if (!invertOwner || !isInvertClassificationReady(invertOwner)) {
      return;
    }

    // Each ground and vector-tile classifier renderer emits a dedicated
    // `IGNORE_SHOW` stencil-write command alongside its color
    // command for 3D-Tile classification. The dispatcher in
    // `WebGPUSceneRenderer3DTilePasses.ts` runs those commands inside the
    // invert FBO and flips `invertHasStencilData = true` once the
    // CLASSIFICATION_IGNORE_SHOW pass ran with > 0 commands, which makes
    // the stencil-gated composite branch in `runInvertCompositeFromTracker`
    // active.

    // End the current scene pass so the composite can run outside a render
    // pass, then resolve multisampled color into the single-sample view on
    // demand. Both the stencil-gated path
    // (writes MSAA + auto-resolves at its own pass end) and the fallback path
    // (writes the resolved view directly) require the resolved view to already
    // hold the accumulated scene color. The ensure is inert without MSAA.
    context.endCurrentRenderPass?.();
    this._ensureSceneColorResolved(context);

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const resolveView: GPUTextureView | undefined =
      colorTarget?.getColorTextureView?.(0);

    // When the stencil-ready flag is set, the
    // `CLASSIFICATION_IGNORE_SHOW` pass has written stencil
    // bits into the invert FBO), pass the MSAA scene-color attachment
    // view so the composite can run at MSAA sample count alongside
    // the MSAA invert depth-stencil. Otherwise fall back to the
    // single-sample, single-pass composite.
    //
    // `GPURenderPassColorAttachment.view` is typed `GPUTexture | GPUTextureView`
    // by `@webgpu/types`, but our `WebGPURenderTarget` always stores a
    // `GPUTextureView` in its `RenderTargetAttachment.view` field. Narrow
    // here so the composite call site sees the precise type it requires.
    const rawAttachmentView =
      this._invertClassStencilReady && colorTarget?.getColorAttachments
        ? colorTarget.getColorAttachments()[0]?.view
        : undefined;
    const sceneAttachmentView: GPUTextureView | undefined =
      rawAttachmentView !== undefined && "createView" in rawAttachmentView
        ? rawAttachmentView.createView()
        : (rawAttachmentView as GPUTextureView | undefined);

    if (encoder && resolveView) {
      executeInvertClassificationComposite(
        invertOwner,
        encoder,
        resolveView,
        sceneAttachmentView,
        this._invertClassStencilReady,
      );
    } else {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[WebGPU:SceneRenderer] InvertClassification composite skipped ` +
          `— encoder=${!!encoder} resolveView=${!!resolveView}`,
      );
      //>>includeEnd('debug');
    }

    // Resume default scene pass for any remaining work (post-process
    // starts by ending the pass itself, so the resume here is cheap).
    context.resumeDefaultRenderPass?.();
  }

  // --- KHR_materials_transmission refraction capture ---

  /**
   * Captures opaque-only scene color into the scene framebuffer's refraction
   * target so transmissive model primitives drawn in the translucent pass can sample the
   * scene behind them without their own contribution. Runs once per
   * frustum, between the opaque/voxels/splats passes and the
   * TRANSLUCENT pass. Gated on `context._sceneHasTransmission` (set
   * by `WebGPUModelRenderer` when a transmissive primitive emits a
   * command this frame); frames with no transmissive content pay
   * zero cost.
   *
   * Implementation: end the current scene render pass, copy scene
   * color → refraction texture via `copyTextureToTexture` (same-
   * format blit), publish the refraction view on the context for
   * the model bind-group rebuilder to pick up, then resume the scene
   * pass. MSAA scenes use the resolved color (returned by
   * `colorTarget.getColorTexture` when a resolve target exists).
   *
   * Multi-frustum scenes capture once per frustum: each frustum's
   * transmissive draws see that frustum's opaque backdrop. The
   * refraction texture is overwritten between frustums so the
   * latest capture wins; for transmission, that's correct because
   * a glass surface in frustum N should refract content drawn up
   * to frustum N (the per-frustum opaque writes accumulate into
   * the same scene color across frustums in the WebGPU pipeline).
   */
  // Public because the frustum loop delegates this pass through the renderer.
  public _captureRefractionScene(config: WebGPURenderFrameConfig): void {
    const { context } = config;
    if (!context._sceneHasTransmission || !this._sceneFramebuffer) {
      return;
    }
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    // End the scene pass for the copy, then resolve multisampled color on
    // demand. The refraction source is the resolved color texture returned by
    // `colorTarget.getColorTexture()`. The ensure is inert without MSAA.
    context.endCurrentRenderPass?.();
    this._ensureSceneColorResolved(context);
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (!encoder) {
      // Without an encoder we can't issue the copy — resume the scene
      // pass anyway so subsequent work doesn't run into a half-closed
      // pass.
      this._resumeScenePass(context);
      return;
    }

    const captured = this._sceneFramebuffer.captureRefraction(
      device,
      encoder,
      this._width,
      this._height,
    );
    if (captured) {
      context._refractionSceneView = this._sceneFramebuffer.refractionView;
    }
    this._resumeScenePass(context);
  }

  // --- TAA velocity pass ---

  /**
   * Writes per-pixel motion vectors for models.
   *
   * Walks the frustum command lists, collects every command carrying a
   * `velocityCommand` slot (attached by `WebGPUModelRenderer` when
   * `frameState.taaEnabled === true` and the primitive is opaque/mask),
   * and dispatches them into a dedicated `rg16float` render pass that
   * shares the scene framebuffer's depth attachment in read-only mode. The
   * resulting velocity texture is consumed by the TAA effect at
   * `@binding(5) motionTex`; TAA prefers per-pixel velocity
   * over depth reprojection when the sample is non-zero, falling back
   * to depth reprojection for static pixels (sky, terrain).
   *
   * Architecture rationale: a separate pass instead of single-pass MRT
   * because the main scene pass is shared by globe / primitive /
   * billboard / model pipelines, all of which would need a 2nd color
   * target slot just to satisfy WebGPU's pipeline-vs-renderpass
   * attachment-count parity rule. Routing velocity through a
   * model-only secondary pass keeps the cross-cutting cost zero.
   *
   * Translucent (BLEND) primitives are excluded by the model renderer:
   * they don't write scene depth in the color pass, so the velocity
   * pass's read-only depth attachment can't establish their visibility
   * Translucent velocity therefore requires a separate OIT-style accumulation
   * path that is not currently implemented.
   *
   * Free for static scenes: when no command carries a velocityCommand
   * (TAA off, or no models in view), the function early-exits before
   * any GPU work is queued.
   */
  // Public because the post-frustum chain delegates this pass through the renderer.
  /**
   * Per-frame hook for Forward+ clustered lighting. Walks scene lights, then
   * hands the collected list and the current view and projection matrices to
   * the clustered-lighting dispatcher. Per-model glTF lights stay excluded
   * until their model transforms can be applied before packing.
   * The dispatcher packs the WGSL light layout and records both compute passes
   * into the active command encoder.
   *
   * Called early in executeCommands (after _ensureResources, before
   * any consumer draw) so the storage buffers are ready when Model
   * PBR and lit-material consumers read them.
   *
   * Inert when scene.clusteredLightingEnabled === false OR zero
   * lights are configured — the dispatcher returns activeLightCount=0
   * and consumer FS chunks gate on that value to skip the cluster
   * read entirely.
   *
   * @private
   */
  private _dispatchClusteredLighting(config: WebGPURenderFrameConfig): void {
    // The helper needs only the dispatcher and viewport dimensions exposed by
    // the minimal `ClusteredLightingHost` surface.
    dispatchClusteredLighting(this, config);
  }

  /**
   * Public accessor for the clustered-lighting dispatcher's GPU buffers.
   * Model PBR and lit-material pipelines use these handles in their bind
   * groups.
   *
   * Returns null when the dispatcher hasn't been constructed yet
   * (first frame before any executeCommands call) — caller should
   * use placeholder buffers in that case.
   */
  public _getClusteredLightingBuffers(): ClusteredLightingBuffers | null {
    return getClusteredLightingBuffers(this);
  }

  public _runVelocityPass(config: WebGPURenderFrameConfig): void {
    const { context, scene } = config;
    if (!scene?.taaEnabled || !this._sceneFramebuffer) {
      return;
    }
    const view = scene._view;
    const frustumCommandsList = view?.frustumCommandsList;
    if (!frustumCommandsList || frustumCommandsList.length === 0) {
      return;
    }

    let anyVelocity = false;
    for (let f = 0; f < frustumCommandsList.length && !anyVelocity; f++) {
      const fc = frustumCommandsList[f];
      if (!fc) continue;
      const passes = fc.commands;
      const indices = fc.indices;
      for (let p = 0; p < passes.length && !anyVelocity; p++) {
        const arr = passes[p] as Array<{ velocityCommand?: unknown }>;
        const cnt = indices[p] ?? 0;
        for (let i = 0; i < cnt; i++) {
          if (arr[i]?.velocityCommand) {
            anyVelocity = true;
            break;
          }
        }
      }
    }
    if (!anyVelocity) {
      return;
    }

    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }
    const width = this._width;
    const height = this._height;
    const velocityView = this._sceneFramebuffer.ensureVelocityTexture(
      device,
      width,
      height,
    );
    const colorTarget = this._sceneFramebuffer.colorTarget;
    const depthView = colorTarget?.getDepthTextureView?.();
    if (!velocityView || !depthView) {
      return;
    }

    context.endCurrentRenderPass?.();
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (!encoder) {
      return;
    }

    // Read-only depth + stencil so the same depth-stencil attachment
    // the main scene pass just wrote is reusable here without a copy.
    // The velocity pipeline declares `depthWriteEnabled: false`, so
    // there's nothing to commit on store.
    const passDesc: GPURenderPassDescriptor = {
      label: "TAA Velocity Pass",
      colorAttachments: [
        {
          view: velocityView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthReadOnly: true,
        stencilReadOnly: true,
      },
    };

    const passEncoder = encoder.beginRenderPass(
      context.withRenderPassTimestamps(passDesc, "TAA Velocity Pass"),
    );
    // Use the per-frame viewport rather than the full canvas so the velocity
    // pass writes only into the requested
    // sub-rectangle (matches the main color pass).
    passEncoder.setViewport(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
      0,
      1,
    );
    passEncoder.setScissorRect(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
    );

    context._currentRenderPassEncoder = passEncoder;

    for (let f = 0; f < frustumCommandsList.length; f++) {
      const fc = frustumCommandsList[f];
      if (!fc) continue;
      const passes = fc.commands;
      const indices = fc.indices;
      for (let p = 0; p < passes.length; p++) {
        const arr = passes[p] as Array<{
          velocityCommand?: { execute?: (e: GPURenderPassEncoder) => void };
        }>;
        const cnt = indices[p] ?? 0;
        for (let i = 0; i < cnt; i++) {
          const velocityCmd = arr[i]?.velocityCommand;
          if (velocityCmd?.execute) {
            try {
              velocityCmd.execute(passEncoder);
            } catch (e: unknown) {
              const warned = _getWarnedCommands(context);
              const key = `velocity:${(e as Error).message?.substring(0, 80)}`;
              if (!warned.has(key)) {
                warned.add(key);
                context.log?.(
                  "warn",
                  `[TAA Velocity] Command failed: ${(e as Error).message}`,
                );
              }
            }
          }
        }
      }
    }

    passEncoder.end();
    context._currentRenderPassEncoder = null;
  }

  // --- Post-processing ---

  // Public because the post-frustum chain delegates this pass through the renderer.
  public _runPostProcessing(config: WebGPURenderFrameConfig): void {
    const { context, scene } = config;
    const frameState = scene?._frameState;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    // Tier 2 debug — depth-as-color override. When the flag is on we
    // skip the entire production post-process chain and replace it with
    // a single fullscreen depth visualization pass. The check happens
    // *before* the early-out so the debug pass works even when
    // post-process is otherwise disabled.
    if (frameState?.debugShowDepthAsColor === true) {
      this._executeDebugDepthOverlay(config);
      return;
    }

    // G-buffer normal visualization replaces the production post-process
    // chain with a fullscreen blit
    // of `view.gBufferFramebuffer.normalRoughnessTexture`. Requires the
    // G-buffer to be populated; the `CesiumDebug.showGBufferNormals()`
    // command forces `scene.deferredLighting = true` to guarantee that.
    if (
      (frameState as { debugShowGBufferNormals?: boolean })
        ?.debugShowGBufferNormals === true
    ) {
      this._executeDebugGBufferOverlay(config);
      return;
    }

    // Tier 2 debug — frustum / command tint override. Same pattern as
    // depth-as-color: replaces the production post-process chain with a
    // single fullscreen tint pass that samples scene color + depth and
    // multiplies by a per-frustum or per-depth-bucket palette. See
    // `WebGPUDebugFrustumOverlay` for the rationale on why this is a
    // post-process instead of a DebugInspector-style per-command shader
    // clone. `debugShowFrustums` takes priority over `debugShowCommands`
    // when both are on, matching the WebGL ordering.
    if (
      frameState?.debugShowFrustums === true ||
      frameState?.debugShowCommands === true
    ) {
      const mode = frameState.debugShowFrustums === true ? 0 : 1;
      this._executeDebugFrustumOverlay(config, mode);
      return;
    }

    if (!this._postProcess || !config.usePostProcess) {
      // This is a CRITICAL error on WebGPU: without the post-process
      // pipeline the scene framebuffer never gets blitted to the visible
      // canvas, resulting in an all-black output. Log as error (not warn)
      // so it's impossible to miss in the console.
      context.log(
        "error",
        `[PostProcess] CRITICAL — post-process pipeline not active! ` +
          `postProcess=${!!this._postProcess} usePostProcess=${config.usePostProcess}. ` +
          `The WebGPU canvas will be BLACK. Ensure FramebufferOrchestrator sets ` +
          `usePostProcess=true for WebGPU (context.isWebGPU must be true).`,
      );
      return;
    }

    // End the current render pass so we can read the scene texture
    context.endCurrentRenderPass?.();

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const sourceView: GPUTextureView | undefined =
      colorTarget?.getColorTextureView?.(0);
    const targetView: GPUTextureView | undefined = context.currentTextureView;

    // Get depth texture view for depth-dependent effects (AO, DoF)
    const depthView: GPUTextureView | undefined = context._depthStencilView;

    if (encoder && sourceView && targetView) {
      // Pass the scene color texture for auto-exposure compute dispatch.
      const sceneColorTexture = colorTarget?.getColorTexture?.(0) ?? null;
      // Forward the velocity texture populated by the model velocity pass.
      // When no command produced velocity, the TAA effect binds its 1×1 zero
      // placeholder and falls back to depth reprojection.
      const motionView = this._sceneFramebuffer?.velocityView ?? null;
      // Bloom intensity fades from 1.0 at ground level to 0.0 above one Earth
      // radius of
      // altitude. Real orbital photography shows essentially zero
      // bloom on the Earth disk; treating bloom as a camera-lens
      // effect (Frostbite GDC 2016 convention) and gating by
      // altitude matches that without disrupting ground-level
      // bloom for cityscape / atmospheric demos. Always called
      // per-frame; the `enableAltitudeGate` flag on `BloomConfig`
      // controls whether the gate actually fires.
      const bloomEffect = (
        this._postProcess as unknown as {
          bloomEffect?: { applyAltitudeGate?: (h: number) => void };
        }
      ).bloomEffect;
      const heightMeters =
        frameState?.camera?.positionCartographic?.height ?? 0;
      if (bloomEffect?.applyAltitudeGate) {
        bloomEffect.applyAltitudeGate(heightMeters);
      }
      // The auto-exposure altitude gate is paired with bloom. Its inexpensive
      // compute reduction still runs,
      // but its multiplier blends toward neutral 1.0 as the camera rises
      // above the gate range, so the bright atmosphere limb doesn't pull
      // exposure down and darken the visible disk at orbit. Ground-level
      // demos (cityscape, atmospheric photography) keep full eye
      // adaptation. Real-camera fixed-exposure parity for orbit views.
      const autoExposure = (
        this._postProcess as unknown as {
          autoExposure?: { applyAltitudeGate?: (h: number) => void };
        }
      ).autoExposure;
      if (autoExposure?.applyAltitudeGate) {
        autoExposure.applyAltitudeGate(heightMeters);
      }
      // When deferred lighting populated the G-buffer this frame, forward the
      // normal texture view so ambient occlusion and other consumers
      // can read it. Null otherwise → effects fall back to depth-only
      // reconstruction.
      const view = (
        config.scene as unknown as {
          _view?: {
            gBufferFramebuffer?: {
              normalRoughnessTexture: GPUTextureView | null;
            };
          };
        }
      )._view;
      const useDeferred =
        (config.scene.frameState as { useDeferredLighting?: boolean })
          .useDeferredLighting === true;
      const gBufferNormalView = useDeferred
        ? (view?.gBufferFramebuffer?.normalRoughnessTexture ?? null)
        : null;
      this._postProcess.execute(
        encoder,
        sourceView,
        targetView,
        depthView,
        sceneColorTexture,
        motionView,
        gBufferNormalView,
      );
      // The post-process pipeline writes the canvas `targetView` through raw
      // `encoder.beginRenderPass` calls that the context
      // cannot observe. Mark the canvas written so no later default-pass
      // open clears the blit and the endFrame present fallback stays off.
      context.markCanvasContentWritten();
    } else {
      context.log(
        "warn",
        `[PostProcess] MISSING: encoder=${!!encoder} sourceView=${!!sourceView} targetView=${!!targetView}`,
      );
    }

    // Do not open an unconditional canvas pass here. Downstream consumers
    // manage their own passes: the snapshot copy ends passes, environmental effects
    // end+resume around themselves, and legacy overlay commands demand-open
    // the canvas pass in `WebGPUContext.executeDrawCommand`.
  }

  /**
   * Tier 2 debug — runs the standalone {@link WebGPUDebugDepthOverlay}
   * pass instead of the production post-process chain. Lazily constructs
   * the overlay on first invocation so production frames pay zero cost.
   * Reads camera near/far from the scene's uniform state for depth
   * linearization.
   */
  private _executeDebugDepthOverlay(config: WebGPURenderFrameConfig): void {
    const { context, scene } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    context.endCurrentRenderPass?.();

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const targetView: GPUTextureView | undefined = context.currentTextureView;
    // This overlay binds `texture_depth_2d`, so it can use only the direct
    // single-sample depth view. An MSAA framebuffer exposes converted depth as
    // `r16float`, which requires a different shader binding contract.
    const depthView: GPUTextureView | undefined =
      this._sceneFramebuffer?.depthSampleableView;

    if (!encoder || !targetView || !depthView) {
      if (!this._depthOverlayWarningLogged) {
        context.log?.(
          "warn",
          "[WebGPU:DepthOverlay] depth-as-color requires a single-sample (non-MSAA) scene framebuffer; overlay skipped",
        );
        this._depthOverlayWarningLogged = true;
      }
      context.resumeDefaultRenderPass?.();
      return;
    }

    if (!this._debugDepthOverlay) {
      this._debugDepthOverlay = new WebGPUDebugDepthOverlay();
    }
    this._debugDepthOverlay.initialize(
      device,
      context._presentationFormat ?? "bgra8unorm",
    );

    const camera = scene?.camera;
    const frustum = camera?.frustum;
    const near = frustum?.near ?? 1;
    const far = frustum?.far ?? 1e9;
    const fs = scene?._frameState;
    let mode = (fs?.debugDepthAsColorMode as number) | 0 || 0;
    // Windowed band (meters of eye-space distance). When max > min, force the
    // windowed overlay mode (3 = turbo, 4 = grayscale) so a tight depth band
    // gets the full color range — discriminates near-identical depths the
    // log-normalized modes 0-2 collapse to one shade.
    const windowMin = (fs?.debugDepthWindowMin as number) || 0;
    const windowMax = (fs?.debugDepthWindowMax as number) || 0;
    const useTurbo = fs?.debugDepthWindowTurbo !== false;
    if (windowMax > windowMin) {
      mode = useTurbo ? 3 : 4;
    }

    this._debugDepthOverlay.execute(
      encoder,
      depthView,
      targetView,
      near,
      far,
      mode,
      windowMin,
      windowMax,
      useTurbo,
    );
    // The overlay wrote the canvas through its own pass. Mark it written so
    // the resume below cannot clear the output on its first context-managed open.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * Runs the {@link WebGPUDebugGBufferOverlay} in place of the production
   * post-process chain. Samples
   * `view.gBufferFramebuffer.normalRoughnessTexture` and blits it to the
   * canvas as a normal-map visualization (.xyz * 0.5 + 0.5 → RGB).
   * Magenta sentinel for sky / depth-clear / high-gradient pixels where
   * the producer couldn't reconstruct a normal.
   *
   * Lazy-constructs the overlay on first invocation so production frames
   * pay zero cost.
   */
  private _executeDebugGBufferOverlay(config: WebGPURenderFrameConfig): void {
    const { context, scene } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) return;

    context.endCurrentRenderPass?.();

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const targetView: GPUTextureView | undefined = context.currentTextureView;
    const view = (
      scene as unknown as {
        _view?: {
          gBufferFramebuffer?: {
            normalRoughnessTexture: GPUTextureView | null;
          };
        };
      }
    )._view;
    const gBufferView =
      view?.gBufferFramebuffer?.normalRoughnessTexture ?? null;

    if (!encoder || !targetView || !gBufferView) {
      // Without a G-buffer the overlay can't run. Clear to magenta so
      // the user knows "you turned the toggle on but the producer
      // didn't populate the target this frame — likely
      // scene.deferredLighting needs to be true too."
      if (encoder && targetView) {
        const passEncoder = encoder.beginRenderPass(
          context.withRenderPassTimestamps({
            label: "DebugGBufferOverlay clear (no g-buffer)",
            colorAttachments: [
              {
                view: targetView,
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0.5, g: 0, b: 0.5, a: 1 },
              },
            ],
          }),
        );
        passEncoder.end();
        // Record the sentinel clear so a later pass does not clear it again.
        context.markCanvasContentWritten();
      }
      context.resumeDefaultRenderPass?.();
      return;
    }

    if (!this._debugGBufferOverlay) {
      this._debugGBufferOverlay = new WebGPUDebugGBufferOverlay();
    }
    this._debugGBufferOverlay.initialize(
      device,
      context._presentationFormat ?? "bgra8unorm",
    );

    this._debugGBufferOverlay.execute(encoder, gBufferView, targetView);
    // Record that the overlay wrote the canvas through its own pass.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * Tier 2 debug — runs the {@link WebGPUDebugFrustumOverlay} in place of
   * the production post-process chain. Samples the scene framebuffer's
   * color + sampleable depth view, tints per pixel by frustum membership
   * (mode 0) or depth-banded palette (mode 1), and blits to the canvas.
   *
   * Its shader binds `texture_depth_2d`, so it requires the direct
   * single-sample depth view. The `r16float` conversion used for MSAA requires
   * a different binding contract.
   */
  private _executeDebugFrustumOverlay(
    config: WebGPURenderFrameConfig,
    mode: number,
  ): void {
    const { context, scene } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    context.endCurrentRenderPass?.();

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const targetView: GPUTextureView | undefined = context.currentTextureView;
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const sceneColorView: GPUTextureView | undefined =
      colorTarget?.getColorTextureView?.(0);
    const sceneDepthView: GPUTextureView | undefined =
      this._sceneFramebuffer?.depthSampleableView;

    if (!encoder || !targetView || !sceneColorView || !sceneDepthView) {
      if (!this._depthOverlayWarningLogged) {
        context.log?.(
          "warn",
          "[WebGPU:FrustumOverlay] requires a single-sample (non-MSAA) " +
            "scene framebuffer with depthSampleableView; overlay skipped",
        );
        this._depthOverlayWarningLogged = true;
      }
      context.resumeDefaultRenderPass?.();
      return;
    }

    if (!this._debugFrustumOverlay) {
      this._debugFrustumOverlay = new WebGPUDebugFrustumOverlay();
    }
    this._debugFrustumOverlay.initialize(
      device,
      context._presentationFormat ?? "bgra8unorm",
    );

    const camera = scene?.camera;
    const frustum = camera?.frustum;
    const globalNear = frustum?.near ?? 1;
    const globalFar = frustum?.far ?? 1e9;

    // Captured during the multi-frustum loop. Fall back to the camera
    // near/far as a single range if the loop didn't populate anything —
    // happens when `numFrustums === 0` (no drawn commands this frame).
    const ranges =
      this._capturedFrustumRanges.length > 0
        ? this._capturedFrustumRanges
        : [{ near: globalNear, far: globalFar }];

    this._debugFrustumOverlay.execute(
      encoder,
      sceneColorView,
      sceneDepthView,
      targetView,
      globalNear,
      globalFar,
      mode,
      ranges,
    );
    // Record that the overlay wrote the canvas through its own pass.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * Draws a red wireframe around the bounding volume of every command flagged
   * `debugShowBoundingVolume`.
   *
   * WebGPU equivalent of `Scene/SceneDebug.js#debugShowBoundingVolume`. The
   * flag flows through `GeoJsonPrimitive` and all three `Buffer*`
   * `WebGPUDrawCommand`s; this pass consumes it.
   *
   * It collects flagged commands from `frameState.commandList`; when none carry
   * the default-off flag, it
   * returns before opening any pass, so an unflagged frame is unchanged.
   *
   * Runs from the post-frustum chain, after the main scene pass has closed
   * + resolved and before `_runPostProcessing` samples the scene-color
   * texture — so the wireframe reaches the canvas through the post-process
   * blit. Draws into the resolved single-sample color view with
   * `loadOp="load"`.
   */
  public _executeBoundingVolumeDebugPass(
    config: WebGPURenderFrameConfig,
  ): void {
    const { context, scene } = config;
    const device: GPUDevice | undefined = context._device;
    const frameState = scene?._frameState;
    if (!device || !frameState) {
      return;
    }

    // Collect flagged commands. Default-off: an empty list means no pass.
    const commandList = frameState.commandList as
      | Array<{
          debugShowBoundingVolume?: boolean;
          boundingVolume?: unknown;
        }>
      | undefined;
    if (!commandList || commandList.length === 0) {
      return;
    }
    const items = [];
    for (let i = 0; i < commandList.length; i++) {
      const cmd = commandList[i];
      if (cmd.debugShowBoundingVolume !== true || !cmd.boundingVolume) {
        continue;
      }
      const item = WebGPUBoundingVolumeDebugPass.makeItem(cmd.boundingVolume);
      if (item) {
        items.push(item);
      }
    }
    if (items.length === 0) {
      return;
    }

    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const targetView: GPUTextureView | undefined =
      colorTarget?.getColorTextureView?.(0);
    if (!targetView) {
      return;
    }

    // The wireframe draws into the resolved color view, so first ensure that it
    // contains accumulated scene color. This is reached only for a flagged
    // command and is inert without MSAA, leaving ordinary frames unchanged.
    this._ensureSceneColorResolved(context);

    // Close the scene pass so we can open our own single-attachment pass on
    // the resolved color view.
    context.endCurrentRenderPass?.();
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (!encoder) {
      return;
    }

    if (!this._boundingVolumeDebugPass) {
      this._boundingVolumeDebugPass = new WebGPUBoundingVolumeDebugPass();
    }
    this._boundingVolumeDebugPass.initialize(
      device,
      context.scenePipelineFormat ??
        context._presentationFormat ??
        "bgra8unorm",
    );

    const uniformState = context.uniformState as unknown as {
      view: import("../../Core/Matrix4.js").default;
      projection: import("../../Core/Matrix4.js").default;
      cameraPosition: { x: number; y: number; z: number };
    };
    this._boundingVolumeDebugPass.execute(
      encoder,
      targetView,
      items,
      uniformState,
    );
  }

  // --- Pass helper ---

  // Public because the frustum loop delegates this pass through the renderer.
  public _executePassCommands(
    frustumCommands: CesiumFrustumCommands,
    passIndex: number,
    scene: CesiumScene,
    context: WebGPUContext,
    passState: CesiumPassState,
  ): void {
    const commands = frustumCommands.commands[passIndex];
    const count: number = frustumCommands.indices[passIndex];
    if (count === 0) {
      return;
    }
    context.uniformState?.updatePass(passIndex);
    executeBatch(commands, count, scene, context, passState);
  }

  // --- Accessors for scene-level resources ---

  get sceneFramebuffer(): WebGPUSceneFramebuffer | null {
    return this._sceneFramebuffer;
  }
  get oit(): WebGPUOIT | null {
    return this._oit;
  }
  get globeDepth(): WebGPUGlobeDepth | null {
    return this._globeDepth;
  }
  get depthPlane(): WebGPUDepthPlane | null {
    return this._depthPlane;
  }
  get postProcessPipeline(): WebGPUPostProcessPipeline | null {
    return this._postProcess;
  }

  // `WebGPUDerivedCommand` is the descriptor-variant factory. Renderers call
  // `WebGPUDerivedCommand.deriveDescriptor` and
  // `.resolveVariantPipeline` directly and attach the resulting commands on
  // `derivedCommands.*` for `selectCommandVariant` to dispatch.

  // --- Lifecycle ---

  destroy(): void {
    if (this._sceneFramebuffer) {
      this._sceneFramebuffer.destroy();
      this._sceneFramebuffer = null;
    }
    if (this._edgeFramebuffer) {
      this._edgeFramebuffer.destroy();
      this._edgeFramebuffer = null;
    }
    if (this._translucentTileClassification) {
      this._translucentTileClassification.destroy();
      this._translucentTileClassification = null;
    }
    if (this._oit) {
      this._oit.destroy();
      this._oit = null;
    }
    if (this._globeDepth) {
      this._globeDepth.destroy();
      this._globeDepth = null;
    }
    if (this._depthPlane) {
      this._depthPlane.destroy();
      this._depthPlane = null;
    }
    if (this._postProcess) {
      this._postProcess.destroy();
      this._postProcess = null;
    }
    if (this._boundingVolumeDebugPass) {
      this._boundingVolumeDebugPass.destroy();
      this._boundingVolumeDebugPass = null;
    }
    // Release the context's invalidation subscriber so it does not outlive this
    // renderer and retain a dead closure
    // captured on the context's listener set.
    if (this._deviceInvalidationUnsub) {
      this._deviceInvalidationUnsub();
      this._deviceInvalidationUnsub = null;
    }
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  // ─── GPU Frustum Culling ───

  // Each dispatcher uses high and low hysteresis thresholds plus a state flag.
  // Activation requires the high threshold; deactivation requires a count
  // below the low threshold. Between them the previous state holds. This prevents
  // dispatch flap when the command count oscillates around a single
  // threshold (typical with LOD / tile streaming at the boundary).
  // The previous single thresholds are kept as `_THRESHOLD` aliases
  // so external diagnostics that read them keep working.
  /** Minimum command count before GPU culling is worth the overhead */
  private static readonly GPU_CULL_THRESHOLD = 256;
  private static readonly GPU_CULL_THRESHOLD_HI = 384;
  private static readonly GPU_CULL_THRESHOLD_LO = 192;
  // Each frustum's gate evolves from its own previous-frame state instead of
  // racing with sibling frustums. Map keyed by frustum index. Stays
  // small (typical 1-4 entries).
  // The translucent path has its own gate based on translucent command count,
  // not opaque count. A particle-heavy scene with 50
  // opaque and 5000 translucent commands therefore activates translucent GPU
  // culling even when the opaque count is below the high threshold.
  private _gpuCullActiveByFrustum: Map<number, boolean> = new Map();
  private _gpuCullTranslucentActiveByFrustum: Map<number, boolean> = new Map();
  // Effectiveness counters include cumulative dispatch count and last-frame
  // totals. `_lastFrameInput` and `_lastFrameFiltered` accumulate across
  // frustums within a frame so multi-frustum scenes
  // see the cumulative cull effect, not just the last frustum's slice.
  // `_translucentDispatchCount` separately tracks translucent path.
  private _gpuCullDispatchCount: number = 0;
  private _gpuCullTranslucentDispatchCount: number = 0;
  private _gpuCullLastInput: number = 0;
  private _gpuCullLastFiltered: number = 0;
  private _gpuCullLastTranslucentInput: number = 0;
  private _gpuCullLastTranslucentFiltered: number = 0;
  // Frame counter to detect frame transitions and reset per-frame
  // accumulators (the existing per-frustum counters need to clear
  // when a new frame starts so multi-frustum sums don't accumulate
  // across frames).
  private _statsLastFrameId: number = -1;

  /**
   * GPU-cull an array of commands using compute shader frustum testing.
   * Returns a filtered array with only visible commands. Falls back to
   * returning the original array if the culler isn't ready or count is
   * below threshold.
   *
   * @param commands - Array of draw commands with boundingVolume.
   *    Only the first `effectiveCount` entries (or `commands.length`
   *    if `effectiveCount` is undefined) are inspected — supports
   *    pre-sized command arrays where the trailing slots are stale.
   * @param context - WebGPU context with gpuCuller
   * @param cullingVolume - Camera culling volume with planes[]
   * @param effectiveCount - Optional explicit valid-prefix length.
   *    This lets opaque-pass callers provide the pre-sized
   *    `frustumCommands.commands[OPAQUE]` array directly
   *    with the matching `frustumCommands.indices[OPAQUE]` count, with
   *    no per-frame slice allocation in the hot path.
   * @returns Filtered command array (may be same reference if no culling done)
   */
  gpuCullCommands(
    commands: CesiumAnyDrawCommand[],
    context: WebGPUContext,
    cullingVolume: {
      planes: Array<{ x: number; y: number; z: number; w: number }>;
    },
    effectiveCount?: number,
  ): CesiumAnyDrawCommand[] {
    const count =
      typeof effectiveCount === "number"
        ? effectiveCount
        : (commands?.length ?? 0);
    // The caller enforces activation hysteresis. This method still guards
    // against zero or negative counts and
    // missing inputs but the threshold check itself moved upstream.
    if (!commands || count <= 0) {
      return commands;
    }

    // Use a per-frustum culler instance so multiple frustums in the same frame
    // don't clobber each other's staging buffers. Frustum 0 reuses
    // the legacy `gpuCuller` (no extra VRAM for single-frustum
    // scenes); frustums 1..N use lazy-allocated instances.
    const fIdx = this._currentFrustumIndex;
    const culler = context.getGPUCullerForOpaqueFrustum(fIdx);
    if (!culler || !culler.initialized) {
      return commands;
    }

    // Extract bounding spheres
    const sphereData = new Float32Array(count * 4);
    let hasSpheres = false;
    for (let i = 0; i < count; i++) {
      const bv = commands[i].boundingVolume;
      if (bv && bv.center) {
        const off = i * 4;
        sphereData[off] = bv.center.x;
        sphereData[off + 1] = bv.center.y;
        sphereData[off + 2] = bv.center.z;
        sphereData[off + 3] = bv.radius ?? bv.boundingSphere?.radius ?? 0;
        hasSpheres = true;
      }
    }

    if (!hasSpheres || !cullingVolume?.planes) {
      return commands;
    }

    // Pack frustum planes (6 × vec4)
    const planes = cullingVolume.planes;
    const planeData = new Float32Array(24);
    for (let i = 0; i < Math.min(planes.length, 6); i++) {
      const p = planes[i];
      planeData[i * 4] = p.x;
      planeData[i * 4 + 1] = p.y;
      planeData[i * 4 + 2] = p.z;
      planeData[i * 4 + 3] = p.w;
    }

    // Upload and dispatch
    culler.uploadBoundingSpheres(sphereData);
    culler.uploadFrustumPlanes(planeData);

    const encoder = context._currentCommandEncoder;
    if (!encoder) {
      return commands;
    }

    // Skip redispatch and readback while this frustum's prior readback is
    // mapping. `prepareReadback` copies into the
    // readback staging buffer; doing that while a prior `readResults`
    // mapAsync is still pending raises "[Buffer] used in submit while
    // mapped" and invalidates the entire command buffer (dense-scene black
    // screen). The filter below falls through to the prior frame's cached
    // results — 1-frame-staler visibility is imperceptible at the densities
    // this gate activates. Mirrors the HiZ `_hiZReadbackInFlight` guard.
    if (!this._gpuCullReadbackInFlight.has(fIdx)) {
      culler.dispatch(encoder, count, 0 /* CullMode.VISIBILITY */);
      this._gpuCullDispatchCount++;

      // Results become available next frame and are keyed per frustum so each
      // frustum's filter consumes its own
      // readback instead of racing the others.
      culler.prepareReadback(encoder, count);
      this._gpuCullReadbackInFlight.add(fIdx);
      culler
        .readResults(count)
        .then((results: GPUCullResults) => {
          this._lastCullResultsByFrustum.set(fIdx, results);
          this._gpuCullReadbackInFlight.delete(fIdx);
        })
        .catch(() => {
          this._gpuCullReadbackInFlight.delete(fIdx);
        });
    }

    // Use previous frame's results if available. Output array is
    // pooled because the call site reads `filtered.length`
    // synchronously inside `executeBatch`, never retains the ref.
    const prev = this._lastCullResultsByFrustum.get(fIdx);
    if (prev && prev.visibilityFlags && prev.objectCount === count) {
      const filtered = this._gpuCullFilterPool;
      filtered.length = 0;
      const flags = prev.visibilityFlags;
      for (let i = 0; i < count; i++) {
        if (flags[i] === 1) filtered.push(commands[i]);
      }
      // Accumulate across frustums in the same frame. Reset is unconditional at
      // the top of `_executeOpaquePass` (frustum 0 entry) so this
      // path no longer needs to gate on a frustum-tick check.
      this._gpuCullLastInput += count;
      this._gpuCullLastFiltered += filtered.length;
      return filtered;
    }

    return commands;
  }

  /**
   * Gate-controlled translucent-pass GPU culling, called through the host
   * interface by the translucent-pass module. It uses a translucent-specific
   * per-frustum gate and is skipped during picking.
   *
   * Returns the original `commands` reference when the gate is off,
   * the cullingVolume is missing, or the dispatcher hasn't produced
   * a readback yet.
   */
  _maybeGPUCullTranslucent(
    commands: CesiumAnyDrawCommand[],
    count: number,
    config: WebGPURenderFrameConfig,
  ): { commands: CesiumAnyDrawCommand[]; count: number } {
    if (config.picking || count <= 0) {
      return { commands, count };
    }
    // The translucent gate is independent of the opaque gate and activates
    // from the translucent command count, so a
    // particle-heavy scene with 50 opaque + 5000 translucent commands
    // correctly fires the translucent cull even though the opaque
    // gate stayed off. Each frustum maintains its own hysteresis.
    // Translucent culling is more hazardous than opaque culling
    // because this call site can run inside an active render pass. It is
    // therefore reachable only through the explicit `always` force mode;
    // `auto` remains opaque-only characterization.
    const hint = (
      config.scene as { gpuCullingHint?: "auto" | "always" | "never" }
    ).gpuCullingHint;
    if (hint !== "always") {
      return { commands, count };
    }
    const fIdx = this._currentFrustumIndex;
    const prev = this._gpuCullTranslucentActiveByFrustum.get(fIdx) ?? false;
    const active = this._updateActivationGate(
      prev,
      count,
      WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
      WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
    );
    this._gpuCullTranslucentActiveByFrustum.set(fIdx, active);
    if (!active) {
      return { commands, count };
    }
    const cv = (config.scene as { _frameState?: { cullingVolume?: unknown } })
      ?._frameState?.cullingVolume as
      | { planes: Array<{ x: number; y: number; z: number; w: number }> }
      | undefined;
    if (!cv || !cv.planes || cv.planes.length === 0) {
      return { commands, count };
    }
    const filtered = this.gpuCullCommandsForTranslucent(
      commands,
      config.context as WebGPUContext,
      cv,
      count,
    );
    if (filtered === commands) {
      return { commands, count };
    }
    return { commands: filtered, count: filtered.length };
  }

  // ─── Translucent-pass GPU culling ──────────────────────────────────────

  /**
   * Threshold-gated GPU cull for the translucent pass. Mirrors the
   * opaque-pass `gpuCullCommands` shape but uses a separate readback
   * slot so the two pass-specific readbacks don't fight over
   * `_lastCullResults`. Same 1-frame latency contract.
   *
   * Skipped when the gate is inactive, no encoder is available, or
   * when no cullingVolume planes were provided.
   */
  gpuCullCommandsForTranslucent(
    commands: CesiumAnyDrawCommand[],
    context: WebGPUContext,
    cullingVolume: {
      planes: Array<{ x: number; y: number; z: number; w: number }>;
    },
    effectiveCount: number,
  ): CesiumAnyDrawCommand[] {
    if (!commands || effectiveCount <= 0) return commands;

    // Use the dedicated translucent culler so this pass's `prepareReadback`
    // does not
    // clobber the opaque pass's pending readback in the same encoder.
    const culler = context.gpuCullerTranslucent;
    if (!culler || !culler.initialized) return commands;

    const count = effectiveCount;
    const sphereData = new Float32Array(count * 4);
    let hasSpheres = false;
    for (let i = 0; i < count; i++) {
      const bv = commands[i].boundingVolume;
      if (bv && bv.center) {
        const off = i * 4;
        sphereData[off] = bv.center.x;
        sphereData[off + 1] = bv.center.y;
        sphereData[off + 2] = bv.center.z;
        sphereData[off + 3] = bv.radius ?? bv.boundingSphere?.radius ?? 0;
        hasSpheres = true;
      }
    }
    if (!hasSpheres || !cullingVolume?.planes) return commands;

    const planes = cullingVolume.planes;
    const planeData = new Float32Array(24);
    for (let i = 0; i < Math.min(planes.length, 6); i++) {
      const p = planes[i];
      planeData[i * 4] = p.x;
      planeData[i * 4 + 1] = p.y;
      planeData[i * 4 + 2] = p.z;
      planeData[i * 4 + 3] = p.w;
    }

    culler.uploadBoundingSpheres(sphereData);
    culler.uploadFrustumPlanes(planeData);

    const encoder = context._currentCommandEncoder;
    if (!encoder) return commands;

    culler.dispatch(encoder, count, 0 /* CullMode.VISIBILITY */);
    this._gpuCullTranslucentDispatchCount++;
    culler.prepareReadback(encoder, count);
    culler
      .readResults(count)
      .then((results: GPUCullResults) => {
        this._lastCullResultsTranslucent = results;
      })
      .catch(() => {});

    const prev = this._lastCullResultsTranslucent;
    if (prev && prev.visibilityFlags && prev.objectCount === count) {
      const filtered = this._gpuCullFilterPoolTranslucent;
      filtered.length = 0;
      const flags = prev.visibilityFlags;
      for (let i = 0; i < count; i++) {
        if (flags[i] === 1) filtered.push(commands[i]);
      }
      // Translucent statistics accumulate across frustums separately from
      // opaque statistics and reset at the frustum-zero opaque-pass entry.
      this._gpuCullLastTranslucentInput += count;
      this._gpuCullLastTranslucentFiltered += filtered.length;
      return filtered;
    }
    return commands;
  }

  // ─── Threshold hysteresis helper ───────────────────────────────────────

  /**
   * Update an activation gate with hysteresis. Returns the new
   * active state and stores it on the dispatcher. Call once per
   * frame per dispatcher with the current command count.
   *
   *   - active and below the low threshold: deactivate
   *   - inactive and at or above the high threshold: activate
   *   - otherwise               →  hold previous state
   *
   * Two-threshold design prevents single-frame flap when count
   * oscillates around the boundary (typical with LOD streaming).
   * The dispatchers themselves stay warm in either state — only
   * filter/dispatch decisions change with the gate.
   */
  private _updateActivationGate(
    active: boolean,
    count: number,
    hi: number,
    lo: number,
  ): boolean {
    if (active) return count >= lo;
    return count >= hi;
  }

  // ─── Hierarchical-Z occlusion ──────────────────────────────────────────

  /**
   * Filter opaque commands against the previous-frame HiZ visibility
   * readback. No-op when the readback isn't available, when the count
   * doesn't match, or when the count is below threshold. Returns the
   * original `commands` reference unchanged in those cases.
   */
  private _filterByHiZVisibility(
    commands: CesiumAnyDrawCommand[],
    count: number,
  ): CesiumAnyDrawCommand[] {
    // The caller enforces the `_hiZActive` gate.
    if (count <= 0) return commands;
    const prev = this._lastHiZVisibility;
    if (!prev || prev.count !== count) return commands;
    // The pooled output has the same lifetime contract as
    // `gpuCullCommands`: caller consumes synchronously inside
    // `executeBatch`, doesn't retain the ref across frames.
    const flags = prev.flags;
    const filtered = this._hiZFilterPool;
    filtered.length = 0;
    for (let i = 0; i < count; i++) {
      // Preserve explicitly non-occludable commands such as celestial bodies.
      // Keep them in the producer arrays so result count and
      // index identity do not drift; only override the consumer decision.
      if (commands[i].occlude === false || flags[i] === 1) {
        filtered.push(commands[i]);
      }
    }
    // Accumulate across frustums and reset at the frustum-zero opaque-pass
    // entry. Statistics reflect what the test would drop even when consumption is off,
    // so CesiumDebug.highDensityCull surfaces the (currently inert) hit ratio.
    this._hiZLastInput += count;
    this._hiZLastFiltered += filtered.length;
    // Do not drop commands by default until each result identifies its producing
    // frustum, frame, and command generation. The toggle
    // remains for A/B regression probes (`CesiumDebug.hiZConsume`).
    if (!this._hiZConsumeEnabled) return commands;
    this._hiZConsumedThisFrame = true;
    return filtered;
  }

  /**
   * Consumes the GPU-produced front-to-back sort order. Applies the previous
   * frame's bitonic-sort permutation to the raw opaque command
   * list, producing a reordered array that is a strict permutation of
   * the same commands (nothing added or dropped).
   *
   * The readback `indices` hold SOA slots and `compactedToOriginal` maps each
   * back to its original command index. Canonical-distance dispatches are
   * all-or-nothing, making this map identity and `skipped` empty, but the
   * tagged reconstruction remains defensive against old or in-flight
   * results. The permutation therefore indexes the ORIGINAL `commands` array.
   *
   * Only applied when this frame's opaque count matches the count the
   * dispatch saw (1-frame-latency staleness guard, same contract as
   * HiZ/gpuCull) and only when the reconstruction yields the full set —
   * any corruption (bad readback, count drift) falls back to the input
   * order, so the result is never wrong, only occasionally un-optimized.
   * Reordering opaque commands is output-invariant (depth test resolves
   * overlap), so a stale-but-valid order is harmless.
   */
  private _applySortedOrder(
    commands: CesiumAnyDrawCommand[],
    count: number,
  ): CesiumAnyDrawCommand[] {
    if (count <= 0) return commands;
    if (this._gpuSortConsumeMode === "never") {
      // The off gate never reorders. Explicit "auto" and "always" fall through
      // and apply; this
      // method is only reached when the opaque-count gate is already active.
      return commands;
    }
    // The packed 64-bit GPU key has no lossless field for Cesium's legacy
    // sortKey. Even the explicit "always" debug mode must stay on the CPU
    // path for such lists; otherwise it would silently violate the canonical
    // sortLayer -> sortKey -> sortPriority precedence.
    for (let i = 0; i < count; i++) {
      if (!isCommandOrderingGPUEncodable(commands[i])) {
        this._sortConsumeSkipped++;
        return commands;
      }
    }
    const prev = this._lastSortedIndices;
    if (!prev || prev.originalCount !== count) {
      this._sortConsumeSkipped++;
      return commands;
    }
    const indices = prev.indices;
    const c2o = prev.compactedToOriginal;
    const validCount = prev.count;
    if (c2o.length !== validCount) {
      this._sortConsumeSkipped++;
      return commands;
    }
    const out = this._sortOrderPool;
    out.length = 0;
    for (let i = 0; i < validCount; i++) {
      const compactedIdx = indices[i];
      // Guard the bitonic sentinel padding (0xFFFFFFFF) + any OOB.
      if (compactedIdx >= validCount) continue;
      const origIdx = c2o[compactedIdx];
      if (origIdx < count) out.push(commands[origIdx]);
    }
    // Preserve any skipped entries carried by an older/in-flight protocol tag.
    const skipped = prev.skipped;
    for (let i = 0; i < skipped.length; i++) {
      const s = skipped[i];
      if (s < count) out.push(commands[s]);
    }
    // Only apply a clean full-set permutation; otherwise fall back.
    if (out.length !== count) {
      this._sortConsumeSkipped++;
      return commands;
    }
    this._sortConsumeApplied++;
    this._sortConsumeAppliedThisFrame = true;
    //>>includeStart('debug', pragmas.debug);
    if (this._gpuSortDebugCapture) {
      this._gpuSortDebugCapture.appliedOrderLength = out.length;
    }
    //>>includeEnd('debug');
    return out;
  }

  /**
   * Debug snapshot of the last GPU sort dispatch and readback, allowing probes
   * to verify that the GPU
   * order matches the CPU comparator. Returns null in production (the
   * capture is pragma-stripped) or before the first readback.
   */
  getGpuSortConsumeSnapshot(): GpuSortDebugCapture | null {
    return this._gpuSortDebugCapture;
  }

  /**
   * After the opaque pass has written depth for this frame, dispatch
   * the HiZ pyramid build + occlusion test against the current
   * commands. The visibility result is read back asynchronously and
   * applied next frame via `_filterByHiZVisibility`.
   */
  private _dispatchHiZForNextFrame(
    context: WebGPUContext,
    commands: CesiumAnyDrawCommand[],
    count: number,
    frustumCommands?: CesiumFrustumCommands,
  ): void {
    // The caller enforces the `_hiZActive` gate.
    if (count <= 0) return;
    if (this._hiZReadbackInFlight) return;

    const fr = context.getFeatureRenderer?.(
      FeatureRendererKey.HI_Z_OCCLUSION,
    ) as
      | {
          init?: (w: number, h: number, max: number) => boolean;
          dispatch?: (
            encoder: GPUCommandEncoder,
            depthView: GPUTextureView,
            soa: {
              centerX: Float32Array;
              centerY: Float32Array;
              centerZ: Float32Array;
              radius: Float32Array;
              count: number;
            },
            params: {
              viewProjection: ArrayLike<number>;
              screenWidth: number;
              screenHeight: number;
              nearPlane: number;
              farPlane: number;
              logDepthEnabled?: boolean;
              logDepthFactor?: number;
              mip0IsDepthFormat?: boolean;
            },
            frameId?: number,
          ) => boolean;
          readback?: (count: number) => Promise<Uint32Array | null>;
        }
      | null
      | undefined;
    if (!fr || !fr.dispatch || !fr.readback) return;

    const ctxAny = context as unknown as {
      drawingBufferWidth: number;
      drawingBufferHeight: number;
      _currentCommandEncoder: GPUCommandEncoder | null;
      depthOnlyTextureView: GPUTextureView | null;
      _msaaSamples?: number;
      uniformState?: {
        viewProjection?: ArrayLike<number>;
        currentFrustumNear?: number;
        currentFrustumFar?: number;
        oneOverLog2FarDepthFromNearPlusOne?: number;
        frameState?: { frameNumber?: number; useLogDepth?: boolean };
      };
    };
    const encoder = ctxAny._currentCommandEncoder;
    // The hierarchical-Z pyramid must read the depth written by the scene
    // opaque pass. The WebGPU renderer renders into
    // `_sceneFramebuffer` (post-process is mandatory), so the opaque depth
    // lands in the scene framebuffer's depth attachment, not the context's
    // default `_depthTexture`. Reading `context.depthOnlyTextureView` (the
    // default depth) supplies an unwritten, clear-value 1.0 texture, making the
    // pyramid entirely far depth. Then `sphereNearZ > maxHiZ` never holds and
    // the hit ratio remains zero
    // regardless of how correct the OcclusionTest math was. Source the same
    // sampleable depth the velocity / AO / DoF compute passes bind
    // (`_sceneFramebuffer.depthSampleableView`, MSAA-resolved to sampleCount 1
    // when needed). Fall back to the context default only if the framebuffer
    // isn't up yet.
    const depthView =
      this._sceneFramebuffer?.depthSampleableView ??
      ctxAny.depthOnlyTextureView;
    if (!encoder || !depthView) return;
    const w = ctxAny.drawingBufferWidth || 1;
    const h = ctxAny.drawingBufferHeight || 1;

    if (
      !this._hiZAllocated ||
      this._hiZAllocatedFor.width !== w ||
      this._hiZAllocatedFor.height !== h ||
      this._hiZAllocatedFor.capacity < count
    ) {
      const cap = Math.max(count, this._hiZAllocatedFor.capacity);
      const ok = fr.init?.(w, h, cap) ?? false;
      if (!ok) return;
      this._hiZAllocated = true;
      this._hiZAllocatedFor = { width: w, height: h, capacity: cap };
    }

    let soa = this._hiZSphereSoA;
    if (!soa || soa.capacity < count) {
      const cap = Math.max(count, soa?.capacity ?? 0);
      soa = {
        centerX: new Float32Array(cap),
        centerY: new Float32Array(cap),
        centerZ: new Float32Array(cap),
        radius: new Float32Array(cap),
        capacity: cap,
      };
      this._hiZSphereSoA = soa;
    }
    let valid = 0;
    for (let i = 0; i < count; i++) {
      const bv = commands[i].boundingVolume as
        | {
            center?: { x: number; y: number; z: number };
            radius?: number;
            boundingSphere?: { radius?: number };
          }
        | undefined;
      const c = bv?.center;
      if (!c) continue;
      soa.centerX[valid] = c.x;
      soa.centerY[valid] = c.y;
      soa.centerZ[valid] = c.z;
      soa.radius[valid] = bv?.radius ?? bv?.boundingSphere?.radius ?? 0;
      valid++;
    }
    if (valid === 0) return;

    const us = ctxAny.uniformState;
    const vp = us?.viewProjection;
    if (!vp) return;

    // Prefer the per-frustum near and far values forwarded through
    // `frustumCommands` over the uniform-state
    // values, which `Scene.executeCommands` overwrites after the
    // last frustum iteration. Tighter bounds = more aggressive
    // occlusion test. Fallback chain: per-frustum → uniformState →
    // loose default. The loose default still produces correct
    // visibility (just less aggressive culling).
    // The hierarchical-Z pyramid is built from the depth attachment, which the
    // renderer-wide logarithmic-depth
    // buffer writes in log space. Forward `useLogDepth` + the precomputed
    // `czm_oneOverLog2FarDepthFromNearPlusOne` value so the occlusion-test WGSL
    // encodes the sphere's nearest depth into the same space. Without this
    // the comparison is linear-vs-log and collapses to all-visible
    // and produces a zero hit ratio. `nearPlane` must be the frustum
    // near used by the depth write so the log encoding matches; we already
    // forward the per-frustum near above.
    const logDepthEnabled = us?.frameState?.useLogDepth === true;
    const nearPlane = frustumCommands?.near ?? us?.currentFrustumNear ?? 1.0;
    const farPlane = frustumCommands?.far ?? us?.currentFrustumFar ?? 1e9;
    // Derive the log-depth factor (czm_oneOverLog2FarDepthFromNearPlusOne)
    // from THIS frustum's near/far rather than reading the shared
    // uniformState scalar. `Scene.executeCommands` advances uniformState to
    // the last frustum after the split loop, so the cached scalar can be
    // stale relative to `frustumCommands`. `UniformState.updateFrustum`
    // computes exactly `1 / log2((far - near) + 1)`, so we match it here.
    let logDepthFactor = 0.0;
    if (logDepthEnabled && farPlane > nearPlane) {
      const log2Far = Math.log2(farPlane - nearPlane + 1.0);
      logDepthFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    }
    // With MSAA, `depthView` is the resolved `r16float` color view, a
    // `texture_2d<f32>` rather than a depth
    // texture. Tell the dispatcher so mip 0 uses the texture_2d pipeline.
    const mip0IsDepthFormat =
      depthView !== this._sceneFramebuffer?.depthSampleableView ||
      (ctxAny._msaaSamples ?? 1) <= 1;
    const params = {
      viewProjection: vp,
      screenWidth: w,
      screenHeight: h,
      nearPlane,
      farPlane,
      logDepthEnabled,
      logDepthFactor,
      mip0IsDepthFormat,
    };

    // Pass the frame counter so per-frustum dispatches in the same frame share
    // one pyramid build.
    const frameId = us?.frameState?.frameNumber ?? -1;
    const ok = fr.dispatch(
      encoder,
      depthView,
      {
        centerX: soa.centerX,
        centerY: soa.centerY,
        centerZ: soa.centerZ,
        radius: soa.radius,
        count: valid,
      },
      params,
      frameId,
    );
    if (!ok) return;

    this._hiZDispatchCount++;
    this._hiZReadbackInFlight = true;
    fr.readback(valid)
      .then((flags: Uint32Array | null) => {
        this._hiZReadbackInFlight = false;
        if (flags) {
          this._lastHiZVisibility = { flags, count: valid };
        }
      })
      .catch(() => {
        this._hiZReadbackInFlight = false;
      });
  }

  // ─── GPU sort keys ─────────────────────────────────────────────────────

  /**
   * Threshold-gated GPU sort-key generation, dispatched after the opaque pass
   * to overlap with rasterization. A bitonic pass sorts the generated keys and
   * returns a tagged permutation for next-frame consumption. JavaScript order
   * remains authoritative when the list cannot be represented by GPU keys.
   *
   * Returns true if a dispatch was issued, false otherwise (below
   * threshold, missing FR, no encoder, no camera state).
   */
  private _dispatchGPUSortKeys(
    context: WebGPUContext,
    commands: CesiumAnyDrawCommand[],
    count: number,
  ): boolean {
    // The caller enforces the `_gpuSortActive` gate.
    if (count <= 0) return false;
    for (let i = 0; i < count; i++) {
      if (!isCommandOrderingGPUEncodable(commands[i])) {
        return false;
      }
    }

    const fr = context.getFeatureRenderer?.(
      FeatureRendererKey.GPU_SORT_KEYS,
    ) as
      | {
          init?: (max: number) => boolean;
          dispatch?: (
            encoder: GPUCommandEncoder,
            soa: {
              distanceSquared: Float32Array;
              renderLayers: Uint32Array;
              sortPriorities: Uint32Array;
              materialSortIds: Uint32Array;
              count: number;
            },
            params: {
              sortMode: number;
            },
          ) => boolean;
          // The sort and readback chain uses a tag-paired ring.
          runBitonicSort?: (
            encoder: GPUCommandEncoder,
            count: number,
          ) => boolean;
          prepareIndicesReadback?: (
            encoder: GPUCommandEncoder,
            count: number,
            tag?: unknown,
          ) => void;
          latestSortedIndices?: () => {
            indices: Uint32Array;
            count: number;
            tag: unknown;
          } | null;
        }
      | null
      | undefined;
    if (!fr || !fr.dispatch) return false;

    const ctxAny = context as unknown as {
      _currentCommandEncoder: GPUCommandEncoder | null;
      uniformState?: {
        cameraPosition?: { x: number; y: number; z: number };
        camera?: { positionWC?: { x: number; y: number; z: number } };
      };
    };
    const encoder = ctxAny._currentCommandEncoder;
    if (!encoder) return false;
    const camPos =
      ctxAny.uniformState?.cameraPosition ??
      ctxAny.uniformState?.camera?.positionWC;
    if (!camPos) return false;

    // Lazy alloc — the dispatcher's `init(maxCommands)` only needs to
    // run once per peak count. We grow on demand to track the largest
    // batch encountered in the session.
    if (this._sortKeysAllocatedFor < count) {
      const ok = fr.init?.(count) ?? false;
      if (!ok) return false;
      this._sortKeysAllocatedFor = count;
    }

    let soa = this._sortKeysSoA;
    if (!soa || soa.capacity < count) {
      const cap = Math.max(count, soa?.capacity ?? 0);
      soa = {
        distanceSquared: new Float32Array(cap),
        renderLayers: new Uint32Array(cap),
        sortPriorities: new Uint32Array(cap),
        materialSortIds: new Uint32Array(cap),
        capacity: cap,
      };
      this._sortKeysSoA = soa;
    }
    // Build the compaction map alongside the structure-of-arrays inputs. The
    // live GPU path requires every command to
    // expose the same finite `boundingVolume.distanceSquaredTo(camera)` term
    // the CPU comparator uses. A list containing an unsortable command stays
    // entirely on the CPU; no center-distance approximation or partial-list
    // reconstruction is permitted. The compaction map remains paired with
    // readback tags for protocol compatibility, but is identity for live
    // dispatches. Record `compactedToOriginal[slot] = original` explicitly so
    // the delayed readback remains paired with the command generation that
    // produced it even if this protocol gains compaction again later.
    let compaction = this._sortCompactionScratch;
    if (!compaction || compaction.compactedToOriginal.length < count) {
      compaction = {
        compactedToOriginal: new Uint32Array(count),
        skipped: [] as number[],
      };
      this._sortCompactionScratch = compaction;
    }
    const compactedToOriginal = compaction.compactedToOriginal;
    const skipped = compaction.skipped;
    skipped.length = 0;
    let valid = 0;
    for (let i = 0; i < count; i++) {
      const cmd = commands[i];
      const distanceSquared = getCommandDistanceSquaredForSort(cmd, camPos);
      if (distanceSquared === undefined) {
        return false;
      }
      soa.distanceSquared[valid] = distanceSquared;
      soa.renderLayers[valid] = normalizeCommandSortByte(
        cmd.sortLayer,
        DEFAULT_COMMAND_SORT_LAYER,
      );
      soa.sortPriorities[valid] = normalizeCommandSortByte(
        cmd.sortPriority,
        DEFAULT_COMMAND_SORT_PRIORITY,
      );
      soa.materialSortIds[valid] = normalizeCommandMaterialSortId(
        cmd.materialSortId ?? DEFAULT_COMMAND_MATERIAL_SORT_ID,
      );
      compactedToOriginal[valid] = i;
      valid++;
    }
    if (valid === 0) return false;

    const ok = fr.dispatch(
      encoder,
      {
        distanceSquared: soa.distanceSquared,
        renderLayers: soa.renderLayers,
        sortPriorities: soa.sortPriorities,
        materialSortIds: soa.materialSortIds,
        count: valid,
      },
      {
        sortMode: 0 /* SORT_MODE_FRONT_TO_BACK — opaque early-Z */,
      },
    );
    if (!ok) return false;
    this._sortKeysDispatches++;

    // Chain the bitonic sort and deferred-ring readback. Snapshot this
    // dispatch's compaction map and pass it as the readback `tag` so
    // the decoded indices (surfaced 1-2 frames later by the ring) stay
    // paired with the exact compaction that produced them. Each frame we
    // then pull the latest decoded pair and store it in
    // `_lastSortedIndices` for `_applySortedOrder` to consume.
    if (
      fr.runBitonicSort &&
      fr.prepareIndicesReadback &&
      fr.latestSortedIndices
    ) {
      const sortOk = fr.runBitonicSort(encoder, valid);
      if (sortOk) {
        // Snapshot the compaction map for this dispatch. The scratch
        // arrays are reused next frame, so copy the valid slice + the
        // skipped list; the ring surfaces this decode on a later frame.
        const c2oSnapshot = compactedToOriginal.slice(0, valid);
        const skippedSnapshot = skipped.slice();
        const tag: GpuSortReadbackTag = {
          validCount: valid,
          originalCount: count,
          compactedToOriginal: c2oSnapshot,
          skipped: skippedSnapshot,
        };
        // Debug-only capture of the compacted SOA inputs for the probe,
        // carried on the tag so it stays paired with these indices.
        //>>includeStart('debug', pragmas.debug);
        tag.debug = {
          validCount: valid,
          originalCount: count,
          sortMode: 0,
          cameraPosition: { x: camPos.x, y: camPos.y, z: camPos.z },
          distanceSquared: Array.from(soa.distanceSquared.subarray(0, valid)),
          renderLayers: Array.from(soa.renderLayers.subarray(0, valid)),
          sortPriorities: Array.from(soa.sortPriorities.subarray(0, valid)),
          materialSortIds: Array.from(soa.materialSortIds.subarray(0, valid)),
          sortedCompactedIndices: [],
          compactedToOriginal: Array.from(c2oSnapshot),
          skipped: skippedSnapshot.slice(),
          appliedOrderLength: 0,
          consumeEnabled: this.gpuSortConsumeEnabled,
        };
        //>>includeEnd('debug');
        fr.prepareIndicesReadback(encoder, valid, tag);

        // Pull the latest decoded pair (may be from a prior frame). The
        // ring guarantees the indices and tag come from the same dispatch.
        const latest = fr.latestSortedIndices();
        if (latest && latest.indices) {
          const t = latest.tag as GpuSortReadbackTag | null;
          if (t && latest.indices.length === t.validCount) {
            this._lastSortedIndices = {
              indices: latest.indices,
              count: t.validCount,
              originalCount: t.originalCount,
              compactedToOriginal: t.compactedToOriginal,
              skipped: t.skipped,
            };
            //>>includeStart('debug', pragmas.debug);
            if (t.debug) {
              t.debug.sortedCompactedIndices = Array.from(latest.indices);
              this._gpuSortDebugCapture = t.debug;
            }
            //>>includeEnd('debug');
          }
        }
      }
    }
    return true;
  }

  // ─── High-density cull diagnostic surface ──────────────────────────────

  /**
   * Safety-policy snapshot that deliberately reads only already-owned renderer
   * and context state. Diagnostics must not trigger lazy feature-renderer,
   * culler, indirect-manager, or OIT allocation.
   */
  getContainmentStats(): {
    gpuCullerOpaque: ModeUnsafePathStatus<"auto" | "always" | "never">;
    gpuCullerTranslucent: ModeUnsafePathStatus<"auto" | "always" | "never">;
    hiZ: UnsafePathStatus & {
      producerMode: "auto" | "always" | "never";
      consumeEnabled: boolean;
    };
    gpuSortKeys: ModeUnsafePathStatus<"auto" | "always" | "never"> & {
      producerMode: "auto" | "always" | "never";
    };
    tileIndirect: ModeUnsafePathStatus<"auto" | "always" | "never">;
    webgpuOIT: UnsafePathStatus & {
      safetyGateEnabled: boolean;
    };
  } {
    const anyTrue = (m: Map<number, boolean>): boolean => {
      for (const value of m.values()) {
        if (value) return true;
      }
      return false;
    };
    const fallbackFor = (
      requested: boolean,
      capable: boolean,
      active: boolean,
      inactiveReason: string,
    ): string | null => {
      if (!requested) return "not-requested";
      if (!capable) return "unsupported";
      return active ? null : inactiveReason;
    };

    const producerMode = this._gpuCullingRequestedMode;
    const producerRequested = producerMode !== "never";
    const computeCapable = this._lastContext?.supportsComputeShaders === true;

    const opaqueGateActive =
      producerRequested && anyTrue(this._gpuCullActiveByFrustum);
    const opaqueActive = producerRequested && this._gpuCullLastInput > 0;
    const translucentRequested = producerMode === "always";
    const translucentGateActive =
      translucentRequested && anyTrue(this._gpuCullTranslucentActiveByFrustum);
    const translucentActive =
      translucentRequested && this._gpuCullLastTranslucentInput > 0;

    const hiZRequested = this._hiZConsumeEnabled;
    const hiZActive =
      hiZRequested && producerRequested && this._hiZConsumedThisFrame;
    let hiZFallback = fallbackFor(
      hiZRequested,
      computeCapable,
      hiZActive,
      "producer-inactive-or-result-not-ready",
    );
    if (hiZRequested && !producerRequested) {
      hiZFallback = "producer-disabled";
    }

    const sortRequested = this._gpuSortConsumeMode !== "never";
    const sortActive =
      sortRequested && producerRequested && this._sortConsumeAppliedThisFrame;
    let sortFallback = fallbackFor(
      sortRequested,
      computeCapable,
      sortActive,
      "producer-inactive-or-result-not-ready",
    );
    if (sortRequested && !producerRequested) {
      sortFallback = "producer-disabled";
    }

    const oitRequested = this._lastOITRequested;
    const oitCapable = !!(
      this._lastContext as unknown as { _device?: GPUDevice | null }
    )?._device;
    const oitActive =
      oitRequested && this._webgpuOITEnabled && this._webgpuOITActiveThisFrame;
    let oitFallback: string | null;
    if (!oitRequested) {
      oitFallback = "not-requested";
    } else if (!this._webgpuOITEnabled) {
      oitFallback = "contained-unsafe-path";
    } else if (!oitCapable || (this._oit && !this._oit.isSupported)) {
      oitFallback = "unsupported";
    } else {
      oitFallback = oitActive ? null : "inactive-or-resources-not-ready";
    }

    const tile = this._tileIndirectStatus;
    return {
      gpuCullerOpaque: {
        requestedMode: producerMode,
        requested: producerRequested,
        capable: computeCapable,
        active: opaqueActive,
        fallbackReason: fallbackFor(
          producerRequested,
          computeCapable,
          opaqueActive,
          opaqueGateActive
            ? "result-not-ready-or-not-applied"
            : "below-threshold",
        ),
      },
      gpuCullerTranslucent: {
        requestedMode: producerMode,
        requested: translucentRequested,
        capable: computeCapable,
        active: translucentActive,
        fallbackReason:
          producerMode === "auto"
            ? "requires-always-opt-in"
            : fallbackFor(
                translucentRequested,
                computeCapable,
                translucentActive,
                translucentGateActive
                  ? "result-not-ready-or-not-applied"
                  : "below-threshold",
              ),
      },
      hiZ: {
        producerMode,
        consumeEnabled: hiZRequested,
        requested: hiZRequested,
        capable: computeCapable,
        active: hiZActive,
        fallbackReason: hiZFallback,
      },
      gpuSortKeys: {
        requestedMode: this._gpuSortConsumeMode,
        producerMode,
        requested: sortRequested,
        capable: computeCapable,
        active: sortActive,
        fallbackReason: sortFallback,
      },
      tileIndirect: {
        requestedMode: tile.requestedMode,
        requested: tile.requested,
        capable: tile.capable,
        active: tile.active,
        fallbackReason: tile.fallbackReason,
      },
      webgpuOIT: {
        safetyGateEnabled: this._webgpuOITEnabled,
        requested: oitRequested,
        capable: oitCapable,
        active: oitActive,
        fallbackReason: oitFallback,
      },
    };
  }

  /**
   * Snapshot of the three threshold-gated GPU dispatchers' current
   * state + per-frame effectiveness. Read by `Scene.getDebugSnapshot()`
   * as `scene.getDebugSnapshot().highDensityCull`.
   *
   * Counters reset on context destruction; the `last*` fields
   * reflect the most recent frame the dispatcher ran. `hitRatio` is
   * `(input - filtered) / input` — fraction of commands the GPU
   * filter dropped. Above 0.2 means the dispatcher is paying for
   * itself; near 0 means the gate fired but the cull found nothing
   * to drop (likely the CPU cull was already tight).
   */
  getHighDensityCullStats(): {
    gpuCullerOpaque: ModeUnsafePathStatus<"auto" | "always" | "never"> & {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    gpuCullerTranslucent: ModeUnsafePathStatus<"auto" | "always" | "never"> & {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    hiZ: UnsafePathStatus & {
      producerMode: "auto" | "always" | "never";
      consumeEnabled: boolean;
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      buildsSkipped: number | null;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    gpuSortKeys: ModeUnsafePathStatus<"auto" | "always" | "never"> & {
      producerMode: "auto" | "always" | "never";
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      consumeMode: "auto" | "always" | "never";
      consumeEnabled: boolean;
      consumeApplied: number;
      consumeSkipped: number;
      hasReadback: boolean;
    };
    shadowCascadeCull: {
      activeAnyCascade: boolean;
      cascadeCount: number;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      lastFrameInputPerCascade: number[];
      lastFrameFilteredPerCascade: number[];
    };
  } {
    const ratio = (input: number, filtered: number): number =>
      input > 0 ? (input - filtered) / input : 0;
    const anyTrue = (m: Map<number, boolean>): boolean => {
      for (const v of m.values()) if (v) return true;
      return false;
    };
    const containment = this.getContainmentStats();
    return {
      gpuCullerOpaque: {
        ...containment.gpuCullerOpaque,
        activeAnyFrustum: anyTrue(this._gpuCullActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
        dispatches: this._gpuCullDispatchCount,
        lastFrameInput: this._gpuCullLastInput,
        lastFrameFiltered: this._gpuCullLastFiltered,
        hitRatio: ratio(this._gpuCullLastInput, this._gpuCullLastFiltered),
      },
      gpuCullerTranslucent: {
        ...containment.gpuCullerTranslucent,
        activeAnyFrustum: anyTrue(this._gpuCullTranslucentActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
        dispatches: this._gpuCullTranslucentDispatchCount,
        lastFrameInput: this._gpuCullLastTranslucentInput,
        lastFrameFiltered: this._gpuCullLastTranslucentFiltered,
        hitRatio: ratio(
          this._gpuCullLastTranslucentInput,
          this._gpuCullLastTranslucentFiltered,
        ),
      },
      hiZ: {
        ...containment.hiZ,
        activeAnyFrustum: anyTrue(this._hiZActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.HI_Z_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.HI_Z_THRESHOLD_LO,
        dispatches: this._hiZDispatchCount,
        buildsSkipped:
          null /* dispatcher-side counter, surfaced via FR getStatistics() */,
        lastFrameInput: this._hiZLastInput,
        lastFrameFiltered: this._hiZLastFiltered,
        hitRatio: ratio(this._hiZLastInput, this._hiZLastFiltered),
      },
      gpuSortKeys: {
        ...containment.gpuSortKeys,
        activeAnyFrustum: anyTrue(this._gpuSortActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_LO,
        dispatches: this._sortKeysDispatches,
        // `consumeMode` surfaces the explicit consumer policy;
        // `consumeEnabled` stays true whenever the mode is not "never".
        consumeMode: this._gpuSortConsumeMode,
        consumeEnabled: this.gpuSortConsumeEnabled,
        consumeApplied: this._sortConsumeApplied,
        consumeSkipped: this._sortConsumeSkipped,
        hasReadback: !!this._lastSortedIndices,
      },
      shadowCascadeCull: this._buildShadowCascadeCullStats(),
    };
  }

  /**
   * Reads per-cascade GPU culling statistics from the cascaded-shadow-map
   * renderer's host fields and
   * format them for `getHighDensityCullStats()`. Returns zero/empty
   * shape when no CSM renderer is attached (e.g., scene without
   * `useCascadedShadowMaps`), so consumers can read the field
   * unconditionally.
   */
  private _buildShadowCascadeCullStats(): {
    activeAnyCascade: boolean;
    cascadeCount: number;
    thresholdHi: number;
    thresholdLo: number;
    dispatches: number;
    lastFrameInputPerCascade: number[];
    lastFrameFilteredPerCascade: number[];
  } {
    // Read the CSM renderer state through a duck-typed shape so we
    // don't pull in a hard dependency on the CSM module here.
    // `_lastContext` cached per-frame in `_executeOpaquePass`.
    const ctx = this._lastContext as unknown as {
      _csmRenderer?: {
        _cascadeCount: number;
        _cascadeCullActive: boolean[];
        _cascadeCullDispatches: number;
        _cascadeCullLastInput: number[];
        _cascadeCullLastFiltered: number[];
      } | null;
    } | null;
    const csm = ctx?._csmRenderer ?? null;
    if (!csm) {
      return {
        activeAnyCascade: false,
        cascadeCount: 0,
        thresholdHi: 2400,
        thresholdLo: 1600,
        dispatches: 0,
        lastFrameInputPerCascade: [],
        lastFrameFilteredPerCascade: [],
      };
    }
    let any = false;
    for (const a of csm._cascadeCullActive) {
      if (a) {
        any = true;
        break;
      }
    }
    return {
      activeAnyCascade: any,
      cascadeCount: csm._cascadeCount,
      thresholdHi: 2400,
      thresholdLo: 1600,
      dispatches: csm._cascadeCullDispatches,
      lastFrameInputPerCascade: csm._cascadeCullLastInput.slice(),
      lastFrameFilteredPerCascade: csm._cascadeCullLastFiltered.slice(),
    };
  }

  // CPU pass profiler accessors.

  /**
   * Toggle the CPU-side per-pass recording-cost profiler. Off by default and
   * clock/allocation/state-mutation-free at its marker sites. Enable via
   * `CesiumDebug.cpuPassCost(true)` to start collecting samples.
   */
  setCpuPassProfiling(enabled: boolean): void {
    if (enabled && !this._cpuPassProfiler.enabled) {
      this._cpuPassProfiler.reset();
    }
    this._cpuPassProfiler.setEnabled(enabled);
  }

  /** Whether whole-frame CPU accounting should clock the Scene boundary. */
  get cpuPassProfilingEnabled(): boolean {
    return this._cpuPassProfiler.enabled;
  }

  /** Open the attributed ledger for one logical Scene.render invocation. */
  beginCpuSceneFrame(
    frameNumber: number,
    initialPhase: CpuScenePhaseName,
  ): number | undefined {
    return this._cpuPassProfiler.beginSceneFrame(frameNumber, initialPhase);
  }

  /** Advance the exclusive coarse Scene phase for the exact logical token. */
  setCpuScenePhase(frameNumber: number, phase: CpuScenePhaseName): boolean {
    return this._cpuPassProfiler.markScenePhase(frameNumber, phase);
  }

  /** Pair Scene.render time with the pass ledger for the same logical frame. */
  recordSceneFrameCpu(
    frameNumber: number,
    sceneRenderMs: number,
    endTimestamp?: number,
  ): boolean {
    return this._cpuPassProfiler.recordSceneFrameCpu(
      frameNumber,
      sceneRenderMs,
      endTimestamp,
    );
  }

  /** Discard an interrupted logical Scene frame without a partial sample. */
  cancelCpuSceneFrame(frameNumber: number): boolean {
    return this._cpuPassProfiler.cancelSceneFrame(frameNumber);
  }

  /**
   * Get the rolling-window per-pass CPU recording cost profile. Returns
   * empty `passes` until profiling has been enabled and at least one
   * frame has run.
   */
  getCpuPassProfile(): CpuPassProfile {
    return this._cpuPassProfiler.getStats();
  }
}
