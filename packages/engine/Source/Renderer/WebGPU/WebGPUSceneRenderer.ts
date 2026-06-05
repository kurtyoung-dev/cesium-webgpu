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
 *   - WebGPUDerivedCommand (depth-only, pick, shadow, HDR variants)
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

import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../../Renderer/Pass.js";
import mergeSort from "../../Core/mergeSort.js";
import {
  backToFront as _commandSorterBackToFront,
  backToFrontSplats as _commandSorterBackToFrontSplats,
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
import { WebGPUDepthPlane } from "./WebGPUDepthPlane.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { dispatchGBufferNormalsFromDepth } from "./WebGPUGBufferRenderer.js";
import type { GBufferComputeHost } from "./WebGPUGBufferRenderer.js";
import { WebGPUDebugDepthOverlay } from "./WebGPUDebugDepthOverlay.js";
import { WebGPUDebugGBufferOverlay } from "./WebGPUDebugGBufferOverlay.js";
import { WebGPUDebugFrustumOverlay } from "./WebGPUDebugFrustumOverlay.js";
import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";
import { WebGPUDerivedCommand } from "./WebGPUDerivedCommand.js";
import { executePickPass } from "./WebGPUSceneRendererPickPass.js";
import { executeEnvironmentalEffects } from "./WebGPUSceneRendererEnvironmentalEffects.js";
import { executeGlobeDispatch } from "./WebGPUSceneRendererGlobePass.js";
import { executeTranslucentPass } from "./WebGPUSceneRendererTranslucentPass.js";
import { execute3DTilePasses } from "./WebGPUSceneRenderer3DTilePasses.js";
import {
  setupSceneFramebufferRenderPass,
  buildMrtSlot1Attachment,
} from "./WebGPUSceneRendererPassRedirect.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import { resetPerFrameState } from "./WebGPUSceneRendererFrameReset.js";
import { executeFrustumLoop } from "./WebGPUSceneRendererFrustumLoop.js";
import { executePostFrustumChain } from "./WebGPUSceneRendererPostFrustumChain.js";
import { ensureResources } from "./WebGPUSceneRendererEnsureResources.js";
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
): CesiumAnyDrawCommand {
  const derived = command.derivedCommands;
  if (!derived) {
    return command;
  }

  const frameState = scene.frameState;
  let cmd: CesiumAnyDrawCommand = command;

  // Log depth applies to every pass — it's a depth-write variant, not a
  // color-path variant. Swap before every other gate so downstream reads
  // see the log-depth command's own `derivedCommands` chain (matching
  // SceneRenderer.executeCommand line 49-51).
  if (frameState.useLogDepth && derived.logDepth?.command) {
    cmd = derived.logDepth.command;
  }

  const passes = frameState.passes;
  const isPicking = isPickPass || passes.pick || passes.pickVoxel;
  const isDepth = passes.depth;

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
 * for WebGL-parity semantics: sortKey → sortPriority → eye-distance-squared.
 * The guard short-circuits when WebGPU commands lack a sphere (some OIT
 * auto-create paths), which WebGL doesn't produce but the WebGPU pipeline
 * occasionally does.
 */
function _backToFrontComparator(
  a: CesiumAnyDrawCommand,
  b: CesiumAnyDrawCommand,
  position: { x: number; y: number; z: number },
): number {
  const bvA = a?.boundingVolume;
  const bvB = b?.boundingVolume;
  if (!bvA || !bvB || !bvA.distanceSquaredTo || !bvB.distanceSquaredTo) {
    return 0;
  }
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
  const bvA = a?.boundingVolume;
  const bvB = b?.boundingVolume;
  if (!bvA?.center || !bvB?.center) {
    return 0;
  }
  return _commandSorterBackToFrontSplats(a, b, position);
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
  // Slice out the active range, sort it, copy back in place. mergeSort on the
  // live backing array would scramble pooled slots past `count`.
  const slice = commands.slice(0, count);
  mergeSort(slice, _backToFrontComparator, scene.camera.positionWC);
  for (let i = 0; i < count; i++) {
    commands[i] = slice[i];
  }
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
  const slice = commands.slice(0, count);
  mergeSort(slice, _backToFrontSplatsComparator, scene.camera.positionWC);
  for (let i = 0; i < count; i++) {
    commands[i] = slice[i];
  }
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
 * Activation is gated on `context.useIndirectDrawForTiles === true` so
 * the existing per-command path remains the default. The integration
 * point is here so a single feature flag flips it on for the whole 3D
 * Tile pass once a consumer (3D Tiles batched-table renderer, point
 * cloud collection) opts in.
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
        renderPass.setBindGroup(g, headBindGroups[g]);
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

// --------------- Main class ---------------

export class WebGPUSceneRenderer {
  private _isDestroyed: boolean = false;

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
  private _clusteredLightingDispatcher: WebGPUClusteredLightingDispatcher | null =
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
  // NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — per-frustum readback
  // slot for the opaque pass. Each frustum dispatches against its own
  // culler instance and stores its readback under its own frustum
  // index, so multi-frustum scenes (typical with log-depth) get full
  // GPU cull benefit instead of the previous "last-frustum-wins"
  // limitation.
  private _lastCullResultsByFrustum: Map<number, GPUCullResults> = new Map();
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
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    renderLayers: Uint32Array;
    sortPriorities: Uint32Array;
    materialSortIds: Uint32Array;
    capacity: number;
  } | null = null;
  private _sortKeysDispatches: number = 0;
  // NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — sorted-indices
  // readback state. `_lastSortedIndices` is the most-recent successful
  // readback; consumers reorder their command list using this on the
  // NEXT frame (1-frame latency, same model as cull readbacks).
  // `_sortReadbackInFlight` prevents stacking duplicate readback
  // requests when the previous frame's readback hasn't resolved yet.
  private _sortReadbackInFlight: boolean = false;
  private _lastSortedIndices: { indices: Uint32Array; count: number } | null =
    null;

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
    const scene = config.scene;
    const requestedSamples = Math.max(
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
      this._cpuPassProfiler.time("pick", () => this._executePickPass(config));
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
      console.warn(
        `[WebGPU:SceneRenderer] executeCommands called — ` +
          `numFrustums=${numFrustums} ` +
          `usePostProcess=${config.usePostProcess} ` +
          `_postProcess=${!!this._postProcess} ` +
          `picking=${config.picking} ` +
          `sceneFramebuffer=${!!this._sceneFramebuffer}`,
      );
    }
    //>>includeEnd('debug');

    if (numFrustums === 0) {
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
      console.warn(
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
    const perfManager = context.performanceManager;
    if (perfManager) {
      perfManager.beginFrame();
    }

    // R-7a CPU pass profiler — begin the per-frame bucket. No-op when
    // profiling is disabled.
    this._cpuPassProfiler.beginFrame();

    // Slice 5d Batch 151 — dispatch clustered lighting compute passes
    // once per frame, BEFORE any material draws. The dispatcher
    // internally checks scene.clusteredLightingEnabled + light count
    // and skips both compute passes when disabled or empty. Output
    // storage buffers + params uniform are bound by consumer
    // pipelines at @group(4) via the chunk in ClusteredLighting.wgsl
    // (Batch 149). Inert today — Batch 152+ wires actual consumers.
    this._dispatchClusteredLighting(config);

    // --- Shadow cast pass (once per frame, before multi-frustum rendering) ---
    // Renders scene from light's perspective into the shadow map depth texture.
    if (!config.picking) {
      this._cpuPassProfiler.time("shadow", () =>
        context.executeShadowMapCastCommands(scene),
      );
    }

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
    executeFrustumLoop(this, config, opaqueFrustumNearOffset);

    // Post-frustum chain (overlay + depth plane + env effects +
    // invert composite + velocity pass + post-process + frame
    // teardown) extracted to `WebGPUSceneRendererPostFrustumChain.ts`
    // in Batch 141 (Slice D — final slice of the executeCommands
    // decomposition).
    this._cpuPassProfiler.time("postFrustumChain", () =>
      executePostFrustumChain(
        this,
        context,
        config,
        frustumCommandsList,
        perfManager,
      ),
    );

    // R-7a CPU pass profiler — close out the per-frame bucket and roll
    // into the rolling window. No-op when profiling is disabled.
    this._cpuPassProfiler.endFrame();
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
    const frustum = camera.frustum;
    const frustumCache = frustum as unknown as {
      _near?: number;
      _far?: number;
    };
    if (frustum && frustum.near !== undefined) {
      // Use updateFrustum with modified near/far via the scratch approach
      // Store originals, update, then the uniform state captures the projection matrix
      const origNear = frustum.near;
      const origFar = frustum.far;
      frustum.near = near;
      frustum.far = far;
      // Force cached projection-matrix invalidation so the recomputed
      // projection picks up `Matrix4._depthRangeType = "webgpu"` (set by
      // Scene init for WebGPU contexts). Without this the cache stays in
      // the WebGL [-1, 1] clip-z form — fragments at clip_z < 0 (the
      // near half of every frustum) get clipped by WebGPU's [0, 1] clip
      // space. Most visible in SCENE2D where the linear ortho depth
      // puts half the visible range in the now-clipped near half;
      // perspective + log-depth in SCENE3D / COLUMBUS happens to push
      // most fragments to clip_z > 0 even with the WebGL projection so
      // those modes rendered acceptably. Set the sentinel-cached values
      // to NaN so any equality compare against the new `frustum.near`
      // fails and triggers a recompute. Touching the cached matrices to
      // undefined would also work but is harder to type cleanly.
      frustumCache._near = NaN;
      frustumCache._far = NaN;
      // Belt-and-suspenders: re-assert WebGPU depth-range type at every
      // frustum-uniform update. Other renderers (sky atmosphere, etc.)
      // may flip the global between iterations; doing this immediately
      // before the projection recompute guarantees each frustum's
      // projection matrix is consistent with the depth buffer.
      // Without this, transitioning back from SCENE2D/CV to SCENE3D
      // produced a half-globe split where one frustum band rendered
      // in WebGPU range and the other in WebGL range.
      Matrix4.setDepthRangeType("webgpu");
      uniformState.updateFrustum(frustum);
      // Restore — the frustum on the camera should stay unchanged for other systems
      frustum.near = origNear;
      frustum.far = origFar;
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
    const rawColor: GPURenderPassColorAttachment[] | undefined =
      colorTarget.getColorAttachments?.();
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
    if (context._currentRenderPassEncoder) {
      context._currentRenderPassEncoder.end();
      context._currentRenderPassEncoder = null;
    }
    const passDesc: GPURenderPassDescriptor = {
      label: "Scene Framebuffer Render Pass",
      colorAttachments,
      depthStencilAttachment,
    };
    context._currentRenderPassEncoder =
      context._currentCommandEncoder.beginRenderPass(passDesc);
    // Audit C.11 (Batch 132) -- use the per-frame cached viewport so
    // split-screen and sub-viewport callers see their requested
    // rectangle. Falls through to full canvas via the snapshot in
    // `executeCommands`.
    context._currentRenderPassEncoder.setViewport(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
      0,
      1,
    );
    context._currentRenderPassEncoder.setScissorRect(
      this._viewportX,
      this._viewportY,
      this._viewportWidth,
      this._viewportHeight,
    );
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
      const rawColor: GPURenderPassColorAttachment[] | undefined =
        colorTarget.getColorAttachments?.();
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
        context._currentRenderPassEncoder =
          context._currentCommandEncoder.beginRenderPass(passDesc);
        // Audit C.11 (Batch 132) -- per-frame viewport.
        context._currentRenderPassEncoder.setViewport(
          this._viewportX,
          this._viewportY,
          this._viewportWidth,
          this._viewportHeight,
          0,
          1,
        );
        context._currentRenderPassEncoder.setScissorRect(
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
      this._gpuCullLastTranslucentInput = 0;
      this._gpuCullLastTranslucentFiltered = 0;
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
    const hint = (scene as { gpuCullingHint?: "auto" | "always" | "never" })
      .gpuCullingHint;
    const forceOff = hint === "never";

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
      gpuSortActive = this._updateActivationGate(
        this._gpuSortActiveByFrustum.get(fIdx) ?? false,
        count,
        WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_HI,
        WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_LO,
      );
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
        const culled = this.gpuCullCommands(
          activeCommands,
          context as WebGPUContext,
          cv,
          activeCount,
        );
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
    if (hiZActive) {
      this._dispatchHiZForNextFrame(
        context as WebGPUContext,
        commands as CesiumAnyDrawCommand[],
        count,
        frustumCommands,
      );
    }

    // NEW-GPUSORTKEYS-CONSUME (Batch 211, Phase 1) — generate packed
    // sort keys on the GPU when the gate is active. The follow-up
    // GPU sort pipeline that consumes these keys is deferred
    // (NEW-GPU-SORT-PIPELINE in DEFERRED_WORK.md).
    if (gpuSortActive) {
      this._dispatchGPUSortKeys(
        context as WebGPUContext,
        commands as CesiumAnyDrawCommand[],
        count,
      );
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

  // Public underscore: shared with the frustum-loop slice (Batch 140).
  public _renderDepthPlane(config: WebGPURenderFrameConfig): void {
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
        this._depthPlane.execute(renderPass);
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
      | { useDeferredLighting?: boolean }
      | undefined;
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

    // End the current scene pass so the MSAA color attachment resolves
    // into the single-sample resolve view. Both the stencil-gated path
    // (writes to MSAA + auto-resolves at pass end) and the fallback
    // path (writes to the resolved view directly) need this.
    context.endCurrentRenderPass?.();

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

    context.endCurrentRenderPass?.();
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
    const { scene, context } = config;
    const enabled = !!(
      scene as unknown as { clusteredLightingEnabled?: boolean }
    ).clusteredLightingEnabled;
    const device = context._device;
    if (!device) {
      return;
    }

    // Lazy-construct on first call — the device wasn't available at
    // SceneRenderer construction time. Construct even when disabled
    // so consumer pipelines (Batch 153+, merged into group 3 effects)
    // can bind the placeholder buffers without runtime branching on
    // whether the dispatcher exists.
    if (!this._clusteredLightingDispatcher) {
      this._clusteredLightingDispatcher = new WebGPUClusteredLightingDispatcher(
        device,
      );
    }

    // End the active canvas render pass before issuing compute work.
    // beginComputePass() on the main encoder while a render pass is
    // open triggers a "encoder is locked" validation error — same
    // family as Batch 144's CesiumMan startup race
    // (BUG-MIPMAP-DURING-CANVAS-PASS). Resume the default pass
    // afterwards so the rest of executeCommands continues seamlessly.
    context.endCurrentRenderPass?.();
    const encoder = context._currentCommandEncoder;
    if (!encoder) {
      context.resumeDefaultRenderPass?.();
      return;
    }

    // Gather world-space lights. The dispatcher walks them per-frame
    // and transforms to eye-space using the supplied viewMatrix.
    const lights: Array<{
      lightType: number;
      posOrDirWC: { x: number; y: number; z: number };
      color: { r?: number; g?: number; b?: number };
      intensity?: number;
      range?: number;
      innerConeAngle?: number;
      outerConeAngle?: number;
      spotDirWC?: { x: number; y: number; z: number };
    }> = [];
    if (enabled) {
      // Scene-level lights from LightCollection.
      const sceneLights = (
        scene as unknown as {
          lights?: { length?: number; get?: (i: number) => unknown };
        }
      ).lights;
      if (sceneLights && sceneLights.length && sceneLights.get) {
        for (let i = 0; i < sceneLights.length; i++) {
          const L = sceneLights.get(i) as {
            lightType?: number;
            enabled?: boolean;
            direction?: { x: number; y: number; z: number };
            position?: { x: number; y: number; z: number };
            color?: { red?: number; green?: number; blue?: number };
            intensity?: number;
            range?: number;
            innerConeAngle?: number;
            outerConeAngle?: number;
          };
          if (L?.enabled === false) continue;
          const lt = L?.lightType ?? 0;
          // Directional: posOrDir = direction; point/spot: position.
          const pd =
            lt === 0
              ? (L.direction ?? { x: 0, y: 0, z: -1 })
              : (L.position ?? { x: 0, y: 0, z: 0 });
          lights.push({
            lightType: lt,
            posOrDirWC: { x: pd.x, y: pd.y, z: pd.z },
            color: {
              r: L.color?.red,
              g: L.color?.green,
              b: L.color?.blue,
            },
            intensity: L.intensity,
            range: L.range,
            innerConeAngle: L.innerConeAngle,
            outerConeAngle: L.outerConeAngle,
            spotDirWC: lt === 2 ? L.direction : undefined,
          });
        }
      }
      // glTF KHR_lights_punctual lights per model — walk the scene's
      // primitives + collect lightsFromGltf. Each model's lights are
      // already in model space; the dispatcher's per-light pack
      // multiplies by viewMatrix to land in eye-space. For non-trivial
      // model transforms a separate per-model matrix multiply would
      // be needed — left for a follow-up batch since the typical
      // scene.lights path covers the common case.
    }

    const uniformState = context.uniformState as unknown as {
      projection?: ArrayLike<number>;
      inverseProjection?: ArrayLike<number>;
      view?: ArrayLike<number>;
    };
    const inverseProjection = uniformState?.inverseProjection;
    const viewMatrix = uniformState?.view;
    if (!inverseProjection || !viewMatrix) {
      // Frame state not ready (e.g., empty pick pass). Skip.
      return;
    }

    // Camera frustum near/far. Use the scene's outermost frustum (the
    // multi-frustum loop's first slice is the closest near, last is
    // the farthest far — collapsing here means cluster bounds span
    // the full visible depth range). Per-frustum-slice cluster bounds
    // are a future optimization.
    const cam = (
      scene as unknown as {
        camera?: { frustum?: { near?: number; far?: number } };
      }
    ).camera;
    const near = Math.max(cam?.frustum?.near ?? 1.0, 0.1);
    const far = Math.max(cam?.frustum?.far ?? 10000.0, near + 1.0);

    this._clusteredLightingDispatcher.dispatch(encoder, {
      enabled,
      lights,
      viewportWidth: this._viewportWidth,
      viewportHeight: this._viewportHeight,
      near,
      far,
      inverseProjection,
      viewMatrix,
    });

    // Slice 5d Batch 153 — Stash the dispatcher's GPU buffers on the
    // context so material pipelines (Model PBR + future Lit Mat
    // shaders) can pass them to `createEffectsBindGroup` at draw time
    // without threading the dispatcher through every render path. The
    // buffer handles don't change frame-to-frame (only their contents),
    // so the effects bind group cache hits on the resource-identity key
    // and only allocates a fresh (UBO + BG) pair the first time these
    // appear. When the dispatcher hasn't run yet OR clustered lighting
    // is disabled, callers can omit `options.clusteredLighting` and the
    // effects bind group falls back to per-device placeholders (whose
    // `params.activeLightCount = 0` makes the FS chunk early-out).
    const d = this._clusteredLightingDispatcher;
    const ctxStash = context as unknown as {
      _clusteredLightingBuffers?: {
        clusterLights: GPUBuffer;
        clusterAABBs: GPUBuffer;
        perClusterLightCount: GPUBuffer;
        perClusterLightIndices: GPUBuffer;
        params: GPUBuffer;
      };
      _clusteredLightingActive?: boolean;
    };
    ctxStash._clusteredLightingBuffers = {
      clusterLights: d.clusterLightsBuffer,
      clusterAABBs: d.clusterAABBsBuffer,
      perClusterLightCount: d.perClusterLightCountBuffer,
      perClusterLightIndices: d.perClusterLightIndicesBuffer,
      params: d.paramsBuffer,
    };
    // Slice 5d Batch 154 — CPU-side "is clustered lighting contributing
    // this frame" flag. Consumers that have a cheap no-effects fast path
    // (the shared primitive effects bind group) gate on this so they only
    // skip the placeholder when there are actually active lights. The
    // Model PBR path passes the buffers unconditionally (it always builds
    // an active effects BG anyway) and relies on params.activeLightCount=0
    // for the FS early-out; primitives need the boolean to preserve their
    // placeholder fast path when clustered lighting is off / empty.
    ctxStash._clusteredLightingActive = enabled && d.lastActiveLightCount > 0;

    // Resume the default canvas render pass so the rest of
    // executeCommands (shadow casts, scene render, etc.) sees the
    // active pass it expects.
    context.resumeDefaultRenderPass?.();
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
  public _getClusteredLightingBuffers(): {
    clusterLights: GPUBuffer;
    clusterAABBs: GPUBuffer;
    perClusterLightCount: GPUBuffer;
    perClusterLightIndices: GPUBuffer;
    params: GPUBuffer;
  } | null {
    const d = this._clusteredLightingDispatcher;
    if (!d) return null;
    return {
      clusterLights: d.clusterLightsBuffer,
      clusterAABBs: d.clusterAABBsBuffer,
      perClusterLightCount: d.perClusterLightCountBuffer,
      perClusterLightIndices: d.perClusterLightIndicesBuffer,
      params: d.paramsBuffer,
    };
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

    const passEncoder = encoder.beginRenderPass(passDesc);
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
    } else {
      context.log(
        "warn",
        `[PostProcess] MISSING: encoder=${!!encoder} sourceView=${!!sourceView} targetView=${!!targetView}`,
      );
    }

    // Resume the default render pass for any subsequent operations
    context.resumeDefaultRenderPass?.();
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
    const mode = scene?._frameState?.debugDepthAsColorMode | 0 || 0;

    this._debugDepthOverlay.execute(
      encoder,
      depthView,
      targetView,
      near,
      far,
      mode,
    );

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
        const passEncoder = encoder.beginRenderPass({
          label: "DebugGBufferOverlay clear (no g-buffer)",
          colorAttachments: [
            {
              view: targetView,
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0.5, g: 0, b: 0.5, a: 1 },
            },
          ],
        });
        passEncoder.end();
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

    context.resumeDefaultRenderPass?.();
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

  /**
   * Create a derived command for a specific rendering mode.
   * Delegates to WebGPUDerivedCommand static methods.
   */
  static createDerivedCommand(
    baseCommand: CesiumAnyDrawCommand,
    type: string,
    context: WebGPUContext,
  ): CesiumAnyDrawCommand {
    switch (type) {
      case "depthOnly":
        return (
          WebGPUDerivedCommand.createDepthOnlyDerivedCommand(baseCommand)
            .command ?? baseCommand
        );
      case "logDepth":
        return (
          WebGPUDerivedCommand.createLogDepthCommand(baseCommand).command ??
          baseCommand
        );
      case "pick":
        return (
          WebGPUDerivedCommand.createPickDerivedCommand(
            baseCommand,
            baseCommand._pickColor ?? [],
          ).command ?? baseCommand
        );
      case "hdr":
        return (
          WebGPUDerivedCommand.createHDRDerivedCommand(baseCommand).command ??
          baseCommand
        );
      case "shadow":
        return (
          WebGPUDerivedCommand.createShadowDerivedCommand(baseCommand)
            .command ?? baseCommand
        );
      default:
        return baseCommand;
    }
  }

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
    // C-R12 (Batch 33) — release the context's invalidation subscriber
    // so it doesn't outlive this SceneRenderer and keep a dead closure
    // captured on the context's listener set.
    if (this._deviceInvalidationUnsub) {
      this._deviceInvalidationUnsub();
      this._deviceInvalidationUnsub = null;
    }
    WebGPUDerivedCommand.clearCache();
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

    culler.dispatch(encoder, count, 0 /* CullMode.VISIBILITY */);
    this._gpuCullDispatchCount++;

    // Async readback — results available next frame, keyed per-
    // frustum (Batch 220) so each frustum's filter consumes its own
    // readback instead of racing the others.
    culler.prepareReadback(encoder, count);
    culler
      .readResults(count)
      .then((results: GPUCullResults) => {
        this._lastCullResultsByFrustum.set(fIdx, results);
      })
      .catch(() => {});

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
    // `Scene.gpuCullingHint = 'never'` short-circuits this gate too.
    const hint = (
      config.scene as { gpuCullingHint?: "auto" | "always" | "never" }
    ).gpuCullingHint;
    if (hint === "never") {
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
      if (flags[i] === 1) filtered.push(commands[i]);
    }
    // B217-N1 (Batch 219) + B219-N2 (Batch 223) — accumulate across
    // frustums. Reset moved to `_executeOpaquePass` frustum-0 entry.
    this._hiZLastInput += count;
    this._hiZLastFiltered += filtered.length;
    return filtered;
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
      uniformState?: {
        viewProjection?: ArrayLike<number>;
        currentFrustumNear?: number;
        currentFrustumFar?: number;
        frameState?: { frameNumber?: number };
      };
    };
    const encoder = ctxAny._currentCommandEncoder;
    const depthView = ctxAny.depthOnlyTextureView;
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
    const params = {
      viewProjection: vp,
      screenWidth: w,
      screenHeight: h,
      nearPlane: frustumCommands?.near ?? us?.currentFrustumNear ?? 1.0,
      farPlane: frustumCommands?.far ?? us?.currentFrustumFar ?? 1e9,
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

    const fr = context.getFeatureRenderer?.(
      FeatureRendererKey.GPU_SORT_KEYS,
    ) as
      | {
          init?: (max: number) => boolean;
          dispatch?: (
            encoder: GPUCommandEncoder,
            soa: {
              centerX: Float32Array;
              centerY: Float32Array;
              centerZ: Float32Array;
              renderLayers: Uint32Array;
              sortPriorities: Uint32Array;
              materialSortIds: Uint32Array;
              count: number;
            },
            params: {
              cameraPosition: { x: number; y: number; z: number };
              sortMode: number;
            },
          ) => boolean;
          // Batch 228 Phase 2 — sort + readback chain.
          runBitonicSort?: (
            encoder: GPUCommandEncoder,
            count: number,
          ) => boolean;
          prepareIndicesReadback?: (
            encoder: GPUCommandEncoder,
            count: number,
          ) => void;
          readSortedIndices?: (count: number) => Promise<Uint32Array | null>;
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
        centerX: new Float32Array(cap),
        centerY: new Float32Array(cap),
        centerZ: new Float32Array(cap),
        renderLayers: new Uint32Array(cap),
        sortPriorities: new Uint32Array(cap),
        materialSortIds: new Uint32Array(cap),
        capacity: cap,
      };
      this._sortKeysSoA = soa;
    }
    let valid = 0;
    for (let i = 0; i < count; i++) {
      const cmd = commands[i] as {
        boundingVolume?: {
          center?: { x: number; y: number; z: number };
        };
        renderLayer?: number;
        sortPriority?: number;
        materialId?: number;
      };
      const c = cmd.boundingVolume?.center;
      if (!c) continue;
      soa.centerX[valid] = c.x;
      soa.centerY[valid] = c.y;
      soa.centerZ[valid] = c.z;
      soa.renderLayers[valid] = cmd.renderLayer ?? 0;
      soa.sortPriorities[valid] = cmd.sortPriority ?? 0;
      soa.materialSortIds[valid] = cmd.materialId ?? 0;
      valid++;
    }
    if (valid === 0) return false;

    const ok = fr.dispatch(
      encoder,
      {
        centerX: soa.centerX,
        centerY: soa.centerY,
        centerZ: soa.centerZ,
        renderLayers: soa.renderLayers,
        sortPriorities: soa.sortPriorities,
        materialSortIds: soa.materialSortIds,
        count: valid,
      },
      {
        cameraPosition: camPos,
        sortMode: 0 /* SORT_MODE_FRONT_TO_BACK — opaque early-Z */,
      },
    );
    if (!ok) return false;
    this._sortKeysDispatches++;

    // NEW-GPU-SORT-PIPELINE Phase 2 (Batch 228) — chain the bitonic
    // sort + readback. Run only when the FR exposes the Phase 2
    // entry points (back-compat with older registrations). The
    // readback's sorted-indices array is stored in
    // `_lastSortedIndices` for the NEXT frame to apply (1-frame
    // latency, same model as the cull readbacks).
    if (
      fr.runBitonicSort &&
      fr.prepareIndicesReadback &&
      fr.readSortedIndices &&
      !this._sortReadbackInFlight
    ) {
      const sortOk = fr.runBitonicSort(encoder, valid);
      if (sortOk) {
        fr.prepareIndicesReadback(encoder, valid);
        this._sortReadbackInFlight = true;
        const sortedCount = valid;
        fr.readSortedIndices(valid)
          .then((indices: Uint32Array | null) => {
            this._sortReadbackInFlight = false;
            if (indices) {
              this._lastSortedIndices = {
                indices,
                count: sortedCount,
              };
            }
          })
          .catch(() => {
            this._sortReadbackInFlight = false;
          });
      }
    }
    return true;
  }

  // ─── High-density cull diagnostic surface (Batch 217) ──────────────────

  /**
   * Snapshot of the three threshold-gated GPU dispatchers' current
   * state + per-frame effectiveness. Routed through
   * `WebGPUContext.getRendererStatistics()` so it appears in
   * `scene.getDebugSnapshot().renderer.highDensityCull`.
   *
   * Counters reset on context destruction; the `last*` fields
   * reflect the most recent frame the dispatcher ran. `hitRatio` is
   * `(input - filtered) / input` — fraction of commands the GPU
   * filter dropped. Above 0.2 means the dispatcher is paying for
   * itself; near 0 means the gate fired but the cull found nothing
   * to drop (likely the CPU cull was already tight).
   */
  getHighDensityCullStats(): {
    gpuCullerOpaque: {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    gpuCullerTranslucent: {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    hiZ: {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
      buildsSkipped: number | null;
      lastFrameInput: number;
      lastFrameFiltered: number;
      hitRatio: number;
    };
    gpuSortKeys: {
      activeAnyFrustum: boolean;
      thresholdHi: number;
      thresholdLo: number;
      dispatches: number;
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
    return {
      gpuCullerOpaque: {
        activeAnyFrustum: anyTrue(this._gpuCullActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
        dispatches: this._gpuCullDispatchCount,
        lastFrameInput: this._gpuCullLastInput,
        lastFrameFiltered: this._gpuCullLastFiltered,
        hitRatio: ratio(this._gpuCullLastInput, this._gpuCullLastFiltered),
      },
      gpuCullerTranslucent: {
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
        activeAnyFrustum: anyTrue(this._gpuSortActiveByFrustum),
        thresholdHi: WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_HI,
        thresholdLo: WebGPUSceneRenderer.GPU_SORT_KEYS_THRESHOLD_LO,
        dispatches: this._sortKeysDispatches,
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
