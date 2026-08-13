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
import FeatureRendererKey from "../FeatureRendererKey.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import { WebGPUEdgeFramebuffer } from "./WebGPUEdgeFramebuffer.js";
import { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";
// C-R8-EDGE-COMPOSITE-PRUNE (Batch 50) — `WebGPUEdgeComposite` retired.
// Model edges now composite inline inside `ModelPBRComplete.wgsl` via
// `applyEdgeOverlay()` (Batch 48), with full per-feature gating that
// the post-process consumer couldn't see. Primitive shaders don't
// emit edge commands, so no consumer is missing — the file was the
// only path the post-process overlay served. If a future emitter
// (decals, ground primitives) adds a `Pass.CESIUM_3D_TILE_EDGES`
// command path, restore the composite OR ride C-R8-EDGE-INLINE-PRIMITIVES
// to extend the inline stage to that shader family.
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
  // ── SCENE2D infinite-scroll wrap (BUG-3) ──
  // `execute2DViewportCommands` (ViewportExecutor.js) renders the 2D map in
  // two viewport halves via TWO `executeCommands` calls per frame, each with
  // its own off-center frustum + `passState.viewport` sub-rect. WebGL
  // accumulates both halves into one framebuffer (clear on the first half
  // only). The WebGPU renderer mirrors that by accumulating both halves into
  // the scene framebuffer and blitting once:
  //   - `sceneFbLoad`: when true, open the scene-FB pass with color
  //     loadOp="load" (preserve the first half) instead of "clear". Set on the
  //     SECOND half. Undefined/false → clear (normal single-pass behavior).
  //   - `deferComposite`: when true, skip the post-frustum chain (env effects,
  //     composite, velocity, post-process blit) AND the per-frame
  //     perf/profiler endFrame so the first half just accumulates into the
  //     scene FB. Set on the FIRST half of a split. The SECOND (or single)
  //     pass runs the chain, which blits the fully-accumulated scene FB once.
  // The perf/profiler beginFrame is correspondingly skipped on the second half
  // (sceneFbLoad=true) so the begin/end pair stays balanced across the two
  // calls. Both default false → byte-for-byte the pre-fix single-pass path.
  sceneFbLoad?: boolean;
  deferComposite?: boolean;
}

// --------------- Module-level helpers ---------------

