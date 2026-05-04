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

import Pass from "../../Renderer/Pass.js";
import mergeSort from "../../Core/mergeSort.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
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
import { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import { WebGPUDepthPlane } from "./WebGPUDepthPlane.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { WebGPUDebugDepthOverlay } from "./WebGPUDebugDepthOverlay.js";
import { WebGPUDebugFrustumOverlay } from "./WebGPUDebugFrustumOverlay.js";
import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";
import { WebGPUDerivedCommand } from "./WebGPUDerivedCommand.js";
import { executePickPass } from "./WebGPUSceneRendererPickPass.js";
import { executeEnvironmentalEffects } from "./WebGPUSceneRendererEnvironmentalEffects.js";
import { executeGlobeDispatch } from "./WebGPUSceneRendererGlobePass.js";
import { executeTranslucentPass } from "./WebGPUSceneRendererTranslucentPass.js";
import { execute3DTilePasses } from "./WebGPUSceneRenderer3DTilePasses.js";
import { setupSceneFramebufferRenderPass } from "./WebGPUSceneRendererPassRedirect.js";
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
      if (!frameState.pickingMetadata && d?.picking?.pickCommand) {
        return d.picking.pickCommand;
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
  private _lastCullResults: GPUCullResults | null = null;

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

    const canvas: HTMLCanvasElement | OffscreenCanvas | undefined =
      context._canvas;
    const width = canvas?.width ?? 1;
    const height = canvas?.height ?? 1;
    const needsResize = width !== this._width || height !== this._height;
    const hdr = config.useHDR ?? false;
    const hdrChanged = this._lastHDR !== null && this._lastHDR !== hdr;
    const needsRecreate = !this._initialized || needsResize || hdrChanged;
    this._lastHDR = hdr;

    if (!this._sceneFramebuffer) {
      this._sceneFramebuffer = new WebGPUSceneFramebuffer();
    }
    if (needsRecreate) {
      const numSamples: number = context._msaaSamples ?? 1;
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
    if (
      context._sceneColorFormat !== undefined &&
      context._sceneColorFormat !== previousSceneColorFormat
    ) {
      context._scenePipelineFormatGeneration += 1;
      // AUDIT_2026_05_02 B.20 — every cached `GPURenderBundle` bakes its
      // pipeline's color attachment formats. When the scene color format
      // flips (HDR toggle, MSAA toggle), bundles that reference the old
      // pipeline are stale and produce validation errors when replayed
      // against the new pass encoder. Wipe the bundle cache here.
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
    if (frustum && frustum.near !== undefined) {
      // Use updateFrustum with modified near/far via the scratch approach
      // Store originals, update, then the uniform state captures the projection matrix
      const origNear = frustum.near;
      const origFar = frustum.far;
      frustum.near = near;
      frustum.far = far;
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
    const colorAttachments = rawColor?.map((a) => ({
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
      const colorAttachments = rawColor?.map((a) => ({
        ...a,
        loadOp: "load" as GPULoadOp,
      }));
      const depthStencilAttachment = colorTarget.getDepthStencilAttachment?.();

      if (colorAttachments?.length) {
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
    const commands = frustumCommands.commands[Pass.OPAQUE];
    const count: number = frustumCommands.indices[Pass.OPAQUE];
    if (count === 0) {
      return;
    }
    context.uniformState?.updatePass(Pass.OPAQUE);
    executeBatch(commands, count, scene, context, passState);
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

    // AUDIT_2026_05_02 A.2 — surface the architectural limitation once
    // per session. ADR-2026-04-28's depth-sample classifier collapses
    // the IGNORE_SHOW stencil-mark pass into the regular CLASSIFICATION
    // pass and no longer writes stencil. Without per-pixel
    // classified/unclassified discrimination, the composite tints every
    // tile pixel with `highlightColor` — correct for scenes without
    // classification primitives, but visually wrong for scenes WITH
    // classification primitives (those regions also get tinted).
    // Restoring the stencil mark requires a stencil-write classifier
    // pipeline variant (NEW-INVERT-CLASS-STENCIL-CLASSIFIER, deferred).
    if (!this._invertClassStencilReady) {
      oneTimeWarning(
        "webgpu-invert-classification-stencil",
        "WebGPU InvertClassification: depth-sample classifier (ADR-2026-04-28) " +
          "does not write stencil bits, so the composite cannot distinguish " +
          "classified vs unclassified regions. Every tile pixel gets tinted by " +
          "`invertClassificationColor`. Tracked as NEW-INVERT-CLASS-STENCIL-CLASSIFIER.",
      );
    }

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
      this._postProcess.execute(
        encoder,
        sourceView,
        targetView,
        depthView,
        sceneColorTexture,
        motionView,
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

  /** Minimum command count before GPU culling is worth the overhead */
  private static readonly GPU_CULL_THRESHOLD = 256;

  /**
   * GPU-cull an array of commands using compute shader frustum testing.
   * Returns a filtered array with only visible commands. Falls back to
   * returning the original array if the culler isn't ready or count is
   * below threshold.
   *
   * @param commands - Array of draw commands with boundingVolume
   * @param context - WebGPU context with gpuCuller
   * @param cullingVolume - Camera culling volume with planes[]
   * @returns Filtered command array (may be same reference if no culling done)
   */
  gpuCullCommands(
    commands: CesiumAnyDrawCommand[],
    context: WebGPUContext,
    cullingVolume: {
      planes: Array<{ x: number; y: number; z: number; w: number }>;
    },
  ): CesiumAnyDrawCommand[] {
    if (!commands || commands.length < WebGPUSceneRenderer.GPU_CULL_THRESHOLD) {
      return commands;
    }

    const culler = context.gpuCuller;
    if (!culler || !culler.initialized) {
      return commands;
    }

    // Extract bounding spheres
    const count = commands.length;
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

    // Async readback — results available next frame
    culler.prepareReadback(encoder, count);
    culler
      .readResults(count)
      .then((results: GPUCullResults) => {
        // Cache results for next frame's filtering
        this._lastCullResults = results;
      })
      .catch(() => {});

    // Use previous frame's results if available
    const prev = this._lastCullResults;
    if (prev && prev.visibilityFlags && prev.objectCount === count) {
      const filtered: CesiumAnyDrawCommand[] = [];
      for (let i = 0; i < count; i++) {
        if (prev.visibilityFlags[i] === 1) {
          filtered.push(commands[i]);
        }
      }
      return filtered;
    }

    return commands;
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