// Per-context once-per-key warning tracker. Replaces the old
// `(context as any)._warnedCommands` monkey-patching pattern with a
// module-level WeakMap so we don't need `as any` casts.
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
 * Backend-agnostic derived-command dispatcher (C-R2) — mirrors the
 * polymorphic selection in {@link Scene/SceneRenderer.js#executeCommand}
 * so WebGPU honours `logDepth` / `hdr` / `picking` / `pickingMetadata` /
 * `depth-only` / `shadows.receive` variants when a feature renderer has
 * populated them on the command.
 *
 * Empty `derivedCommands` (the common case for WebGPU-native feature
 * renderers that handle variants internally) falls through to the base
 * command, so wiring this dispatcher on top of the existing execute path
 * is byte-identical for those renderers.
 *
 * `isPickPass = true` is how `_executePickBatch` signals that it is
 * rendering to the pick FBO; the WebGL path infers this from
 * `frameState.passes.pick`, but the WebGPU pick pass runs as a separate
 * branch so we pass the signal explicitly to keep the dispatcher a pure
 * function.
 */
// Exported so the extracted pick-pass module
// (`WebGPUSceneRendererPickPass.ts`, Batch 133) can call the same
// dispatcher the in-file `executeWebGPUCommand` uses. Internal-API
// shape preserved exactly; this is just a visibility flip.
export function selectCommandVariant(
  command: CesiumAnyDrawCommand,
  scene: CesiumScene,
  isPickPass: boolean,
  /**
   * UP144-SNAP-WEBGPU (C11-212) — select the SNAPPING variant instead of the
   * pick variant. Deliberately a caller-supplied axis rather than a read of
   * `frameState.passes.snap`: a snapping mini-frame runs TWO phases over the
   * same frame state, and the occluder phase must keep selecting the ordinary
   * pick variants (that is what writes the depth the payload phase tests
   * against). Only the payload phase passes `true`, so every non-snap caller —
   * and the occluder phase — is byte-identical to before.
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
  // (matching SceneRenderer.executeCommand line 49-51). EXCEPT during PICK:
  // the pick command is attached to the BASE command's
  // `derivedCommands.picking.pickCommand` (attachPickToColorCommand), NOT to
  // the log-depth variant. Swapping first hides it, so the pick check below
  // falls through and returns the log-depth COLOR command — whose MRT
  // scene-framebuffer attachments are incompatible with the single-target
  // pick render pass, so WebGPU drops every pick draw and the pick FBO stays
  // empty (FORK-34: all picking returns undefined). The pick pass renders its
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
      // UP144-SNAP-WEBGPU (C11-212) — snapping payload phase. A command with a
      // snap variant renders it (writing the RGBA32F snap payload); a command
      // WITHOUT one returns unchanged, which the pass executor reads as "skip"
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
      // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — route to hover or
      // precise pick variant when the scene-level mode flag is set.
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
        // C-R9-VOXEL-CELL-PICK — a pickVoxel pass routes to the per-cell
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

  // C-R2: run the base command through the derived-command dispatcher so
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
// Exported so the extracted translucent-pass module
// (`WebGPUSceneRendererTranslucentPass.ts`, Batch 136) can call the
// same back-to-front sorter used by the in-file alpha-blend fallback.
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
// Exported so the extracted per-frustum loop module
// (`WebGPUSceneRendererFrustumLoop.ts`, Batch 140) can call the same
// splat-distance sorter the inline path uses.
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

// Exported so the extracted globe-pass module
// (`WebGPUSceneRendererGlobePass.ts`, Batch 135) can call the same
// dispatcher used elsewhere in this file. Internal-API shape preserved.
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
 * same pipeline + bind group identity AND that already have an attached
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
// Exported alongside `executeBatch` so the extracted 3D-tile-passes
// module (`WebGPUSceneRenderer3DTilePasses.ts`, Batch 137) can reach
// the indirect-draw fast path the in-file `runPass` chose.
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
      // C11-195 — bind-group identity is no longer sufficient. Under a
      // dynamic-offset arena two different models on the same ring page share
      // one group-0 bind group and differ ONLY in their byte offset, so
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
        // ignored — head will simply be missing from the frame
        void e;
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
        // C11-195 — every command in this run was proven to carry identical
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
 * C11-195 — structural equality for per-group dynamic-offset arrays. Compares
 * BY VALUE, not by reference: two commands built from the same arena slice
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
// Exported alongside `executeBatch` for the same Batch-135 reason.
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
    // AUDIT_2026_05_02 A.1 — `WebGPUGlobeTranslucencyState.update*()`
    // populates `_webgpuTranslucencyDerived[0..N-1]` with one derived
    // descriptor per pass (front-faces, back-faces, depth-only, etc.).
    // Previously this loop only read `[0]`, dropping every subsequent
    // derived pass — so any scene needing more than a single derived
    // pass (the common case for globe translucency) rendered with
    // incomplete blend/depth contributions. Now we iterate the full
    // count, materializing the per-derived pipeline variant for each.
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

// NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — debug
// capture shape returned by `getGpuSortConsumeSnapshot()` for the
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

// NEW-GPU-SORT-PIPELINE Phase 3 — opaque tag carried through the
// dispatcher's readback ring so the decoded (compacted) sorted indices
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

  // Batch 226 (NEW-SHADOW-CAST-GPU-CULL-PHASE-2 stats wire-in) —
  // cached context reference set during `_executeOpaquePass` so
  // diagnostic surfaces (`getHighDensityCullStats`) can read CSM
  // renderer state without threading the context through every
  // call. The renderer is owned by a single Scene tied to a single
  // Context, so caching here is safe.
  private _lastContext: WebGPUContext | null = null;

  // Slice 5c-B Batch 117 — per-frame scene reference for `_resumeScenePass`
  // and `_clearDepthStencil` to reach into `scene._view.gBufferFramebuffer`
  // when re-opening the scene-FB render pass with the MRT slot-1
  // attachment. Stashed at the top of `executeCommands` (the only
  // method that's already wired with `config.scene`) and cleared at
  // frame end. Cheaper than threading scene through all 8+ callers of
  // the two re-open methods.
  public _scene: unknown = null;

  // Scene-level rendering resources (lazy-initialized)
  // Public underscore: shared with the executeCommands slice extracts
  // (`WebGPUSceneRendererPassRedirect.ts`, Batch 138 — and following
  // slices in Batches 139-141).
  public _sceneFramebuffer: WebGPUSceneFramebuffer | null = null;
  // C-R8-EDGE-FBO (Batch 44) — MRT framebuffer for the
  // CESIUM_3D_TILE_EDGES pass (edge color + id + packed depth + depth-
  // stencil). Lazily allocated on first frame where
  // `scene._enableEdgeVisibility` is true; stays null otherwise to
  // avoid paying the allocation cost for scenes that don't use edges.
  // Public underscore: shared with the extracted 3D-tile-passes
  // module (`WebGPUSceneRenderer3DTilePasses.ts`, Batch 137).
  public _edgeFramebuffer: WebGPUEdgeFramebuffer | null = null;
  // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — translucent tile
  // classification. Allocated when a frame produces classification
  // commands AND has translucent geometry that needs depth capture.
  // Currently allocates eagerly when scene-init runs because the
  // first-cut depth-capture path uses `copyTextureToTexture` from the
  // scene framebuffer — cheap to keep allocated.
  // Public underscore: shared with executeCommands slice extracts
  // (Batch 139's per-frame state reset + Batch 140's per-frustum loop).
  public _translucentTileClassification: WebGPUTranslucentTileClassification | null =
    null;
  // Public underscore: shared with the extracted translucent-pass
  // module (`WebGPUSceneRendererTranslucentPass.ts`, Batch 136).
  public _oit: WebGPUOIT | null = null;
  // FAR-003: the public Scene OIT option remains a request, while this
  // renderer-owned safety gate controls whether the currently unsafe WebGPU
  // MRT implementation may allocate or execute. Default false preserves the
  // complete alpha-blend fallback.
  public _webgpuOITEnabled: boolean = false;
  public _lastOITRequested: boolean = false;
  public _webgpuOITActiveThisFrame: boolean = false;
  // Public underscore: shared with the executeCommands frustum-loop
  // slice (Batch 140).
  public _globeDepth: WebGPUGlobeDepth | null = null;
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _depthPlane: WebGPUDepthPlane | null = null;
  // Public underscore: shared with the post-frustum chain slice
  // (Batch 141).
  public _postProcess: WebGPUPostProcessPipeline | null = null;
  // Tier 2 debug — fullscreen depth visualization. Lazily constructed
  // on first request so production frames pay nothing.
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _debugDepthOverlay: WebGPUDebugDepthOverlay | null = null;
  private _depthOverlayWarningLogged: boolean = false;
  // Phase 8a Slice 2c (Batch 89) — debug overlay that visualizes the
  // G-buffer normal texture as a fullscreen blit. Lazy-constructed on
  // first invocation; null when `scene.debugShowGBufferNormals` is off.
  public _debugGBufferOverlay: WebGPUDebugGBufferOverlay | null = null;
  private _gbufferProducerWarnedNoDepth: boolean = false;
  // Tier 2 debug — frustum + command tint overlay (WebGPU equivalent of
  // `debugShowFrustums` / `debugShowCommands`). Lazy.
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _debugFrustumOverlay: WebGPUDebugFrustumOverlay | null = null;
  // NEW-GEOJSON-WEBGPU-BV-DEBUG-DRAW-PASS — per-command
  // `debugShowBoundingVolume` red-wireframe pass (WebGPU equivalent of
  // SceneDebug's WebGL bounding-volume draw). Lazy; null until the first
  // frame that has a flagged command.
  public _boundingVolumeDebugPass: WebGPUBoundingVolumeDebugPass | null = null;
  // Captured during the frustum loop so the post-process debug overlay
  // can tint pixels by which frustum drew them. Reset each frame.
  // Public underscore: shared with executeCommands slice extracts
  // (Batch 139's per-frame state reset + Batch 140's per-frustum loop).
  public _capturedFrustumRanges: { near: number; far: number }[] = [];

  // C-R8-INVERT-CLASS-STENCIL (Batch 40) — set by `_execute3DTilePasses`
  // when it successfully runs the CLASSIFICATION_IGNORE_SHOW pass into
  // the invert FBO, meaning the depth-stencil view carries stencil
  // bits the final composite can use to split classified vs
  // unclassified tile pixels. Reset per-frame at the start of the
  // scene render loop; consumed by `_runInvertClassificationComposite`.
  // Public underscore: shared with the extracted 3D-tile-passes
  // module (Batch 137). Stencil readiness flag for invert-composite.
  public _invertClassStencilReady: boolean = false;

  // C-R8-EDGE-FBO (Batch 44) — set by `_execute3DTilePasses` when the
  // CESIUM_3D_TILE_EDGES pass actually ran into the edge MRT
  // framebuffer AND produced content. Reset per-frame; the model FS
  // inline edge stage (Batch 48) reads it via `context._edge*View` to
  // decide whether to gate the overlay or skip.
  // Public underscore: shared with the extracted 3D-tile-passes
  // module (Batch 137).
  public _edgeTexturesPopulated: boolean = false;
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _initialized: boolean = false;
  // Public underscore: shared with the extracted 3D-tile-passes
  // module (Batch 137).
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
  // Audit C.11 (Batch 132) -- per-frame viewport derived from
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
  // Batch 109 — track last-applied HDR mode so a runtime toggle of
  // `scene.useHDR` triggers a framebuffer recreate even when the
  // window dimensions don't change. Initial value `null` so the
  // first `update()` call always reaches `_sceneFramebuffer.update`
  // regardless of the initial HDR setting. See Batch 110 for the
  // companion pipeline-cache invalidation that completes the
  // runtime toggle (without it, pipelines have the old canvas
  // format baked in and produce validation warnings against the
  // recreated rgba16float scene FB).
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _lastHDR: boolean | null = null;

  // Slice 5d Batch 151 — Forward+ clustered lighting dispatcher.
  // Lazily constructed on first use (the device isn't available at
  // SceneRenderer construction time). Owns the cluster-bounds +
  // cluster-assign compute renderers + the params uniform; consumer
  // pipelines bind its public buffers at @group(4) via the chunk in
  // ClusteredLighting.wgsl.
  //
  // Inert when scene.clusteredLightingEnabled === false OR when zero
  // lights are configured — the dispatcher returns activeLightCount=0
  // and the consumer FS chunk early-outs without touching the storage
  // buffers.
  // Batch 310 — public-underscore (was `private`) so the extracted
  // WebGPUSceneRendererClusteredLighting slice can lazily construct +
  // read it through the `ClusteredLightingHost` surface, matching the
  // cross-module access convention used by the other SceneRenderer
  // slice hosts (e.g. `_postProcess`, `_sceneFramebuffer`).
  public _clusteredLightingDispatcher: WebGPUClusteredLightingDispatcher | null =
    null;
  // Session 65 Batch 25 — track previous MSAA sample count so the
  // scene framebuffer recreate path AND the render bundle cache
  // invalidation both fire when `scene.msaaSamples` changes. The
  // bridge in `prepareFrame` writes `context._msaaSamples`; that
  // value alone doesn't trigger a recreate because the framebuffer
  // already exists at the old sample count.
  // Session 65 Batch 36 — initial value `1` (not null) so the first
  // frame after the bridge re-enable correctly detects the
  // 1→4 transition and triggers framebuffer recreate + bundle
  // invalidation. A null sentinel would skip the change detection
  // on the very frame the bridge first takes effect.
  public _lastMsaaSamples: number = 1;
  private _depthPlaneWarned: boolean = false;

  // ── Debug log-once guards (pragma-stripped in production) ──
  // `_renderPassRedirectLogged` is `public` so the extracted
  // render-pass-redirect module (Batch 138) can read/write it via the
  // host interface. Production builds strip the declaration along
  // with the pragma block; the new module's reads/writes are also
  // inside their own pragma blocks, so production never touches the
  // field. Visibility is TS-only — no runtime cost difference.
  //>>includeStart('debug', pragmas.debug);
  private _execDebugLogged: boolean = false;
  private _debugLogged: boolean = false;
  private _postInitDebugLogged: boolean = false;
  public _renderPassRedirectLogged: boolean = false;
  // `public` so the post-frustum chain slice (Batch 141) can read/
  // write through the host interface. Field declaration stays inside
  // the surrounding pragma block.
  public _ppDebugLogged: boolean = false;
  private _globeValidationDone: boolean = false;
  private _globePassRPLogged: boolean = false;
  private _globeCountLogged: boolean = false;
  private _globeCountLogFrame: number = -1;
  private _globePassLastLog: number = 0;
  //>>includeEnd('debug');

  // ── Runtime state that was previously ad-hoc on `this as any` ──
  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _currentFrustumIndex: number = 0;
  // Public underscore: shared with the extracted translucent-pass
  // module (`WebGPUSceneRendererTranslucentPass.ts`, Batch 136).
  public _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null = null;
  // C7-SPLAT-DEPTH-COMPOSE — opt-in GS-WSR splat-to-OIT deferral. DEFAULT
  // FALSE = WebGL parity. WebGL executes GAUSSIAN_SPLATS inline in the scene
  // pass (`GaussianSplatPrimitive.js` pushes its DrawCommand — depthTest on,
  // depthMask off, PRE_MULTIPLIED_ALPHA blend — into `commandList`; the
  // GAUSSIAN_SPLATS pass draws it right after OPAQUE and never routes it
  // through OIT). The fork's GS-WSR deferral (Batch 136-era) routed splats
  // that carried an `_oitPipeline` into the translucent OIT accumulation pass
  // instead; but `executeTranslucentPass` early-returns when the frame has
  // ZERO TRANSLUCENT commands (the common bare-globe + splat scene), so the
  // deferred splats were silently DROPPED every frame — the splat vanished,
  // presenting as "occluded by the opaque globe". Gating the deferral behind
  // this default-false flag restores inline WebGL-parity execution; the
  // translucent pass also carries a never-drop seatbelt for the armed path.
  public _splatOITDeferral: boolean = false;
  // NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — per-frustum readback
  // slot for the opaque pass. Each frustum dispatches against its own
  // culler instance and stores its readback under its own frustum
  // index, so multi-frustum scenes (typical with log-depth) get full
  // GPU cull benefit instead of the previous "last-frustum-wins"
  // limitation.
  private _lastCullResultsByFrustum: Map<number, GPUCullResults> = new Map();
  // Wave-0 P0 fix — per-frustum readback in-flight guard. The GPUCuller's
  // readback staging buffer is mapped (mapAsync) while `readResults`
  // resolves; re-running `prepareReadback` (copyBufferToBuffer into that
  // staging buffer) on the next frame while it is still mapped raises
  // "[Buffer] used in submit while mapped", invalidating the whole command
  // buffer → dense-scene black screen. Mirrors `_hiZReadbackInFlight`.
  private _gpuCullReadbackInFlight: Set<number> = new Set();
  // Batch 216 — separate readback slot for the translucent pass so
  // its readback (keyed on the translucent command count) doesn't
  // race / mismatch with the opaque pass's. Same 1-frame latency
  // contract.
  private _lastCullResultsTranslucent: GPUCullResults | null = null;
  private _gpuCullFilterPoolTranslucent: CesiumAnyDrawCommand[] = [];
  // Batch 213 (cosmetic) — reusable filter output array for
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

  // NEW-HIZ-CONSUME (Batch 210) — HiZ occlusion threshold-gated state.
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
  // FAR-003 — renderer-owned consumer activation flag, default OFF. Keeping
  // this per instance prevents one scene's diagnostic toggle from changing
  // another scene/context and makes visibility consumption an explicit opt-in.
  //
  // The Hi-Z pyramid build + OcclusionTest dispatch + async readback run
  // whenever the density gate is active; when this flag is true the visibility
  // result is allowed to DROP occluded commands.
  //
  // **C2-21 root cause (the real blocker, finally found):** the pyramid was
  // built from `context.depthOnlyTextureView` — the context's DEFAULT depth
  // texture, which the WebGPU scene NEVER writes (it renders into
  // `_sceneFramebuffer`, post-process is mandatory). So mip 0 read an
  // unwritten, clear=1.0 depth → the whole pyramid was FAR → `sphereNearZ >
  // maxHiZ` could never hold → hitRatio pinned to 0 no matter how correct the
  // OcclusionTest math was. The earlier "two correctness gaps" (mip off-by-one,
  // 4-corner background bleed) were real but only ever cause UNDER-culling
  // (overhang-sky → maxHiZ=1.0 → stays VISIBLE) — they are conservative and
  // cannot produce a false-cull. `_dispatchHiZForNextFrame` now sources
  // `_sceneFramebuffer.depthSampleableView` (the same MSAA-resolved
  // sampleable depth velocity/AO/DoF bind), and the dispatcher picks the
  // texture_2d<f32> mip-0 pipeline for the r16float MSAA-resolved view vs the
  // texture_depth_2d pipeline for single-sample.
  //
  // **Verified (`probe-fork41-occlusion-v2.mjs`):** an occludable scene (a
  // wide near "lid" over 2500 cubes it fully hides) culls the cubes
  // (hitRatio 1.0, hiZFiltered 397/992897) and the consume-ON image is
  // 0.007% identical to GPU-cull-forced-off — the dropped cubes were hidden
  // anyway, so zero visible change. The sky-overhanging tall-box scene
  // (`probe-fork41-occlusion.mjs`) confirms no false-cull. Toggle for A/B via
  // `setHiZConsumeEnabled` / `CesiumDebug.hiZConsume`.
  private _hiZConsumeEnabled: boolean = false;

  /**
   * FORK-41 / C2-21 — enable/disable the consumer-side application of Hi-Z
   * occlusion visibility (dropping occluded commands). FAR-003 keeps this OFF
   * until result identity is tied to the producing frame/frustum/command list.
   * The build/dispatch/readback can still run in an explicitly requested
   * producer mode; this toggle only controls result consumption.
   */
  setHiZConsumeEnabled(value: boolean): void {
    this._hiZConsumeEnabled = value === true;
  }

  /** FORK-41 — whether occluded commands are actually dropped. */
  get hiZConsumeEnabled(): boolean {
    return this._hiZConsumeEnabled;
  }

  /**
   * NS-GPU-SORT-NO-SCENE-WIRING — set the consumer-side activation mode
   * for the GPU-produced front-to-back sort order. `"never"` is the FAR-003
   * contained default. `"auto"` applies whenever the opaque-command-count
   * gate is active and `"always"` force-applies; `"never"` is the off-gate (the
   * keygen + bitonic sort + readback still run when the density gate is
   * active — stats surface via `highDensityCull()` — but the permutation
   * is never applied, byte-identical to the pre-heuristic default).
   * Reordering opaque commands is output-invariant, so every mode is
   * byte-neutral for the final image; the mode only trades early-Z cost.
   */
  setGpuSortConsumeMode(mode: "auto" | "always" | "never"): void {
    if (mode === "auto" || mode === "always" || mode === "never") {
      this._gpuSortConsumeMode = mode;
    }
  }

  /** NS-GPU-SORT-NO-SCENE-WIRING — current consumer activation mode. */
  get gpuSortConsumeMode(): "auto" | "always" | "never" {
    return this._gpuSortConsumeMode;
  }

  /**
   * NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) —
   * back-compat boolean toggle for the consumer. `true` maps to the
   * `"always"` mode (force-apply); `false` maps to `"never"` (the
   * off-gate). New callers should prefer `setGpuSortConsumeMode` so the
   * `"auto"` production heuristic stays reachable — a boolean can't
   * express it. Used by `CesiumDebug.gpuSortConsume` for A/B probes.
   */
  setGpuSortConsumeEnabled(value: boolean): void {
    this._gpuSortConsumeMode = value === true ? "always" : "never";
  }

  /**
   * Phase 3 — whether the GPU sort order would be applied when the density
   * gate is active (i.e. mode is not `"never"`). In `"auto"`/`"always"`
   * the consumer applies; in `"never"` it does not.
   */
  get gpuSortConsumeEnabled(): boolean {
    return this._gpuSortConsumeMode !== "never";
  }

  /** Internal FAR-003 comparison gate for the contained WebGPU OIT path. */
  setWebGPUOITEnabled(value: boolean): void {
    this._webgpuOITEnabled = value === true;
  }

  /** Whether the unsafe WebGPU OIT implementation was explicitly forced. */
  get webgpuOITEnabled(): boolean {
    return this._webgpuOITEnabled;
  }
  // B214-N1 (Batch 219) — per-frustum gate state.
  private _hiZActiveByFrustum: Map<number, boolean> = new Map();
  // Batch 217 — HiZ effectiveness counters.
  private _hiZDispatchCount: number = 0;
  private _hiZLastInput: number = 0;
  private _hiZLastFiltered: number = 0;
  private _hiZAllocated: boolean = false;
  private _hiZAllocatedFor = { width: 0, height: 0, capacity: 0 };
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
  // Batch 213 (cosmetic) — reusable filter output for
  // `_filterByHiZVisibility`. Same lifetime model as
  // `_gpuCullFilterPool` above.
  private _hiZFilterPool: CesiumAnyDrawCommand[] = [];

  // NEW-GPUSORTKEYS-CONSUME (Batch 211) — threshold-gated GPU sort-key
  // generation. Phase 1 wire-in: produces packed 64-bit sort keys
  // (sortKeysHigh + sortKeysLow + commandIndices) on the GPU when the
  // command count justifies the dispatch.
  //
  // **Phase 2 (deferred):** the actual GPU sort over the keys is a
  // separate compute pipeline (bitonic / radix on u64) that doesn't
  // exist yet. Until that lands, the keys are generated but the
  // commands are still ordered by upstream JS sort. Tracked as
  // NEW-GPU-SORT-PIPELINE in DEFERRED_WORK.md.
  //
  // Threshold is intentionally high (5000) — JS sort is faster than
  // dispatch+readback round-trip below this density. SOA scratch is
  // allocated lazily, sized to the largest count seen.
  private static readonly GPU_SORT_KEYS_THRESHOLD = 5000;
  private static readonly GPU_SORT_KEYS_THRESHOLD_HI = 6000;
  private static readonly GPU_SORT_KEYS_THRESHOLD_LO = 4000;
  // B214-N1 (Batch 219) — per-frustum gate state.
  private _gpuSortActiveByFrustum: Map<number, boolean> = new Map();
  private _sortKeysAllocatedFor: number = 0;
  private _sortKeysSoA: {
    distanceSquared: Float32Array;
    renderLayers: Uint32Array;
    sortPriorities: Uint32Array;
    materialSortIds: Uint32Array;
    capacity: number;
  } | null = null;
  private _sortKeysDispatches: number = 0;
  // NEW-GPU-SORT-PIPELINE — sorted-indices readback state.
  // `_lastSortedIndices` is the most-recent decoded readback; the
  // consumer reorders the opaque command list using it (1-2 frame
  // latency via the dispatcher's deferred-readback ring, which handles
  // map-vs-submit races internally — no consumer-level in-flight flag).
  // NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — the
  // readback carries the compaction map so the permutation indexes the
  // ORIGINAL command array, not the compacted SOA. Canonical-distance
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
  // NS-GPU-SORT-NO-SCENE-WIRING (2026-07-05) — consumer-side activation
  // MODE. Three states, mirroring `Scene.gpuCullingHint` semantics:
  //   - "auto":  explicit threshold-characterization mode. The consumer applies
  //              the GPU front-to-back permutation whenever the per-frustum
  //              opaque-command-count gate (`gpuSortActive`, hysteresis
  //              GPU_SORT_KEYS_THRESHOLD_HI/LO) is active. This is the
  //              "live path" — the count threshold IS the heuristic, so no
  //              extra flag is needed for a dense scene to benefit.
  //   - "always": force-apply whenever a readback exists (debug/A-B).
  //   - "never" (DEFAULT): force-off; neither the sort producer nor consumer
  //              runs. This avoids ending the render pass, uploading keys,
  //              sorting, and mapping a readback whose result cannot be used.
  // Reordering opaque commands is output-invariant (depth test resolves
  // overlap) so every mode is byte-neutral for the final image; the mode
  // only trades early-Z efficiency. Precedent: `_hiZConsumeEnabled` (a
  // sibling consumer) is also explicitly opt-in while identity hazards remain.
  // Toggle via `setGpuSortConsumeMode` / `setGpuSortConsumeEnabled` /
  // `CesiumDebug.gpuSortConsume`.
  private _gpuSortConsumeMode: "auto" | "always" | "never" = "never";
  // Phase 3 diagnostic counters (surfaced via getHighDensityCullStats).
  private _sortConsumeApplied: number = 0;
  private _sortConsumeSkipped: number = 0;
  private _sortConsumeAppliedThisFrame: boolean = false;
  // Debug-only capture of the last dispatched compacted SOA + readback,
  // for the acceptance probe to verify the GPU order matches the CPU
  // comparator. Populated only under the debug pragma.
  private _gpuSortDebugCapture: GpuSortDebugCapture | null = null;

  // C-R12 (Batch 33) — Tracks the device-invalidation unsubscribe so
  // re-calls to `_ensureResources` don't stack duplicate subscribers.
  // Public underscore: shared with the _ensureResources slice (Batch 142).
  public _deviceInvalidationUnsub: (() => void) | null = null;

  // R-7a (FUTURE_RESEARCH 2026-05-01) — CPU-side per-pass recording-cost
  // profiler. Disabled by default; toggle via `setCpuPassProfiling(true)`
  // (or `CesiumDebug.cpuPassCost(true)`). Shared with the frustum-loop
  // slice via the host interface so per-frustum sub-passes accumulate
  // into per-frame buckets.
  public _cpuPassProfiler: WebGPUCpuPassProfiler = new WebGPUCpuPassProfiler(
    false,
  );

  // --- Lazy initialization ---

  /**
   * Batch 110 — early-frame hook that recreates the scene framebuffer
   * + bumps the scene-pipeline-format generation BEFORE primitives'
   * update methods run. Called from `Scene.render()` between
   * `context.beginFrame()` and `scene.updateEnvironment()`.
   *
   * Without this hook, the framebuffer recreation lives inside
   * `_ensureResources` which runs from `executeCommands` AFTER
   * primitives have already populated the command list. On the
   * runtime HDR toggle frame, primitives like SkyAtmosphere would
   * emit commands referencing the OLD-format pipeline (because the
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

    // Session 65 Batch 36 — MSAA bridge re-enabled after the
    // Batches 21+25+28+32+33+34+35 sweep made the downstream
    // pipelines MSAA-aware (SkyAtmosphere, Sun, Moon, CubeMapPanorama,
    // DepthPlane, Globe terrain, Model PBR + velocity + classification,
    // OIT composite, InvertClassification, TranslucentTileClassification,
    // GlobeDepth — every path that targets the scene FB now reads
    // `context._msaaSamples` and bakes the matching `multisample.count`
    // into its pipeline).
    //
    // Bridge: `scene.msaaSamples` (default 4 from `Scene.js:405`)
    // capped at 4 and propagated into `context._msaaSamples`. Triggers
    // - Scene FB recreate at the new sample count (Batch 25
    //   `_lastMsaaSamples` drift detection)
    // - Render bundle cache wipe (Batch 25 `msaaChanged` branch)
    // - `_scenePipelineFormatGeneration` bump → every generation-keyed
    //   pipeline cache (Globe, Model, OIT, InvertClassification, etc.)
    //   refreshes on the next frame
    //
    // Kill switch: set `scene.msaaSamples = 1` to fall back to no-AA.
    //
    // Batch 234 (NEW-COLLECTIONS-TAA-GATE-DORMANT) — TAA forces the
    // effective sample count to 1, implementing the contract documented
    // on `Scene.taaEnabled` ("Disables MSAA when active — the two are
    // incompatible"). The contract was never enforced before because the
    // velocity gates never fired (frameState.taaEnabled was unpublished),
    // so the incompatibility never surfaced: the velocity pass pairs the
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
    // Session 65 Batch 25 — detect MSAA sample-count drift. When the
    // bridge above writes `context._msaaSamples` from
    // `scene.msaaSamples`, the framebuffer needs recreation at the
    // new sample count AND the render bundle cache must be wiped
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
      // C10-03 — resize / HDR / MSAA flip destroys + recreates the resolve
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
      // AUDIT_2026_05_02 B.20 — every cached `GPURenderBundle` bakes its
      // pipeline's color attachment formats AND sample count. When
      // either the scene color format flips (HDR toggle) or the MSAA
      // sample count changes (Session 65 Batch 25), bundles that
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
    // Body extracted to `WebGPUSceneRendererEnsureResources.ts` in
    // Batch 142. The wrapper stays so `executeCommands` keeps calling
    // it as `this._ensureResources(config)`.
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

    // Slice 5c-B Batch 117 — stash scene for `_resumeScenePass` and
    // `_clearDepthStencil` so they can read `scene._view.gBufferFramebuffer`
    // when MRT mode is on. Cleared in the picking-early-return below
    // and at the natural end of this method.
    this._scene = scene;

    // Audit C.11 (Batch 132) -- snapshot the requested viewport once
    // per frame. `passState.viewport` is the BoundingRectangle the
    // caller (Scene / pick / OIT) requested; falls back to full canvas
    // when undefined. Bound + clamp to canvas so a stale rectangle
    // from a previous resize doesn't blow past the texture extents.
    const vp = (
      passState as unknown as {
        viewport?: { x: number; y: number; width: number; height: number };
      }
    ).viewport;
    if (vp) {
      this._viewportX = Math.max(0, vp.x | 0);
      this._viewportY = Math.max(0, vp.y | 0);
      // Audit re-review (Batch 134) -- Math.max(0, ...) outer clamp
      // prevents negative width/height when a stale split-screen rect
      // has its origin past the just-shrunk canvas. Negative
      // dimensions trip a WebGPU validation error and drop the frame;
      // clamping to 0 produces a degenerate-but-valid pass that
      // writes nothing this frame and recovers next.
      this._viewportWidth = Math.max(
        0,
        Math.min(this._width - this._viewportX, vp.width | 0),
      );
      this._viewportHeight = Math.max(
        0,
        Math.min(this._height - this._viewportY, vp.height | 0),
      );
    } else {
      this._viewportX = 0;
      this._viewportY = 0;
      this._viewportWidth = this._width;
      this._viewportHeight = this._height;
    }

    // --- PICK PASS: Render to pick framebuffer ---
    if (picking) {
      this._cpuPassProfiler.beginFrame();
      this._cpuPassProfiler.beginPass("pick");
      try {
        this._executePickPass(config);
      } finally {
        this._cpuPassProfiler.endPass("pick");
      }
      this._cpuPassProfiler.endFrame();
      // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — pick frames also call
      // `modelFr.update`, which sets `_sceneHasTransmission` when a
      // transmissive primitive is in view. The pick branch doesn't run
      // the regular capture step and exits before the end-of-frame
      // reset, so the flag would leak into the next regular frame and
      // trigger an unnecessary capture there. Reset here to keep the
      // flag scoped to the frame that set it.
      context._sceneHasTransmission = false;
      // Slice 5c-B Batch 117 — clear stashed scene reference on pick
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
    // BUG-3 — in the SCENE2D two-pass wrap, `beginFrame` runs only on the
    // first pass (`sceneFbLoad` false) and `endFrame` only on the last pass
    // (`deferComposite` false), so the begin/end pair stays balanced across
    // the two `executeCommands` calls that render one frame.
    const perfManager = context.performanceManager;
    if (perfManager && !config.sceneFbLoad) {
      perfManager.beginFrame();
    }

    // R-7a CPU pass profiler — begin the per-frame bucket. No-op when
    // profiling is disabled.
    if (!config.sceneFbLoad) {
      this._cpuPassProfiler.beginFrame();
    }

    // Slice 5d Batch 151 — dispatch clustered lighting compute passes
    // once per frame, BEFORE any material draws. The dispatcher
    // internally checks scene.clusteredLightingEnabled + light count
    // and skips both compute passes when disabled or empty. Output
    // storage buffers + params uniform are bound by consumer
    // pipelines at @group(4) via the chunk in ClusteredLighting.wgsl
    // (Batch 149). Inert today — Batch 152+ wires actual consumers.
    this._dispatchClusteredLighting(config);

    // --- Shadow cast pass ---
    // NOT dispatched here. `SceneRenderer.executeShadowMapCastCommands` is the
    // canonical, backend-neutral site: it is the ONLY place that populates
    // `ShadowMap.passes[j].commandList` (light-frustum + per-cascade culling of
    // `shadowState.casterCommands`), and it delegates to
    // `context.executeShadowMapCastCommands` immediately afterwards, before
    // `executeCommands` is ever reached.
    //
    // NEW-WEBGPU-GLOBE-SUN-SHADOW-RECEIVE-DEAD: this used to call the context
    // dispatch a SECOND time. `WebGPUContext.executeShadowMapCastCommands`
    // empties the per-pass command lists when it finishes, so the second entry
    // always collected zero casters — and once Batch 775 gave the caster-less
    // branch a transition clear, that second entry wiped the depth the first
    // entry had just written, on the same command encoder, before the color
    // pass sampled it. Every WebGPU receiver then read an all-far depth map and
    // reported "fully lit".
    //
    // The `shadow` CPU-pass-profiler bucket goes with it: the dispatch no longer
    // happens inside the renderer's frame. `shouldClearShadowCastTarget` keeps
    // the wipe impossible even if some future path re-enters the dispatch.

    // Opaque near offset to avoid tearing between adjacent frustums
    const opaqueFrustumNearOffset: number =
      scene.opaqueFrustumNearOffset ?? 0.9999;

    // ── Render-pass redirect (canvas → scene framebuffer) ──
    // Body extracted to `WebGPUSceneRendererPassRedirect.ts` in
    // Batch 138 (Slice A of the executeCommands decomposition plan,
    // see `migration_doc/BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`).
    setupSceneFramebufferRenderPass(this, context, config);

    // Per-frame state reset extracted to `WebGPUSceneRendererFrameReset.ts`
    // in Batch 139 (Slice B of the executeCommands decomposition plan).
    resetPerFrameState(this, context);

    // Multi-frustum dispatch loop extracted to
    // `WebGPUSceneRendererFrustumLoop.ts` in Batch 140 (Slice C of
    // the executeCommands decomposition plan). The 2D-jitter setup
    // is folded into the helper since it only feeds the loop.
    this._beginDepthPlanePass(config, numFrustums);
    executeFrustumLoop(this, config, opaqueFrustumNearOffset);

    // Post-frustum chain (overlay + depth plane + env effects +
    // invert composite + velocity pass + post-process + frame
    // teardown) extracted to `WebGPUSceneRendererPostFrustumChain.ts`
    // in Batch 141 (Slice D — final slice of the executeCommands
    // decomposition).
    //
    // BUG-3 — on the FIRST half of the SCENE2D wrap (`deferComposite`), skip
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

      // R-7a CPU pass profiler — close out the per-frame bucket and roll
      // into the rolling window. No-op when profiling is disabled.
      this._cpuPassProfiler.endFrame();
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
    // Body extracted to `WebGPUSceneRendererPickPass.ts` in Batch 133.
    // The wrapper stays here because `executeCommands` calls it as
    // `this._executePickPass(config)`. `_executePickBatch` (the inner
    // helper) moved with the body — no longer present on this class.
    // A pick can be the first work after recovery. Rebuild only this resource
    // family here; do not allocate the full scene/postprocess graph on a pick
    // hot path. Device identity is part of the helper's exact reuse contract.
    ensureDepthPlane(this, config);
    const maximumDraws = config.scene._view.frustumCommandsList.length;
    this._beginDepthPlanePass(config, maximumDraws);
    executePickPass(this, config);
  }

  // --- Frustum state ---

  // Public underscore: shared with the extracted pick-pass module
  // (`WebGPUSceneRendererPickPass.ts`, Batch 133). The other two
  // callers (`executeCommands` lines 1287 + 1488) still call it as
  // `this._updateFrustumUniforms(...)` — visibility flip only.
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
  // Public underscore: shared with the extracted 3D-tile-passes
  // module (`WebGPUSceneRenderer3DTilePasses.ts`, Batch 137). Other
  // internal callers still call as `this._resumeScenePass(...)` —
  // visibility flip only.
  public _resumeScenePass(context: WebGPUContext): void {
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    if (!colorTarget || !context._currentCommandEncoder) {
      // No scene FB yet, or no encoder — fall back to the canvas pass.
      context.resumeDefaultRenderPass?.();
      return;
    }
    // C10-03 — open the resumed scene segment WITHOUT an eager color resolve
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
    // Slice 5c-B Batch 117 — append MRT slot-1 G-buffer attachment when
    // MRT mode is on. loadOp="load" preserves writes accumulated in the
    // pass that was just ended.
    const slot1 = buildMrtSlot1Attachment(this._scene, "load");
    if (slot1) {
      colorAttachments = [...colorAttachments, slot1];
    }
    // C9-07 — end via the context helper so the tracked pass target is
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
    // Audit C.11 (Batch 132) -- use the per-frame cached viewport so
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
   * C10-03-MSAA-BOUNDARY-BYTES — demand-driven "resolve-on-consume" for scene
   * COLOR. The scene-FB segments open WITHOUT a `resolveTarget`
   * (`getColorAttachments({ resolve:false })`), so the multisampled color is no
   * longer resolved eagerly at every `pass.end()` (~10 resolves/frame → the
   * S4-1 waste). Instead every resolved-color consumer (refraction capture,
   * OIT composite, invert-classification composite, bounding-volume debug, and
   * ALWAYS the pre-post-process blit) calls this immediately before reading
   * `colorTarget.getColorTextureView(0)` / `context._sceneColorView`.
   *
   * Idempotent + conservative:
   * - `_msaaSamples <= 1` → no resolve target exists (I5), the resolve view IS
   *   the attachment view, so this is inert and the MSAA-off path is
   *   byte-identical by construction.
   * - `_sceneColorResolvePending === false` → nothing has drawn to the scene FB
   *   since the last resolve; skip (this is what keeps a write-consumer's
   *   output — e.g. the fallback invert composite that draws into the
   *   single-sample resolve view — from being stomped by a redundant re-resolve
   *   before post-process, since `resumeDefaultRenderPass` opens the CANVAS
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

  // Public underscore: shared with the frustum-loop slice (Batch 140).
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
    // Previously the trigger was `label === "Scene Framebuffer Render Pass"`,
    // but earlier per-frustum work (globe-depth copy, 3D-tile depth update,
    // translucent depth capture) routes through `endCurrentRenderPass()` +
    // `resumeDefaultRenderPass()`, which leaves the active pass label as
    // "Scene Main Render Pass" (the canvas swap-chain pass). This made the
    // clear silently fall through to the canvas-side `context.clear` and
    // every subsequent draw — including the next frustum's globe pass —
    // landed on the canvas instead of the scene framebuffer, leaving the
    // FB empty and producing an all-black post-process blit. The trigger
    // is now scene-framebuffer-presence-based: if we have a color target
    // and an encoder, always open a scene-FB pass.
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    if (colorTarget && context._currentCommandEncoder) {
      // C10-03 — depth-clear re-open preserves accumulated color
      // (loadOp:"load") but must NOT eagerly resolve it; scene color resolves
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
        // Slice 5c-B Batch 117 — append MRT slot-1 G-buffer attachment
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
        // Audit C.11 (Batch 132) -- per-frame viewport.
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

  // --- Globe pass (with GlobeDepth integration) ---

  // Public underscore: shared with the frustum-loop slice (Batch 140).
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

    // Translucency dispatch + render-bundle attempt + fallback
    // executeBatch were extracted to `WebGPUSceneRendererGlobePass.ts`
    // in Batch 135. The diag prelude above (validation error scope,
    // render-pass logging, command-count throttle) stays inline because
    // the 5 diag fields it touches are pragma-stripped class members,
    // and `context.uniformState?.updatePass(Pass.GLOBE)` is the
    // load-bearing tail of the prelude that has to run before dispatch.
    executeGlobeDispatch(commands, count, config);
  }

  // --- 3D Tiles passes ---

  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _execute3DTilePasses(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
    onAfterTileMainPass?: () => void,
  ): void {
    // Body extracted to `WebGPUSceneRenderer3DTilePasses.ts` in Batch 137.
    // The wrapper stays so `executeCommands` keeps calling it as
    // `this._execute3DTilePasses(frustumCommands, config, onAfterTileMainPass)`.
    execute3DTilePasses(this, frustumCommands, config, onAfterTileMainPass);
  }

  // --- Opaque pass ---

  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _executeOpaquePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    // Batch 226 — cache for stats diagnostics (see
    // `_buildShadowCascadeCullStats`). Updated every frame so the
    // diagnostic surface always reflects the current frame's
    // context state.
    this._lastContext = context as WebGPUContext;
    const commands = frustumCommands.commands[Pass.OPAQUE];
    const count: number = frustumCommands.indices[Pass.OPAQUE];
    if (count === 0) {
      return;
    }
    context.uniformState?.updatePass(Pass.OPAQUE);

    // NEW-GPU-CULLER-CONSUME (Batch 209) + NEW-HIZ-CONSUME (Batch 210)
    // — threshold-gated GPU culling for very large opaque batches.
    // CPU culling already runs upstream in `Scene.updateFrameState`,
    // but at the 10K-instance scale the GPU-side fine-grained re-test
    // (frustum from gpuCuller, occlusion from HiZ) still cuts draw-
    // call dispatch. The 1-frame readback latency is acceptable at
    // high densities — visibility doesn't flip frame-to-frame fast
    // enough for popping to be visible. Below the gpuCuller threshold
    // (count < 256) every helper returns the input array untouched,
    // so this path is a no-op for typical scenes.
    //
    // **Batch 212 audit** — pick passes (`config.picking`) skip ALL
    // GPU cull / HiZ filtering. Pick must test every command the CPU
    // pass produced, including ones GPU culling would mark as
    // occluded — users can pick objects that are visually behind
    // others (e.g., through transparent overlays). Mismatching the
    // filter sets between render and pick produces ghost picks where
    // a visually-clicked pixel maps to the wrong (or no) feature.
    let activeCommands = commands as CesiumAnyDrawCommand[];
    let activeCount = count;
    // Batch 223 (B219-N1 + B219-N2 audit fixes) — frame-start
    // bookkeeping that runs UNCONDITIONALLY at the top of every
    // opaque pass. Two purposes:
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

    // Batch 219 (B214-N1 + B215-N1) — per-frustum gate state with
    // hysteresis. Each frustum tracks its own previous-frame state so
    // a 3-frustum scene with (2400, 500, 800) commands no longer
    // collapses through a single shared `_*Active` flag (which would
    // flip T→F→F within one frame, defeating the purpose of
    // hysteresis).
    //
    // `Scene.gpuCullingHint = 'never'` short-circuits all three gates
    // to false — closes B215-N1 ("never" was previously stored but
    // never read).
    //
    // Picking always bypasses (Batch 212 audit) — we don't update
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
        // Wave-0 P0 fix — gpuCullCommands records a `beginComputePass`
        // ("frustum-N Compute Pass") on the frame encoder; like HiZ/sort it
        // must NOT run while the scene render pass is open (invalidates the
        // whole command buffer → dense-scene black screen). It is
        // async-latency (consumes the PRIOR frame's readback synchronously,
        // line ~3308), so simply bracketing the compute dispatch is correct;
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
    // filtered list. Per-frustum gate (Batch 219). No-op also when
    // picking or when no readback is available yet.
    if (hiZActive) {
      const occluded = this._filterByHiZVisibility(activeCommands, activeCount);
      if (occluded !== activeCommands) {
        activeCommands = occluded;
        activeCount = occluded.length;
      }
    }

    // NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — apply
    // the GPU-produced front-to-back order to the opaque list. Only when
    // no cull/HiZ filtering dropped commands this frame (`activeCount ===
    // count`): the permutation indexes the ORIGINAL raw `commands` array,
    // so it can only be applied when the executed set is still the full
    // raw set (just possibly copied by the cull/HiZ passes, which
    // preserve order). When filtering dropped commands, cull/HiZ take
    // precedence and the CPU order stands (opaque order is a pure early-Z
    // optimization, so this is correct either way). FAR-003 defaults the
    // consumer to "never"; "auto" remains an explicit threshold probe. See
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
    // **Batch 212 audit** — skip dispatch on pick passes; the pick
    // depth target is a separate framebuffer and would feed
    // misleading visibility into the next render frame's HiZ
    // filtering. Pick passes also typically run on demand (mouse
    // events) — dispatching there wastes GPU time on a buffer that
    // never feeds a render frame.
    // HiZ dispatch for next frame — per-frustum gate (Batch 219) so
    // the producer side respects the same hysteresis as the consumer.
    // Wave-0 P0 fix — both HiZ and GPU-sort-key dispatches record
    // `beginComputePass` on the frame encoder. Doing that while the scene
    // framebuffer render pass is still open is a "CommandEncoder is locked
    // while RenderPassEncoder is open" validation error that invalidates the
    // ENTIRE command buffer → every dense (>=2400 opaque-cmd) WebGPU scene
    // black-screened. Bracket the compute dispatches with
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

  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _executeTranslucentPass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    // Body extracted to `WebGPUSceneRendererTranslucentPass.ts` in
    // Batch 136. The wrapper stays so `executeCommands` keeps calling
    // it as `this._executeTranslucentPass(frustumCommands, config)`.
    // The extracted function reaches back via the `TranslucentPassHost`
    // interface for `_oit` (read) and `_deferredOITSplats` (read +
    // null on consume).
    executeTranslucentPass(this, frustumCommands, config);
  }

  // --- Overlay pass ---

  // Public underscore: shared with the post-frustum chain slice (Batch 141).
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

  // Public underscore: shared with the frustum-loop slice (Batch 140).
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
   * These run after all geometry passes but before post-processing.
   * Each effect reads from the scene color/depth and composites its result.
   *
   * Order: Procedural Clouds → SSR → Weather Particles
   * - Clouds are behind geometry (atmosphere-level)
   * - SSR modifies surface reflections
   * - Weather is in front (camera-relative particles)
   */
  // Public underscore: shared with the post-frustum chain slice (Batch 141).
  public _executeEnvironmentalEffects(config: WebGPURenderFrameConfig): void {
    // Body extracted to `WebGPUSceneRendererEnvironmentalEffects.ts` in
    // Batch 134. The wrapper stays so `executeCommands` keeps calling
    // it as `this._executeEnvironmentalEffects(config)`. The extracted
    // function takes zero `this.*` deps (verified pre-extraction by
    // grep) so it's a free function — no host interface needed.
    executeEnvironmentalEffects(config);
  }

  /**
   * Phase 8a Slice 2 (Batch 85) — screen-space normal reconstruction
   * from scene depth into `view.gBufferFramebuffer`.
   *
   * Originally gated on `frameState.useDeferredLighting === true` and
   * ran AFTER the scene render pass, OVERWRITING any MRT writes made
   * during the pass. With Slice 5c-B Phases 1-2 (Batches 105-119) the
   * G-buffer is now populated by per-shader `@location(1)` emits from
   * converted primitives (globe, ellipsoid, glTF Model). For pixels
   * those emitters cover, the MRT writes are the source of truth.
   *
   * Slice 5c-B Batch 120 (NEW-GBUFFER-MRT-COMPUTE-PRODUCER-RETIRE):
   * skip the compute producer entirely when MRT mode is on AND the
   * G-buffer is allocated. Three implications:
   *
   *   - Pixels covered by an MRT-emitting pipeline (globe + ellipsoid +
   *     Model + future B3DM/Polygon) keep their real per-fragment data.
   *   - Pixels covered by Phase 1 placeholder pipelines (writeMask:0
   *     on slot 1: sky, billboards, labels, points, etc.) keep the
   *     loadOp=clear sentinel (0,0,0,1).
   *   - The AO / SSR / contact-shadow consumers already check
   *     `length(xyz) < 0.01` and fall back to their own depth-derived
   *     path for sentinel pixels — no consumer change needed.
   *
   * Runs AFTER `_executeEnvironmentalEffects` (which has closed the
   * scene render pass and resolved depth) and BEFORE the
   * InvertClassification composite + post-processing.
   */
  public _executeGBufferProducer(config: WebGPURenderFrameConfig): void {
    const frameState = config.scene.frameState as
      { useDeferredLighting?: boolean } | undefined;
    if (!frameState || frameState.useDeferredLighting !== true) {
      return;
    }
    // Slice 5c-B Batch 120 — skip the compute producer when MRT mode
    // is on. Converted primitives' @location(1) emits are the source
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
    // Phase 8a Slice 2d (Batch 90) — close any render pass that's
    // still open on the shared command encoder before we start a
    // compute pass. WebGPU forbids `beginComputePass` while a render
    // pass is recording on the same encoder. The post-frustum chain
    // calls us right after `_executeEnvironmentalEffects`, which may
    // leave the scene render pass open if it didn't enter
    // post-process mode yet.
    context.endCurrentRenderPass?.();
    const encoder = context._currentCommandEncoder;
    const device = context.device;
    // Phase 8a Slice 2c (Batch 89) — fixed depth-source bug. Previously
    // read `context.depthOnlyTextureView` which is a separate depth
    // attachment unused by the scene render. The actual scene depth
    // lives on `_sceneFramebuffer.depthSampleableView` (same source the
    // depth-as-color debug overlay uses). With the wrong texture bound,
    // every sample returned 0 → producer's `depth >= 0.99999` check
    // failed (0 < 0.99999) but the unproject math produced garbage
    // positions that all ended up at the same point, making the cross
    // product near-zero → high-gradient sentinel branch for every
    // pixel. Net result: G-buffer was all-sentinel, overlay showed
    // pure magenta.
    const depthView = this._sceneFramebuffer?.depthSampleableView ?? null;
    if (!encoder || !device || !depthView) {
      // Phase 8a Slice 2c (Batch 89) — surface the silent-bail case.
      // Most common reason: MSAA is on (default 4) so the depth
      // attachment is multisampled and `depthSampleableView` can't be
      // bound to the producer's single-sample `texture_depth_2d`
      // binding. Slice 2d will add a multisampled-depth code path
      // (`texture_depth_multisampled_2d` + `textureLoad(.., 0)`); for
      // now, users must call `scene.msaaSamples = 1` BEFORE viewer
      // construction to enable the producer.
      if (!this._gbufferProducerWarnedNoDepth) {
        this._gbufferProducerWarnedNoDepth = true;
        //>>includeStart('debug', pragmas.debug);
        // eslint-disable-next-line no-console
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

    // Phase 8a Slice 2d (Batch 90) — pass the scene's sample count so
    // the dispatcher picks the multisampled-depth pipeline when MSAA
    // is on (Cesium default is 4). Read from `scene.msaaSamples`
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

  // C-R8-EDGE-COMPOSITE-PRUNE (Batch 50) — `_runEdgeComposite()` was
  // removed. The model FS inline edge stage (Batch 48) is the
  // authoritative consumer; primitive shaders don't currently emit
  // edges. If a future emitter adds non-model edge commands, restore
  // the post-process composite OR ride C-R8-EDGE-INLINE-PRIMITIVES to
  // extend the inline stage to that shader family.

  // Migration Session 5 (Batch 85) — `_runTranslucentTileClassification-
  // Composite` removed. The depth-sample classifier draws directly into
  // scene color, so there's no accumulation target to composite back.

  // --- InvertClassification composite ---

  /**
   * C-R8-INVERT-CLASS-FBO-REDIRECT (Batch 39) — Pairs with the FBO
   * redirect in {@link _execute3DTilePasses}. When the redirect is
   * active, 3D-tile pixels go into `InvertClassification.classifiedTexture`
   * instead of scene color; this method composites them back onto the
   * resolved scene color view so the frame has tiles in the final image.
   *
   * Runs AFTER the main scene render pass ends, which is required
   * because the composite targets the SINGLE-SAMPLE resolved view
   * (`colorTarget.getColorTextureView(0)`) and the MSAA attachment
   * only resolves on pass end. Wrapped in end/resume so post-process
   * continues to see the scene pass active on resume.
   *
   * No-op when InvertClassification is disabled or not ready — the
   * tile pass went to the default path and scene color already has
   * the tiles in place.
   */
  // Public underscore: shared with the post-frustum chain slice (Batch 141).
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

    // AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER —
    // resolved). Each classifier renderer (Ground primitive, ground polyline,
    // Vector3DTile primitive, Vector3DTile clamped polylines) now emits a
    // dedicated IGNORE_SHOW stencil-write command alongside its color
    // command for 3D-Tile classification. The dispatcher in
    // `WebGPUSceneRenderer3DTilePasses.ts` runs those commands inside the
    // invert FBO and flips `invertHasStencilData = true` once the
    // CLASSIFICATION_IGNORE_SHOW pass ran with > 0 commands, which makes
    // the stencil-gated composite branch in `runInvertCompositeFromTracker`
    // active. The previous "every-pixel-tinted" warning is now obsolete.

    // End the current scene pass (required regardless of MSAA so the
    // composite / read can run outside a render pass), then — C10-03 —
    // resolve MSAA color into the single-sample resolve view on demand (the
    // eager per-segment resolve was elided). Both the stencil-gated path
    // (writes MSAA + auto-resolves at its own pass end) and the fallback path
    // (writes the resolved view directly) require the resolved view to already
    // hold the accumulated scene color. Ensure is inert under MSAA-off (I5).
    context.endCurrentRenderPass?.();
    this._ensureSceneColorResolved(context);

    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    const resolveView: GPUTextureView | undefined =
      colorTarget?.getColorTextureView?.(0);

    // C-R8-INVERT-CLASS-STENCIL (Batch 40) — when the stencil-ready
    // flag is set (CLASSIFICATION_IGNORE_SHOW ran and wrote stencil
    // bits into the invert FBO), pass the MSAA scene-color attachment
    // view so the composite can run at MSAA sample count alongside
    // the MSAA invert depth-stencil. Otherwise fall back to the
    // single-sample single-pass composite (Batch 39 behavior).
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

  // --- KHR_materials_transmission refraction capture (Batch 107) ---

  /**
   * C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — captures opaque-only
   * scene color into the scene-FB refraction target so transmissive
   * Model primitives drawn in the TRANSLUCENT pass can sample the
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
   * Multi-frustum scenes capture ONCE PER FRUSTUM — each frustum's
   * transmissive draws see that frustum's opaque backdrop. The
   * refraction texture is overwritten between frustums so the
   * latest capture wins; for transmission, that's correct because
   * a glass surface in frustum N should refract content drawn up
   * to frustum N (the per-frustum opaque writes accumulate into
   * the same scene color across frustums in the WebGPU pipeline).
   */
  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _captureRefractionScene(config: WebGPURenderFrameConfig): void {
    const { context } = config;
    if (!context._sceneHasTransmission || !this._sceneFramebuffer) {
      return;
    }
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    // End the scene pass (required for the copy), then — C10-03 — resolve
    // MSAA color on demand: the refraction copy source is the resolved color
    // texture (`colorTarget.getColorTexture()`), which the eager per-segment
    // resolve used to keep current. Ensure is inert under MSAA-off (I5).
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

  // --- TAA velocity pass (Slice 2e, Batch 106) ---

  /**
   * TAA Slice 2e (Batch 106) — per-pixel motion-vector pass for models.
   *
   * Walks the frustum command lists, collects every command carrying a
   * `velocityCommand` slot (attached by `WebGPUModelRenderer` when
   * `frameState.taaEnabled === true` and the primitive is opaque/mask),
   * and dispatches them into a dedicated `rg16float` render pass that
   * shares the scene-FB depth attachment in read-only mode. The
   * resulting velocity texture is consumed by the TAA effect (Batch
   * 104) at `@binding(5) motionTex` — TAA prefers per-pixel velocity
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
   * — translucent velocity needs OIT-style accumulation, deferred.
   *
   * Free for static scenes: when no command carries a velocityCommand
   * (TAA off, or no models in view), the function early-exits before
   * any GPU work is queued.
   */
  // Public underscore: shared with the post-frustum chain slice (Batch 141).
  /**
   * Slice 5d Batch 151 — Forward+ clustered lighting per-frame hook.
   * Walks scene.lights + every visible model.lightsFromGltf, hands
   * the world-space list to the WebGPUClusteredLightingDispatcher
   * along with the current frame's view + projection matrices. The
   * dispatcher transforms positions/directions to eye-space, packs
   * into the WGSL ClusteredLight layout, and records both compute
   * passes into the active command encoder.
   *
   * Called early in executeCommands (after _ensureResources, before
   * any consumer draw) so the storage buffers are ready when Model
   * PBR / Lit Mat consumers (Batch 153+, merged into group 3 effects)
   * read them.
   *
   * Inert when scene.clusteredLightingEnabled === false OR zero
   * lights are configured — the dispatcher returns activeLightCount=0
   * and consumer FS chunks gate on that value to skip the cluster
   * read entirely.
   *
   * @private
   */
  private _dispatchClusteredLighting(config: WebGPURenderFrameConfig): void {
    // Batch 310 — logic extracted verbatim to
    // WebGPUSceneRendererClusteredLighting.ts (god-object decomposition
    // slice). `this` satisfies the minimal `ClusteredLightingHost`
    // surface (the dispatcher field + viewport dims).
    dispatchClusteredLighting(this, config);
  }

  /**
   * Public accessor for the clustered-lighting dispatcher's GPU
   * buffers. Consumer pipelines (Model PBR + Lit Mat shaders, when
   * wired in Batch 153+ via group 3 effects merge) call this to obtain
   * handles for their bind groups.
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
    // Audit C.11 (Batch 132) -- per-frame viewport rather than full
    // canvas, so the velocity pass writes only into the requested
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

  // Public underscore: shared with the post-frustum chain slice (Batch 141).
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

    // Phase 8a Slice 2c (Batch 89) — G-buffer normal visualization.
    // Replaces the production post-process chain with a fullscreen blit
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
      // TAA Slice 2d (Batch 104) — forward the per-pixel velocity
      // texture view (when allocated). Currently null when no
      // velocity pass populated it; the TAA effect binds its 1×1
      // zero placeholder and the shader falls back to depth
      // reprojection. The follow-up that wires model FS @location(1)
      // velocity output will populate this view via
      // `sceneFramebuffer.ensureVelocityTexture(...)`.
      const motionView = this._sceneFramebuffer?.velocityView ?? null;
      // Session 65 Batch 22 — orbit polish §13.1. Bloom intensity
      // fades from 1.0 at ground to 0.0 above 1 Earth radius
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
      // Session 65 Batch 39 — orbit polish §13.x. Auto-exposure altitude
      // gate paired with bloom. The compute reduction still runs (cheap)
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
      // Phase 8a Slice 4 (Batch 87) — when the G-buffer producer ran
      // this frame (`scene.deferredLighting === true`), forward the
      // normal texture view so the AO effect (and Slice 5+ consumers)
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
      // C9-07 / FAR-405-C0 — the PP pipeline wrote `targetView` (the
      // canvas) through raw `encoder.beginRenderPass` calls the context
      // cannot observe. Mark the canvas written so no later default-pass
      // open clears the blit and the endFrame present fallback stays off.
      context.markCanvasContentWritten();
    } else {
      context.log(
        "warn",
        `[PostProcess] MISSING: encoder=${!!encoder} sourceView=${!!sourceView} targetView=${!!targetView}`,
      );
    }

    // C9-07 / FAR-405-C0 — the unconditional canvas-pass resume that used
    // to sit here (empty pass #2 on the default route) is gone. Downstream
    // consumers self-manage: the snapshot copy ends passes, env effects
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
    // Sampleable depth view is only available when the scene framebuffer
    // is single-sample (no MSAA) — see WebGPURenderTarget.depthSamplable
    // contract. When MSAA is on, the depth-as-color overlay can't run;
    // log once and skip.
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
    // log-normalized modes 0-2 collapse to one shade (C-R9 tooling).
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
    // C9-07 — the overlay wrote the canvas via its own pass; without the
    // marker the resume below (a first open) would clear the output.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * Phase 8a Slice 2c (Batch 89) — runs the {@link WebGPUDebugGBufferOverlay}
   * in place of the production post-process chain. Samples
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
        // C9-07 — the magenta sentinel clear wrote the canvas.
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
    // C9-07 — the overlay wrote the canvas via its own pass.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * Tier 2 debug — runs the {@link WebGPUDebugFrustumOverlay} in place of
   * the production post-process chain. Samples the scene framebuffer's
   * color + sampleable depth view, tints per pixel by frustum membership
   * (mode 0) or depth-banded palette (mode 1), and blits to the canvas.
   *
   * Needs the same single-sample (non-MSAA) scene framebuffer contract as
   * the depth overlay — depth can only be sampled when MSAA is off.
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
    // C9-07 — the overlay wrote the canvas via its own pass.
    context.markCanvasContentWritten();

    context.resumeDefaultRenderPass?.();
  }

  /**
   * NEW-GEOJSON-WEBGPU-BV-DEBUG-DRAW-PASS — draw a red wireframe of the
   * bounding volume of every command flagged `debugShowBoundingVolume`.
   *
   * WebGPU equivalent of `Scene/SceneDebug.js#debugShowBoundingVolume`. The
   * flag plumbs through `GeoJsonPrimitive` + all three `Buffer*`
   * `WebGPUDrawCommand`s (Batch 583); this consumes it.
   *
   * DEFAULT-OFF / BYTE-IDENTICAL: collects flagged commands from
   * `frameState.commandList`; when none carry the flag (the default) it
   * returns before opening any pass, so an unflagged frame is unchanged.
   *
   * Runs from the post-frustum chain, after the main scene pass has closed
   * + resolved and before `_runPostProcessing` samples the scene-color
   * texture — so the wireframe reaches the canvas through the post-process
   * blit. Draws into the RESOLVED single-sample color view with
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

    // C10-03 — the wireframe draws INTO the resolved color view; resolve the
    // accumulated scene color on demand first (the eager per-segment resolve
    // was elided). Only reached when a command is flagged, so unflagged frames
    // stay byte-identical. Inert under MSAA-off (I5).
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

  // Public underscore: shared with the frustum-loop slice (Batch 140).
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

  // NEW-DERIVEDCOMMAND-VARIANT-FACTORY (Batch 248) — the old
  // `createDerivedCommand(baseCommand, type, context)` static (a zero-caller
  // wrapper over the pre-rewrite flag-stamping factories) was removed when
  // `WebGPUDerivedCommand` became the real descriptor-variant factory.
  // Renderers call `WebGPUDerivedCommand.deriveDescriptor` /
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
    // C-R12 (Batch 33) — release the context's invalidation subscriber
    // so it doesn't outlive this SceneRenderer and keep a dead closure
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

  // Batch 214 — threshold hysteresis. Each dispatcher uses two
  // thresholds (HI / LO) and a per-dispatcher `_*Active` state flag.
  // Activation requires count >= HI; deactivation requires count <
  // LO. Between LO and HI the previous state holds. This prevents
  // dispatch flap when the command count oscillates around a single
  // threshold (typical with LOD / tile streaming at the boundary).
  // The previous single thresholds are kept as `_THRESHOLD` aliases
  // so external diagnostics that read them keep working.
  /** Minimum command count before GPU culling is worth the overhead */
  private static readonly GPU_CULL_THRESHOLD = 256;
  private static readonly GPU_CULL_THRESHOLD_HI = 384;
  private static readonly GPU_CULL_THRESHOLD_LO = 192;
  // B214-N1 (Batch 219) — per-frustum gate state. Each frustum's
  // hysteresis evolves from its own previous-frame state instead of
  // racing with sibling frustums. Map keyed by frustum index. Stays
  // small (typical 1-4 entries).
  // B216-N2 — translucent path has its OWN gate based on translucent
  // command count, not opaque count. A particle-heavy scene with 50
  // opaque + 5000 translucent commands now activates translucent
  // GPU cull instead of staying off because opaque was below HI.
  private _gpuCullActiveByFrustum: Map<number, boolean> = new Map();
  private _gpuCullTranslucentActiveByFrustum: Map<number, boolean> = new Map();
  // Batch 217 — per-frame effectiveness counters. Cumulative
  // dispatch count + last-frame totals (sum across frustums).
  // B217-N1/N2 fix (Batch 219) — `_lastFrameInput`/`_lastFrameFiltered`
  // accumulate across frustums within a frame so multi-frustum scenes
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
   *    Batch 209 added this so opaque-pass callers can pass the
   *    pre-sized `frustumCommands.commands[OPAQUE]` array directly
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
    // Batch 214 — the activation gate (hysteresis) is enforced by
    // the caller. We still guard against zero/negative counts and
    // missing inputs but the threshold check itself moved upstream.
    if (!commands || count <= 0) {
      return commands;
    }

    // NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — pick the per-
    // frustum culler instance so multiple frustums in the same frame
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

    // Wave-0 P0 fix — skip re-dispatch + readback for this frustum while its
    // prior readback is still mapping. `prepareReadback` copies into the
    // readback staging buffer; doing that while a prior `readResults`
    // mapAsync is still pending raises "[Buffer] used in submit while
    // mapped" and invalidates the entire command buffer (dense-scene black
    // screen). The filter below falls through to the prior frame's cached
    // results — 1-frame-staler visibility is imperceptible at the densities
    // this gate activates. Mirrors the HiZ `_hiZReadbackInFlight` guard.
    if (!this._gpuCullReadbackInFlight.has(fIdx)) {
      culler.dispatch(encoder, count, 0 /* CullMode.VISIBILITY */);
      this._gpuCullDispatchCount++;

      // Async readback — results available next frame, keyed per-
      // frustum (Batch 220) so each frustum's filter consumes its own
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
    // pooled (Batch 213) — the call site reads `filtered.length`
    // synchronously inside `executeBatch`, never retains the ref.
    const prev = this._lastCullResultsByFrustum.get(fIdx);
    if (prev && prev.visibilityFlags && prev.objectCount === count) {
      const filtered = this._gpuCullFilterPool;
      filtered.length = 0;
      const flags = prev.visibilityFlags;
      for (let i = 0; i < count; i++) {
        if (flags[i] === 1) filtered.push(commands[i]);
      }
      // B217-N1 (Batch 219) + B219-N2 (Batch 223) — accumulate across
      // frustums in the same frame. Reset is done unconditionally at
      // the top of `_executeOpaquePass` (frustum 0 entry) so this
      // path no longer needs to gate on a frustum-tick check.
      this._gpuCullLastInput += count;
      this._gpuCullLastFiltered += filtered.length;
      return filtered;
    }

    return commands;
  }

  /**
   * Batch 216 — gate-controlled translucent-pass GPU cull. Called
   * from the extracted translucent-pass module via the host
   * interface. Internally consults `_gpuCullActive` (the same gate
   * that drives the opaque path's culling) so on/off behavior is
   * coordinated. Skipped on pick.
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
    // B216-N2 (Batch 219) — translucent gate is independent of the
    // opaque gate. Activates based on TRANSLUCENT command count, so a
    // particle-heavy scene with 50 opaque + 5000 translucent commands
    // correctly fires the translucent cull even though the opaque
    // gate stayed off. Per-frustum hysteresis (B214-N1).
    // FAR-003: translucent culling is more hazardous than opaque culling
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

  // ─── Translucent-pass GPU cull (Batch 216) ──────────────────────────────

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

    // B216-N1 (Batch 218 audit fix) — use the dedicated translucent
    // culler instance so this pass's `prepareReadback` doesn't
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
      // B217-N1/N2 (Batch 219) + B219-N2 (Batch 223) — translucent
      // stats accumulate across frustums separately from opaque.
      // Reset moved to `_executeOpaquePass` frustum-0 entry.
      this._gpuCullLastTranslucentInput += count;
      this._gpuCullLastTranslucentFiltered += filtered.length;
      return filtered;
    }
    return commands;
  }

  // ─── Threshold hysteresis helper (Batch 214) ───────────────────────────

  /**
   * Update an activation gate with hysteresis. Returns the new
   * active state and stores it on the dispatcher. Call once per
   * frame per dispatcher with the current command count.
   *
   *   - active && count <  LO  →  deactivate
   *   - !active && count >= HI →  activate
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

  // ─── HiZ occlusion (NEW-HIZ-CONSUME, Batch 210) ─────────────────────────

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
    // Batch 214 — gate enforcement is upstream (`_hiZActive`).
    if (count <= 0) return commands;
    const prev = this._lastHiZVisibility;
    if (!prev || prev.count !== count) return commands;
    // Pooled output (Batch 213) — same lifetime contract as
    // `gpuCullCommands`: caller consumes synchronously inside
    // `executeBatch`, doesn't retain the ref across frames.
    const flags = prev.flags;
    const filtered = this._hiZFilterPool;
    filtered.length = 0;
    for (let i = 0; i < count; i++) {
      // C12-37 — preserve explicit non-occludable commands (celestial bodies)
      // conservatively. Keep them in the producer arrays so result count and
      // index identity do not drift; only override the consumer decision.
      if (commands[i].occlude === false || flags[i] === 1) {
        filtered.push(commands[i]);
      }
    }
    // B217-N1 (Batch 219) + B219-N2 (Batch 223) — accumulate across
    // frustums. Reset moved to `_executeOpaquePass` frustum-0 entry.
    // Stats reflect what the test WOULD drop even when consumption is off,
    // so CesiumDebug.highDensityCull surfaces the (currently inert) hit ratio.
    this._hiZLastInput += count;
    this._hiZLastFiltered += filtered.length;
    // FAR-003 — gate the actual command drop. Default OFF until result identity
    // includes its producing frustum/frame/command generation. The toggle
    // remains for A/B regression probes (`CesiumDebug.hiZConsume`).
    if (!this._hiZConsumeEnabled) return commands;
    this._hiZConsumedThisFrame = true;
    return filtered;
  }

  /**
   * NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) —
   * consumer for the GPU-produced front-to-back sort order. Applies the
   * previous frame's bitonic-sort permutation to the RAW opaque command
   * list, producing a reordered array that is a strict permutation of
   * the same commands (nothing added or dropped).
   *
   * The readback `indices` hold SOA slots and `compactedToOriginal` maps each
   * back to its original command index. Canonical-distance dispatches are
   * all-or-nothing, making this map identity and `skipped` empty, but the
   * tagged reconstruction protocol remains defensive against old/in-flight
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
      // Off-gate: byte-identical to the pre-heuristic default — never
      // reorder. Explicit "auto" + "always" fall through and apply; this
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
   * NEW-GPU-SORT-PIPELINE Phase 3 — debug snapshot of the last GPU sort
   * dispatch + readback, for the acceptance probe to verify the GPU
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
    // Batch 214 — gate enforcement is upstream (`_hiZActive`).
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
    // FORK-41 ROOT CAUSE (C2-21) — the Hi-Z pyramid MUST read the depth the
    // scene opaque pass actually writes. The WebGPU renderer renders into
    // `_sceneFramebuffer` (post-process is mandatory), so the opaque depth
    // lands in the scene framebuffer's depth attachment, NOT the context's
    // default `_depthTexture`. Reading `context.depthOnlyTextureView` (the
    // default depth) gave an UNWRITTEN, clear=1.0 texture → the pyramid was
    // all-FAR → `sphereNearZ > maxHiZ` never held → hitRatio pinned to 0
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

    // B210-N2 (Batch 213) — prefer the per-frustum near/far that the
    // caller forwarded from `frustumCommands` over the uniformState
    // values, which `Scene.executeCommands` overwrites after the
    // last frustum iteration. Tighter bounds = more aggressive
    // occlusion test. Fallback chain: per-frustum → uniformState →
    // loose default. The loose default still produces correct
    // visibility (just less aggressive culling).
    // FORK-41 (Batch 291) — log-depth reconciliation. The Hi-Z pyramid is
    // built from the depth attachment, which the renderer-wide log-depth
    // buffer writes in log space. Forward `useLogDepth` + the precomputed
    // czm_oneOverLog2FarDepthFromNearPlusOne so the occlusion-test WGSL
    // encodes the sphere's nearest depth into the SAME space. Without this
    // the comparison is linear-vs-log and collapses to all-visible
    // (hitRatio=0 — measured pre-fix). `nearPlane` here MUST be the frustum
    // near used by the depth write so the log encoding matches; we already
    // forward the per-frustum near above.
    const logDepthEnabled = us?.frameState?.useLogDepth === true;
    const nearPlane = frustumCommands?.near ?? us?.currentFrustumNear ?? 1.0;
    const farPlane = frustumCommands?.far ?? us?.currentFrustumFar ?? 1e9;
    // Derive the log-depth factor (czm_oneOverLog2FarDepthFromNearPlusOne)
    // from THIS frustum's near/far rather than reading the shared
    // uniformState scalar. `Scene.executeCommands` advances uniformState to
    // the last frustum after the split loop, so the cached scalar can be
    // stale relative to `frustumCommands` (the same B210-N2 reason the
    // near/far above prefer frustumCommands). `UniformState.updateFrustum`
    // computes exactly `1 / log2((far - near) + 1)`, so we match it here.
    let logDepthFactor = 0.0;
    if (logDepthEnabled && farPlane > nearPlane) {
      const log2Far = Math.log2(farPlane - nearPlane + 1.0);
      logDepthFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    }
    // FORK-41 (C2-21) — when the scene framebuffer is MSAA, `depthView` above
    // is the resolved r16float color view (a `texture_2d<f32>`), NOT a depth
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

    // B210-D1 (Batch 213) — pass the frame counter so per-frustum
    // dispatches in the same frame share one pyramid build.
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

  // ─── GPU sort keys (NEW-GPUSORTKEYS-CONSUME, Batch 211) ─────────────────

  /**
   * Threshold-gated GPU sort-key generation. Dispatched after the
   * opaque pass to overlap with rasterization. Phase 1 wire-in only —
   * the keys are generated but no GPU sort pipeline consumes them
   * yet (JS sort is still authoritative for command ordering).
   *
   * Returns true if a dispatch was issued, false otherwise (below
   * threshold, missing FR, no encoder, no camera state).
   */
  private _dispatchGPUSortKeys(
    context: WebGPUContext,
    commands: CesiumAnyDrawCommand[],
    count: number,
  ): boolean {
    // Batch 214 — gate enforcement is upstream (`_gpuSortActive`).
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
          // Batch 228 Phase 2 — sort + readback chain. Phase 3
          // (C4-GPU-SORT-PIPELINE-PHASE3) added the tag-paired ring.
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
    // Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — build the compaction map
    // alongside the SOA. The live GPU path now requires every command to
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

    // NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — chain
    // the bitonic sort + deferred-ring readback. The compaction map for
    // THIS dispatch is snapshotted and passed as the readback `tag` so
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
        // skipped list; the ring surfaces this decode on a LATER frame.
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
        // ring guarantees indices + tag come from the SAME dispatch.
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

  // ─── High-density cull diagnostic surface (Batch 217) ──────────────────

  /**
   * FAR-003 safety-policy snapshot. This deliberately reads only already-owned
   * renderer/context state: diagnostics must not trigger lazy feature-renderer,
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
        // Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) — consumer state.
        // `consumeMode` surfaces the explicit comparison policy;
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
   * NEW-SHADOW-CAST-GPU-CULL-PHASE-2 (Batch 226) — read the per-
   * cascade GPU cull stats from the CSM renderer's host fields and
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

  // ─── R-7a CPU pass profiler accessors ──────────────────────────────────

  /**
   * Toggle the CPU-side per-pass recording-cost profiler. Off by default
   * (zero overhead). Enable from the console via
   * `CesiumDebug.cpuPassCost(true)` to start collecting samples.
   */
  setCpuPassProfiling(enabled: boolean): void {
    if (enabled && !this._cpuPassProfiler.enabled) {
      this._cpuPassProfiler.reset();
    }
    this._cpuPassProfiler.setEnabled(enabled);
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
