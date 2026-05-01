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
function sortCommandsBackToFront(
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
function sortGaussianSplatsBackToFront(
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

function executeBatch(
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
function executeBatchIndirect(
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
function executeBatchTranslucent(
  commands: CesiumAnyDrawCommand[],
  count: number,
  scene: CesiumScene,
  context: WebGPUContext,
  passState: CesiumPassState,
): void {
  for (let i = 0; i < count; i++) {
    const cmd = commands[i];
    if (!cmd) continue;
    // If the command has a translucency marker, apply the blend state
    if (cmd._webgpuTranslucencyDerived) {
      const saved = {
        blend: cmd._blendEnabled,
        depthWrite: cmd._depthWriteEnabled,
        cullMode: cmd._cullMode,
      };
      const derived = cmd._webgpuTranslucencyDerived[0];
      cmd._blendEnabled = derived?.blendEnabled ?? saved.blend;
      cmd._depthWriteEnabled = derived?.depthWriteEnabled ?? saved.depthWrite;
      cmd._cullMode = derived?.cullMode ?? saved.cullMode;
      executeWebGPUCommand(cmd, scene, context, passState);
      cmd._blendEnabled = saved.blend;
      cmd._depthWriteEnabled = saved.depthWrite;
      cmd._cullMode = saved.cullMode;
    } else {
      executeWebGPUCommand(cmd, scene, context, passState);
    }
  }
}

// --------------- Main class ---------------

export class WebGPUSceneRenderer {
  private _isDestroyed: boolean = false;

  // Scene-level rendering resources (lazy-initialized)
  private _sceneFramebuffer: WebGPUSceneFramebuffer | null = null;
  // C-R8-EDGE-FBO (Batch 44) — MRT framebuffer for the
  // CESIUM_3D_TILE_EDGES pass (edge color + id + packed depth + depth-
  // stencil). Lazily allocated on first frame where
  // `scene._enableEdgeVisibility` is true; stays null otherwise to
  // avoid paying the allocation cost for scenes that don't use edges.
  private _edgeFramebuffer: WebGPUEdgeFramebuffer | null = null;
  // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — translucent tile
  // classification. Allocated when a frame produces classification
  // commands AND has translucent geometry that needs depth capture.
  // Currently allocates eagerly when scene-init runs because the
  // first-cut depth-capture path uses `copyTextureToTexture` from the
  // scene framebuffer — cheap to keep allocated.
  private _translucentTileClassification: WebGPUTranslucentTileClassification | null =
    null;
  private _oit: WebGPUOIT | null = null;
  private _globeDepth: WebGPUGlobeDepth | null = null;
  private _depthPlane: WebGPUDepthPlane | null = null;
  private _postProcess: WebGPUPostProcessPipeline | null = null;
  // Tier 2 debug — fullscreen depth visualization. Lazily constructed
  // on first request so production frames pay nothing.
  private _debugDepthOverlay: WebGPUDebugDepthOverlay | null = null;
  private _depthOverlayWarningLogged: boolean = false;
  // Tier 2 debug — frustum + command tint overlay (WebGPU equivalent of
  // `debugShowFrustums` / `debugShowCommands`). Lazy.
  private _debugFrustumOverlay: WebGPUDebugFrustumOverlay | null = null;
  // Captured during the frustum loop so the post-process debug overlay
  // can tint pixels by which frustum drew them. Reset each frame.
  private _capturedFrustumRanges: { near: number; far: number }[] = [];

  // C-R8-INVERT-CLASS-STENCIL (Batch 40) — set by `_execute3DTilePasses`
  // when it successfully runs the CLASSIFICATION_IGNORE_SHOW pass into
  // the invert FBO, meaning the depth-stencil view carries stencil
  // bits the final composite can use to split classified vs
  // unclassified tile pixels. Reset per-frame at the start of the
  // scene render loop; consumed by `_runInvertClassificationComposite`.
  private _invertClassStencilReady: boolean = false;

  // C-R8-EDGE-FBO (Batch 44) — set by `_execute3DTilePasses` when the
  // CESIUM_3D_TILE_EDGES pass actually ran into the edge MRT
  // framebuffer AND produced content. Reset per-frame; the model FS
  // inline edge stage (Batch 48) reads it via `context._edge*View` to
  // decide whether to gate the overlay or skip.
  private _edgeTexturesPopulated: boolean = false;
  private _initialized: boolean = false;
  private _width: number = 0;
  private _height: number = 0;
  // Batch 109 — track last-applied HDR mode so a runtime toggle of
  // `scene.useHDR` triggers a framebuffer recreate even when the
  // window dimensions don't change. Initial value `null` so the
  // first `update()` call always reaches `_sceneFramebuffer.update`
  // regardless of the initial HDR setting. See Batch 110 for the
  // companion pipeline-cache invalidation that completes the
  // runtime toggle (without it, pipelines have the old canvas
  // format baked in and produce validation warnings against the
  // recreated rgba16float scene FB).
  private _lastHDR: boolean | null = null;
  private _depthPlaneWarned: boolean = false;

  // ── Debug log-once guards (pragma-stripped in production) ──
  //>>includeStart('debug', pragmas.debug);
  private _execDebugLogged: boolean = false;
  private _debugLogged: boolean = false;
  private _postInitDebugLogged: boolean = false;
  private _renderPassRedirectLogged: boolean = false;
  private _ppDebugLogged: boolean = false;
  private _globeValidationDone: boolean = false;
  private _globePassRPLogged: boolean = false;
  private _globeCountLogged: boolean = false;
  private _globeCountLogFrame: number = -1;
  private _globePassLastLog: number = 0;
  //>>includeEnd('debug');

  // ── Runtime state that was previously ad-hoc on `this as any` ──
  private _currentFrustumIndex: number = 0;
  private _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null = null;
  private _lastCullResults: GPUCullResults | null = null;

  // C-R12 (Batch 33) — Tracks the device-invalidation unsubscribe so
  // re-calls to `_ensureResources` don't stack duplicate subscribers.
  private _deviceInvalidationUnsub: (() => void) | null = null;

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
    }
  }

  /**
   * Ensure scene-level resources are created and sized.
   * Called once per frame before the frustum loop.
   */
  private _ensureResources(config: WebGPURenderFrameConfig): void {
    const { context, scene } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
      return;
    }

    // C-R12 (Batch 33) — subscribe once to device-invalidation events
    // so SceneRenderer-owned resources (scene framebuffer, OIT,
    // globeDepth, depth plane, post-process pipeline, debug overlays)
    // are dropped during recovery. Next frame's `_ensureResources`
    // rebuilds them against the new device.
    if (!this._deviceInvalidationUnsub) {
      this._deviceInvalidationUnsub = context.onDeviceInvalidated(() => {
        this._sceneFramebuffer = null;
        this._edgeFramebuffer = null;
        this._translucentTileClassification = null;
        this._oit = null;
        this._globeDepth = null;
        this._depthPlane = null;
        this._postProcess = null;
        this._debugDepthOverlay = null;
        this._debugFrustumOverlay = null;
        this._initialized = false;
      });
    }

    const canvas: HTMLCanvasElement | OffscreenCanvas | undefined =
      context._canvas;
    const width = canvas?.width ?? 1;
    const height = canvas?.height ?? 1;
    const needsResize = width !== this._width || height !== this._height;
    const hdr = config.useHDR ?? false;
    // Batch 109 — HDR toggle gate. A runtime change to `scene.useHDR`
    // flips the scene-FB color format between `rgba16float` (or
    // `rg11b10ufloat`) and the canvas format. Without this gate the
    // outer `if (!_initialized || needsResize)` block below would
    // never fire on a same-resolution HDR toggle, leaving the
    // scene-FB's color format stale + the dependent textures (OIT
    // accumulation, edge MRT, refraction capture, velocity capture)
    // out of sync. Treat HDR change as equivalent to a resize for
    // gating purposes.
    const hdrChanged = this._lastHDR !== null && this._lastHDR !== hdr;
    const needsRecreate = !this._initialized || needsResize || hdrChanged;
    this._lastHDR = hdr;

    // Scene framebuffer (main color + depth + ID targets)
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
      // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — `_sceneFramebuffer.update`
      // destroys the old refraction texture (and view) on resize / HDR
      // toggle. Clear the published view on the context so the model
      // renderer doesn't try to bind it on the next frame; `null` here
      // makes the model bind-group rebuild fall through to the white
      // placeholder until the next capture pass publishes a new view.
      context._refractionSceneView = null;
    }
    // C-R8-INVERT-HDR (Batch 41) — keep `context._sceneColorFormat`
    // in sync with the scene framebuffer's actual color format. Feature
    // renderers (InvertClassification, OIT) read this so their own
    // texture allocations pick `rgba16float` when the scene is HDR and
    // the canvas format otherwise. Previously this field was declared
    // on the context but never assigned, leaving it stuck at the
    // default `"bgra8unorm"` and producing format mismatches when
    // scene-facing pipelines composited against HDR targets.
    const previousSceneColorFormat = context._sceneColorFormat;
    context._sceneColorFormat =
      this._sceneFramebuffer.colorFormat ?? context._sceneColorFormat;
    // Batch 110 — bump the scene pipeline format generation when the
    // scene color format actually changes. Renderers caching pipelines
    // that target scene FB observe the bump and clear+rebuild their
    // local caches against the new `scenePipelineFormat`. Without this,
    // a runtime HDR toggle (rgba16float ↔ canvas format) leaves cached
    // pipelines pointing at the OLD format, producing validation
    // warnings + black scene-FB writes for sky / globe / model /
    // primitive draws.
    if (
      context._sceneColorFormat !== undefined &&
      context._sceneColorFormat !== previousSceneColorFormat
    ) {
      context._scenePipelineFormatGeneration += 1;
    }

    // OIT (order-independent transparency)
    if (config.useOIT && !this._oit) {
      this._oit = new WebGPUOIT();
    }
    if (this._oit && needsRecreate) {
      this._oit.update(device, width, height);
    }

    // C-R8-EDGE-FBO (Batch 44) — edge MRT framebuffer. Allocated only
    // when the scene opts in via `_enableEdgeVisibility`; nothing
    // downstream looks at it otherwise, so idle scenes don't pay for
    // 3 color textures + depth-stencil. Lazy = first-touch, so if the
    // flag toggles on mid-session the next update() call allocates.
    const enableEdgeVisibility = !!(
      scene as unknown as { _enableEdgeVisibility?: boolean }
    )._enableEdgeVisibility;
    if (enableEdgeVisibility && !this._edgeFramebuffer) {
      this._edgeFramebuffer = new WebGPUEdgeFramebuffer();
    }
    if (this._edgeFramebuffer && needsRecreate) {
      const numSamples: number = context._msaaSamples ?? 1;
      this._edgeFramebuffer.update(
        device,
        width,
        height,
        numSamples,
        this._sceneFramebuffer.colorFormat ?? "bgra8unorm",
      );
    }

    // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — translucent classification
    // framebuffer. Allocated lazily on first scene-init; resources are
    // small (one depth, one packed-depth, one color — all single-sample)
    // and the per-frame dispatch is gated on `hasTranslucentDepth` so
    // idle scenes pay only the allocation, not the per-frame work.
    if (!this._translucentTileClassification) {
      this._translucentTileClassification =
        new WebGPUTranslucentTileClassification();
    }
    if (this._translucentTileClassification && needsRecreate) {
      this._translucentTileClassification.update(
        device,
        width,
        height,
        this._sceneFramebuffer.colorFormat ?? "bgra8unorm",
      );
    }

    // Globe depth framebuffer
    if (config.useGlobeDepthFramebuffer && !this._globeDepth) {
      this._globeDepth = new WebGPUGlobeDepth();
    }
    if (this._globeDepth && needsRecreate) {
      const numSamples: number = context._msaaSamples ?? 1;
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      this._globeDepth.update(
        device,
        width,
        height,
        hdr,
        numSamples,
        canvasFormat,
      );
    }

    // Depth plane
    if (config.useDepthPlane && !this._depthPlane) {
      this._depthPlane = new WebGPUDepthPlane();
      const depthFormat: GPUTextureFormat =
        context.depthFormat ?? "depth24plus-stencil8";
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      // C-R7-RENDERER-MIGRATION (Batch 56) — route the depth-plane
      // pipeline through the central cache so split-screen / multi-canvas
      // setups dedupe identical descriptors instead of materializing
      // separate `GPURenderPipeline` objects per scene.
      this._depthPlane.initialize(
        device,
        depthFormat,
        canvasFormat,
        context.webgpuPipelineCache ?? null,
      );
    }

    // Batch 110 (in progress) — when HDR mode toggles at runtime, the
    // post-process pipeline's ping-pong textures (rgba16float ↔ canvas
    // format) and every stage's pipeline target format must rebuild.
    // The cheapest correct path is to destroy the whole pipeline and
    // let the first-init block below recreate it with the new HDR
    // setting + the matching stage chain (e.g., `addAutoExposure`
    // only fires in HDR mode).
    //
    // Detection: the pipeline tracks its own `_hdr` mode internally
    // and we compare against the new `hdr` argument. Skipped on
    // initial mount so the first-init block runs normally.
    if (
      this._postProcess &&
      (this._postProcess as unknown as { _hdr: boolean })._hdr !== hdr
    ) {
      this._postProcess.destroy();
      this._postProcess = null;
    }

    // Post-processing pipeline
    if (config.usePostProcess && !this._postProcess) {
      this._postProcess = new WebGPUPostProcessPipeline();
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      // HDR pipeline fix: when `scene.highDynamicRange=true`, the
      // ping-pong textures use `rgba16float` so the full dynamic range
      // from the scene framebuffer survives through bloom / tonemapping
      // / color grading. Only the final blit down-casts to the canvas
      // swap chain format (bgra8unorm). Without this, every post-process
      // stage was silently clamping HDR values to [0,1] and tonemapping
      // was a mathematical no-op.
      this._postProcess.initialize(device, width, height, canvasFormat, hdr);
      // Add default stages
      // Phase 5 WGF-3: pass the context f16 flag so the tonemap stage
      // selects the hand-tuned half-precision variant when the device
      // granted shader-f16. Default mode/exposure/gamma are unchanged.
      this._postProcess.addTonemapping(
        device,
        canvasFormat,
        undefined,
        undefined,
        undefined,
        !!(context && context.useShaderF16),
      );
      // TAA is added lazily when scene.taaEnabled = true (not default).
      this._postProcess.addFXAA(device, canvasFormat);
      // Auto-exposure: add when HDR is on (matches WebGL's
      // PostProcessStageCollection behavior where autoExposure is
      // enabled alongside tonemapping). Off by default in SDR mode
      // because the scene framebuffer values are already [0,1].
      if (hdr) {
        // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — pipe the central
        // compute pipeline cache through so AutoExposure routes its two
        // pipeline creations through it.
        this._postProcess.addAutoExposure(
          device,
          undefined,
          context?.webgpuComputePipelineCache ?? null,
        );
      }
    }
    if (this._postProcess && needsResize) {
      this._postProcess.resize(width, height);
    }

    // Sync post-processing stage state from CesiumJS PostProcessStageCollection
    // to the WebGPU pipeline. This lazily initializes bloom/AO/DoF on first enable
    // and syncs enable/disable + tonemapping mode each frame.
    if (this._postProcess && config.scene?.postProcessStages) {
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      configureWebGPUPostProcessPipeline(
        this._postProcess,
        config.scene.postProcessStages,
        device,
        canvasFormat,
        config.scene,
      );
    }

    this._width = width;
    this._height = height;
    this._initialized = true;
  }

  // --- Main entry point ---

  executeCommands(config: WebGPURenderFrameConfig): void {
    const { scene, context, passState, picking } = config;

    // --- PICK PASS: Render to pick framebuffer ---
    if (picking) {
      this._executePickPass(config);
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

    // --- Shadow cast pass (once per frame, before multi-frustum rendering) ---
    // Renders scene from light's perspective into the shadow map depth texture.
    if (!config.picking) {
      context.executeShadowMapCastCommands(scene);
    }

    // Opaque near offset to avoid tearing between adjacent frustums
    const opaqueFrustumNearOffset: number =
      scene.opaqueFrustumNearOffset ?? 0.9999;

    // ── Redirect the render pass from the canvas to the scene framebuffer ──
    //
    // The WebGPU context's beginFrame() opens a default render pass
    // targeting the canvas swap chain. But we need commands to draw into
    // the scene framebuffer's color + depth textures so the post-process
    // pipeline can read from them and blit to the canvas later.
    //
    // End the default (canvas) render pass and begin a new one targeting
    // the scene framebuffer. After the frustum loop + environment passes,
    // _runPostProcessing will read from the scene framebuffer and write
    // to the canvas.
    if (this._sceneFramebuffer?.colorTarget && config.usePostProcess) {
      context.endCurrentRenderPass?.();

      const colorTarget = this._sceneFramebuffer.colorTarget;
      const bg = config.backgroundColor;
      const colorAttachments = colorTarget.getColorAttachments?.([
        {
          r: bg?.red ?? 0,
          g: bg?.green ?? 0,
          b: bg?.blue ?? 0,
          a: bg?.alpha ?? 0,
        },
      ]);
      const depthStencilAttachment = colorTarget.getDepthStencilAttachment?.();

      if (!colorAttachments?.length) {
        context.log(
          "error",
          `[SceneRenderer] CRITICAL — scene framebuffer has no color ` +
            `attachments. Commands will draw to nothing and the canvas ` +
            `will be BLACK. Check WebGPUSceneFramebuffer.update().`,
        );
      }
      if (!depthStencilAttachment) {
        context.log(
          "warn",
          `[SceneRenderer] Scene framebuffer has no depth/stencil ` +
            `attachment. Depth testing will be disabled for all commands.`,
        );
      }

      if (colorAttachments?.length && context._currentCommandEncoder) {
        const passDesc: GPURenderPassDescriptor = {
          label: "Scene Framebuffer Render Pass",
          colorAttachments,
          depthStencilAttachment,
        };
        context._currentRenderPassEncoder =
          context._currentCommandEncoder.beginRenderPass(passDesc);
        context._currentRenderPassEncoder.setViewport(
          0,
          0,
          this._width,
          this._height,
          0,
          1,
        );
        context._currentRenderPassEncoder.setScissorRect(
          0,
          0,
          this._width,
          this._height,
        );
        //>>includeStart('debug', pragmas.debug);
        if (!this._renderPassRedirectLogged) {
          this._renderPassRedirectLogged = true;
          const ca0 = colorAttachments[0];
          console.warn(
            `[WebGPU:SceneRenderer] RENDER PASS REDIRECT — ` +
              `sceneFB pass OPENED. viewport=${this._width}x${this._height} ` +
              `colorView=${!!ca0?.view} resolveTarget=${!!ca0?.resolveTarget} ` +
              `depthView=${!!depthStencilAttachment?.view} ` +
              `loadOp=${ca0?.loadOp} storeOp=${ca0?.storeOp} ` +
              `clearColor=${JSON.stringify(ca0?.clearValue)}`,
          );
        }
        //>>includeEnd('debug');
      } else if (!this._renderPassRedirectLogged) {
        this._renderPassRedirectLogged = true;
        console.error(
          `[WebGPU:SceneRenderer] RENDER PASS REDIRECT FAILED — ` +
            `colorAttachments=${colorAttachments?.length} encoder=${!!context._currentCommandEncoder}`,
        );
      }
    } else if (config.usePostProcess) {
      // usePostProcess is true but no scene framebuffer — commands will
      // draw to the canvas directly and the post-process blit will
      // overwrite them with the empty scene framebuffer.
      context.log(
        "error",
        `[SceneRenderer] CRITICAL — usePostProcess=true but no scene ` +
          `framebuffer color target exists. The post-process blit will ` +
          `overwrite the canvas with black. ` +
          `sceneFramebuffer=${!!this._sceneFramebuffer} ` +
          `colorTarget=${!!this._sceneFramebuffer?.colorTarget}`,
      );
    }

    // Reset captured ranges — the debug frustum overlay reads this list
    // in `_runPostProcessing` to tint pixels by which frustum drew them.
    this._capturedFrustumRanges.length = 0;
    // Reset per-frame stencil-ready flag. `_execute3DTilePasses` flips
    // it to true when the CLASSIFICATION_IGNORE_SHOW pass runs inside
    // the invert FBO. `_runInvertClassificationComposite` reads it to
    // decide whether to use the stencil-gated two-pass composite or
    // the single-pass fallback.
    this._invertClassStencilReady = false;
    // C-R8-EDGE-FBO (Batch 44) — reset per-frame edge-populated flag
    // so `_runEdgeComposite` skips the overlay on frames where no
    // edge commands ran (typical frame for scenes without model edge
    // geometry).
    this._edgeTexturesPopulated = false;
    // C-R8-EDGE-INLINE — clear per-frame globe-depth view publication
    // so a stale view from the previous frame doesn't bleed into the
    // model effects bind group on frames that skip the globe-depth
    // copy (e.g., picking, debug paths, useGlobeDepthFramebuffer off).
    context._globeDepthView = null;
    // Migration Session 2 — clear per-frame packed-translucent-depth
    // view so a stale view from the previous frame doesn't get
    // sampled by the classifier when this frame has no translucent
    // tiles. Republished by `tcc.executePackDepth` below when there
    // IS translucent depth available.
    context._packedTranslucentDepthView = null;
    // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — clear per-frame
    // translucent-depth flag; set when the post-translucent depth
    // capture succeeds (single-sample scenes).
    this._translucentTileClassification?.prepareForFrame();

    // C-R8-SCENE2D-JITTER (Batch 36) — capture the initial 2D camera
    // altitude before the frustum loop so we can offset per-frustum
    // inside 2D mode. WebGL's `SceneRenderer.js:419,444-449` does this
    // to compress the 2D near/far range into [1, far-near+1] so the
    // ortho depth buffer has uniform precision across frustums instead
    // of banding where tiles intersect a frustum boundary. `.position`
    // lives on the real `Camera.js` instance (line 175) but isn't
    // declared on the ambient `CesiumCamera` shape — cast to read.
    const scene2DCamera = scene.camera as unknown as {
      position: { z: number };
    };
    const initialHeight2D =
      scene.mode === 2 /* SceneMode.SCENE2D */ ? scene2DCamera.position.z : 0;

    // --- Multi-frustum loop: iterate from FAR to NEAR ---
    // This matches the WebGL path in Scene.js which goes (numFrustums - 1 - i)
    for (let i = 0; i < numFrustums; i++) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      // C-R8-SCENE2D-JITTER (Batch 36) — 2D-mode per-frustum offset.
      // Mirrors `SceneRenderer.js:444-449`: compress far-near to [1,
      // far-near+1] and shift camera.z to keep ortho depth precision
      // consistent across frustum boundaries.
      let near;
      let far;
      if (scene.mode === 2 /* SceneMode.SCENE2D */) {
        scene2DCamera.position.z = initialHeight2D - frustumCommands.near + 1.0;
        far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
        near = 1.0;
      } else {
        // Apply opaque near offset to avoid tearing artifacts between adjacent frustums
        // (except for the nearest frustum which uses the actual near value)
        near =
          index !== 0
            ? frustumCommands.near * opaqueFrustumNearOffset
            : frustumCommands.near;
        far = frustumCommands.far;
      }

      // Store the range indexed by the ORIGINAL frustum index (0 = nearest)
      // so `WebGPUDebugFrustumOverlay` can match the WebGL DebugInspector
      // bitmask order. `index` already points to the natural order.
      this._capturedFrustumRanges[index] = {
        near: frustumCommands.near,
        far,
      };

      this._updateFrustumUniforms(uniformState, near, far, scene);
      this._currentFrustumIndex = i;

      // Clear depth/stencil per frustum (but not color — color accumulates across frustums).
      //
      // EXCEPTION: when `debugShowDepthAsColor` is on, skip the inter-frustum
      // clear (except before the very first iteration, so we start with a
      // known-clean buffer). Without this, only the nearest frustum's
      // geometry survives into the depth texture that the debug overlay
      // samples — the user sees an all-cleared depth buffer at any camera
      // altitude where the globe lives in the far frustum. Depth-test
      // correctness is compromised for the debug frame (far-frustum geometry
      // may incorrectly occlude near-frustum geometry through stale depth),
      // but the viz is THE tool you'd reach for when something's wrong with
      // depth anyway, so the tradeoff is intentional.
      const debugDepthViz = scene?._frameState?.debugShowDepthAsColor === true;
      if (!debugDepthViz || i === 0) {
        this._clearDepthStencil(context);
      }

      // Pass 0: ENVIRONMENT (sky, sun, moon, atmosphere) — once in farthest frustum
      if (i === 0) {
        this._executePassCommands(
          frustumCommands,
          Pass.ENVIRONMENT,
          scene,
          context,
          passState,
        );
      }

      // Pass 2: GLOBE
      this._executeGlobePass(frustumCommands, config);

      // Copy globe depth for terrain clamping and picking.
      // C-R8-GLOBE-DEPTH-ENABLE (Batch 42) — pass the scene framebuffer
      // depth explicitly (that's where globe actually wrote). The
      // internal `_outputTarget` fallback inside GlobeDepth is never
      // written to by WebGPU scene code.
      if (this._globeDepth && config.useGlobeDepthFramebuffer) {
        const encoder: GPUCommandEncoder | undefined =
          context._currentCommandEncoder;
        if (encoder) {
          const depthSource: GPUTexture | undefined =
            this._sceneFramebuffer?.colorTarget?.getDepthTexture();
          // End current render pass so the depth texture is available for reading
          context.endCurrentRenderPass?.();
          this._globeDepth.executeCopyDepth(encoder, depthSource);
          // Resume the SCENE FRAMEBUFFER pass for subsequent commands —
          // not the canvas pass. `resumeDefaultRenderPass` would redirect
          // every following draw to the canvas swap-chain, leaving the
          // scene FB empty for the post-process chain to blit.
          this._resumeScenePass(context);
          // C-R8-EDGE-INLINE — publish the packed-depth view on the
          // context so model FS bind-group construction can sample
          // globe depth without reaching back through the renderer
          // hierarchy. View is recreated each frame because the
          // underlying texture can change on resize.
          const packedDepth = this._globeDepth.globeDepthTexture;
          context._globeDepthView = packedDepth
            ? packedDepth.createView()
            : null;
        }
      }

      // Pass 3: TERRAIN_CLASSIFICATION
      this._executePassCommands(
        frustumCommands,
        Pass.TERRAIN_CLASSIFICATION,
        scene,
        context,
        passState,
      );

      // Clear globe depth if needed for primitives-on-top rendering.
      // Same debug bypass as the inter-frustum clear above — we want the
      // debug overlay to see globe + 3D-tiles depth together, not a buffer
      // that was wiped mid-frustum.
      if (config.clearGlobeDepth && !debugDepthViz) {
        this._clearDepthStencil(context);
        if (config.useDepthPlane) {
          this._renderDepthPlane(config);
        }
      }

      // Pass 4-7: 3D Tiles passes. C-R8 (Batch 35): pass a depth-update
      // hook so `globeDepth.executeUpdateDepth` fires between the main
      // `CESIUM_3D_TILE` pass and the classification passes — otherwise
      // classification reads pre-tile terrain-only depth and Z-fights
      // against 3D-tile surfaces.
      //
      // C-R8-INVERT-DEPTH-SOURCE (Batch 41): when invert classification
      // is active, tile geometry wrote to the invert FBO's own depth
      // (not scene depth), so the post-tile depth copy must sample
      // THAT depth texture or downstream consumers see globe-only
      // depth and Z-fight tiles. Mirrors the WebGL `depthStencilTexture`
      // argument at `SceneRenderer.js:576`.
      this._execute3DTilePasses(frustumCommands, config, () => {
        if (this._globeDepth && config.useGlobeDepthFramebuffer) {
          const enc: GPUCommandEncoder | undefined =
            context._currentCommandEncoder;
          if (enc) {
            // C-R8-GLOBE-DEPTH-ENABLE (Batch 42) — default depth source
            // is the scene framebuffer's depth (that's where scene
            // commands actually wrote depth). When invert is on, tile
            // depth went into the invert FBO instead, so override
            // with the invert depth texture. Mirrors WebGL's explicit
            // `depthStencilTexture` argument at
            // `SceneRenderer.js:549-553` (default) and `:576` (invert).
            let depthSource: GPUTexture | undefined =
              this._sceneFramebuffer?.colorTarget?.getDepthTexture();
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
            this._globeDepth.executeUpdateDepth(enc, depthSource);
            this._resumeScenePass(context);
          }
        }
      });

      // C-R8 (Batch 35) — VOXELS moved before OPAQUE to match WebGL.
      // `SceneRenderer.js:606` runs `performVoxelsPass` BEFORE
      // `performPass(Pass.OPAQUE)`; previous WebGPU ordering ran voxels
      // after OPAQUE which mis-ordered volumetric media against opaque
      // depth. Back-to-front sort still applies.
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
      this._executePassCommands(
        frustumCommands,
        Pass.VOXELS,
        scene,
        context,
        passState,
      );

      // Pass 8: OPAQUE
      this._executeOpaquePass(frustumCommands, config);

      // Pass 11: GAUSSIAN_SPLATS
      // GS-WSR: If OIT is available and splat commands have OIT variants,
      // defer them to the translucent OIT pass for proper weighted-sum rendering.
      // Otherwise render inline with standard alpha blending.
      {
        const splatCommands = frustumCommands.commands[Pass.GAUSSIAN_SPLATS];
        const splatCount: number =
          frustumCommands.indices[Pass.GAUSSIAN_SPLATS];
        const hasOITSplats =
          this._oit?.isSupported &&
          config.useOIT &&
          !config.picking &&
          splatCount > 0 &&
          splatCommands[0]?._oitPipeline;

        if (hasOITSplats) {
          // Splats will be rendered in the OIT accumulation pass below
          // by injecting them into the translucent command list.
          // Store them for later use.
          this._deferredOITSplats = {
            commands: splatCommands,
            count: splatCount,
          };
        } else {
          if (splatCount > 0) {
            // GS uses alpha accumulation — non-OIT path must sort back-to-front.
            // Splats use a box-center distance metric (see
            // `backToFrontSplats` in Scene/CommandSorter.js) rather than the
            // sphere `distanceSquaredTo` used by generic translucent geometry.
            sortGaussianSplatsBackToFront(splatCommands, splatCount, scene);
          }
          this._executePassCommands(
            frustumCommands,
            Pass.GAUSSIAN_SPLATS,
            scene,
            context,
            passState,
          );
        }
      }

      // For translucent pass, use actual near to avoid blending artifacts
      if (index !== 0 && scene.mode !== 2 /* SceneMode.SCENE2D */) {
        this._updateFrustumUniforms(
          uniformState,
          frustumCommands.near,
          far,
          scene,
        );
      }

      // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — refraction capture.
      // Snapshots opaque-only scene color (after OPAQUE/MASK passes
      // and after voxels/splats) into a dedicated refraction target so
      // transmissive surfaces drawn in the TRANSLUCENT pass that
      // follows can sample "the world behind this glass" without
      // double-counting their own contribution. Gated on
      // `context._sceneHasTransmission` (set by the model emitter when
      // any primitive has FLAG_HAS_TRANSMISSION) so frames with no
      // transmissive primitives pay zero cost. Runs every frustum so
      // each transmissive draw sees the right per-frustum opaque
      // backdrop.
      this._captureRefractionScene(config);

      // Pass 9: TRANSLUCENT (with OIT if enabled)
      this._executeTranslucentPass(frustumCommands, config);

      // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — capture translucent
      // depth into the dedicated depth target so classification
      // primitives running in the next pass can clamp to the
      // translucent surface. First-cut implementation: copy from the
      // scene framebuffer's depth (over-broad — captures all
      // translucent contributors, not just 3D-tile content).
      // C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA scenes now
      // packed via the multisampled-depth pack pipeline (sample 0
      // resolve), no longer skipped. Runs every frustum so the
      // classification reads the right per-frustum depth, but only
      // the last frustum's depth survives into the composite
      // (multi-frustum accumulation is `C-R8-TRANSLUCENT-MULTI-FRUSTUM`).
      const tcc = this._translucentTileClassification;
      const has3DTileClassification =
        (frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] ?? 0) > 0;
      if (
        !picking &&
        tcc &&
        has3DTileClassification &&
        tcc.isSupported() &&
        this._sceneFramebuffer?.colorTarget
      ) {
        // The scene depth texture is sampleable when single-sample.
        // Capture happens via copyTextureToTexture so we need an
        // active command encoder; end any current render pass first.
        const enc: GPUCommandEncoder | undefined =
          context._currentCommandEncoder;
        if (enc) {
          // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 78) — gate the broad
          // scene-depth copy on whether any TRANSLUCENT command in this
          // frustum carries `depthForTranslucentClassification === true`.
          // `Cesium3DTile.js:1084` sets that flag on translucent 3D-tile
          // commands; nothing else in the engine sets it. When the
          // frustum's classification list is non-empty but no flagged
          // commands feed into the depth, the whole pack-depth pipeline
          // would feed off useless data (label/billboard depth, etc.) —
          // skipping it is correct. When at least one is flagged, the
          // broad copy still runs (truly selective rendering needs the
          // C-R8-TRANSLUCENT-MULTI-FRUSTUM per-frustum render pass
          // restructure, where the depth-only pipeline variants land).
          const translucentCmds = frustumCommands.commands[Pass.TRANSLUCENT];
          const translucentCount =
            (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) >>> 0;
          let flaggedCommandsPresent = false;
          for (let i = 0; i < translucentCount; ++i) {
            const cmd = translucentCmds[i] as unknown as
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
            this._sceneFramebuffer.colorTarget.getDepthTexture?.() ?? null;
          tcc.executeTranslucentDepthPass(
            enc,
            sceneDepthTex,
            flaggedCommandsPresent,
          );
          // Pack the captured depth so classification pipelines can
          // sample it as a regular texture. Internally early-exits when
          // `_hasTranslucentDepth` is false (the gating above sets it).
          const opaqueSampleableView =
            this._sceneFramebuffer.colorTarget.getDepthSampleableView?.() ??
            null;
          tcc.executePackDepth(enc, opaqueSampleableView);
          // Migration Session 2 — publish the packed-translucent-depth
          // view on the context so the depth-sample classifier
          // (`WebGPUGroundPrimitiveRenderer`) can sample it instead of
          // `_globeDepthView` for translucent-on-translucent
          // classification. The getter returns `undefined` when no
          // translucent depth was captured this frame, which we
          // normalize to `null` so the consumer's existing null-check
          // pattern works. The view is recreated each frame from the
          // packed-depth texture; the classifier rebuilds its bind
          // group when the view ref changes.
          context._packedTranslucentDepthView =
            tcc.packedTranslucentDepthView ?? null;
          this._resumeScenePass(context);
        }
      }

      // Pick depth copy per frustum (for pickPosition support)
      if (
        !picking &&
        config.useGlobeDepthFramebuffer &&
        this._globeDepth &&
        scene._picking
      ) {
        const pickDepth = scene._picking.getPickDepth(scene, index);
        // Pass the packed-depth-as-color texture (RGBA8, from executeCopyDepth)
        // so PickDepth can read it via buffer copy + mapAsync
        const packedDepthTex = this._globeDepth.globeDepthTexture;
        if (pickDepth && packedDepthTex) {
          pickDepth.update(context, packedDepthTex);
        }
      }
    }

    // Pass 12: OVERLAY (runs once, not per-frustum)
    this._executeOverlayPass(frustumCommandsList, config);

    // Depth plane (if enabled, renders after all frustums)
    if (!config.clearGlobeDepth) {
      this._renderDepthPlane(config);
    }

    // Environmental effects: procedural clouds, SSR, weather particles
    // These are full-screen composite passes that run after all geometry
    // but before post-processing (tonemapping, bloom, FXAA, etc.)
    this._executeEnvironmentalEffects(config);

    // C-R8-EDGE-COMPOSITE-PRUNE (Batch 50) — post-process edge composite
    // retired. Model edges now composite inline inside Model FS via
    // `applyEdgeOverlay()` (Batch 48); primitive shaders don't currently
    // emit edges. The edge MRT views are still produced (model emitter
    // runs into the edge FBO) and remain readable from
    // `context._edge*View` for the inline stage. No call here.

    // Migration Session 5 (Batch 85) — Batch 47's composite call removed.
    // The depth-sample classifier (ADR-2026-04-28) draws directly into
    // scene color during the per-frustum CESIUM_3D_TILE_CLASSIFICATION
    // pass, so there is no separate accumulation target to composite
    // back. The accumulation-FBO + composite pipeline scaffolding in
    // WebGPUTranslucentTileClassification was retired in this batch.

    // C-R8-INVERT-CLASS-FBO-REDIRECT (Batch 39) — Composite the
    // InvertClassification classified texture back onto scene color.
    // Runs AFTER the main scene pass ends + resolves (so the target
    // is the single-sample resolved view the composite pipeline is
    // built for) and BEFORE post-processing (so the tonemap/FXAA
    // chain sees the composited scene).
    this._runInvertClassificationComposite(config);

    // TAA Slice 2e (Batch 106) — velocity pass for per-pixel motion
    // vectors. Walks the frustum command lists, collects any
    // `cmd.velocityCommand` (attached by the model renderer when
    // `frameState.taaEnabled === true`), and dispatches them into a
    // dedicated single-target rg16float render pass that shares scene
    // depth read-only. Skipped entirely when no command carries a
    // velocity slot — static scenes / TAA-off frames pay zero cost.
    // Must run AFTER the main scene pass closes (so the depth values
    // are committed) and BEFORE post-process consumes the velocity
    // texture in TAA's `motionTex` binding (Batch 104).
    this._runVelocityPass(config);

    // Post-processing (tonemapping, FXAA, etc.)
    // On WebGPU this is REQUIRED to blit the scene framebuffer to canvas.
    //>>includeStart('debug', pragmas.debug);
    if (!this._ppDebugLogged) {
      this._ppDebugLogged = true;
      console.log(
        `[WebGPU:PostProcess] _runPostProcessing entering: ` +
          `usePostProcess=${config.usePostProcess} ` +
          `_postProcess=${!!this._postProcess} ` +
          `sceneFramebuffer=${!!this._sceneFramebuffer}`,
      );
    }
    //>>includeEnd('debug');
    this._runPostProcessing(config);

    // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — clear the per-frame
    // transmission signal at the END of executeCommands. The model
    // renderer sets this to `true` during `update()` (which runs
    // BEFORE executeCommands as part of scene update), so resetting
    // at the start would clobber it before the per-frustum capture
    // step gets to read it. Resetting here means next frame's
    // `update()` starts with a clean slate; if no model declares
    // transmission, the capture step early-exits.
    context._sceneHasTransmission = false;

    // Performance infrastructure: end frame — flush indirect draws, collect profiling
    if (perfManager) {
      perfManager.endFrame();
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
  private _resumeScenePass(context: WebGPUContext): void {
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
    context._currentRenderPassEncoder.setViewport(
      0,
      0,
      this._width,
      this._height,
      0,
      1,
    );
    context._currentRenderPassEncoder.setScissorRect(
      0,
      0,
      this._width,
      this._height,
    );
  }

  private _clearDepthStencil(context: WebGPUContext): void {
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
        context._currentRenderPassEncoder.setViewport(
          0,
          0,
          this._width,
          this._height,
          0,
          1,
        );
        context._currentRenderPassEncoder.setScissorRect(
          0,
          0,
          this._width,
          this._height,
        );
        return;
      }
    }

    // Fallback for non-scene-FB passes (canvas direct, pick buffer, etc.)
    context.clear?.({ depth: 1.0, stencil: 0, color: false });
  }

  // --- Globe pass (with GlobeDepth integration) ---

  private _executeGlobePass(
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

    // Check if globe is translucent
    const globe = scene.globe;
    const isTranslucent =
      globe &&
      globe._surface &&
      globe._surface._tileProvider &&
      globe._surface._tileProvider.translucencyEnabled;

    if (isTranslucent) {
      // Globe translucency: execute with per-command blend/cull/depth state
      // from the _webgpuTranslucencyDerived marker set by
      // WebGPUGlobeTranslucencyState.updateDerivedCommands()
      executeBatchTranslucent(commands, count, scene, context, passState);
      return;
    }

    // Try render bundles for opaque terrain (reduces driver overhead)
    const perfMgr = context.performanceManager;
    const renderPass = context.currentRenderPassEncoder;
    if (
      perfMgr &&
      renderPass &&
      count >= (perfMgr.config?.renderBundleThreshold ?? 8)
    ) {
      try {
        // Batch 110 — globe terrain pipelines target the scene FB, so
        // the bundle's `colorFormats` must mirror the scene FB color
        // format (rgba16float in HDR, canvas format otherwise). Using
        // `presentationFormat` here would mismatch in HDR mode and the
        // bundle would be flagged invalid.
        const bundleEncoder = context._device.createRenderBundleEncoder({
          label: "Globe terrain bundle",
          colorFormats: [context.scenePipelineFormat],
          depthStencilFormat: context.depthFormat ?? "depth24plus-stencil8",
        });

        let drawCalls = 0;
        for (let i = 0; i < count; i++) {
          const cmd = commands[i];
          if (cmd && cmd.execute) {
            // Ad-hoc globe commands and WebGPUDrawCommands both accept
            // a GPURenderBundleEncoder (same API as GPURenderPassEncoder)
            cmd.execute(bundleEncoder, context);
            drawCalls++;
          }
        }

        if (drawCalls > 0) {
          const bundle = bundleEncoder.finish();
          renderPass.executeBundles([bundle]);
          return;
        }
      } catch (_e) {
        // Fall through to unbundled execution if bundle recording fails
      }
    }

    executeBatch(commands, count, scene, context, passState);
  }

  // --- 3D Tiles passes ---

  private _execute3DTilePasses(
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
    const INDIRECT_BATCH_MIN = 32;
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
    const edgeFB = this._edgeFramebuffer;
    const redirectEdgesToFBO =
      edgeCommandCount > 0 && !!edgeFB && edgeFB.isReady;
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
          edgePass.setViewport(0, 0, this._width, this._height, 0, 1);
          edgePass.setScissorRect(0, 0, this._width, this._height);
          runPass(Pass.CESIUM_3D_TILE_EDGES);
          context.endCurrentRenderPass?.();
        }
      }
      this._resumeScenePass(context);

      // Expose the resolved edge textures on the context for the
      // composite consumer (`_runEdgeComposite`) to pick up. Matches
      // WebGL's `uniformState.edgeColorTexture = ...` assignment at
      // `SceneRenderer.js:513-533`.
      context._edgeColorView = edgeFB.colorSampleableView ?? null;
      context._edgeIdView = edgeFB.idSampleableView ?? null;
      context._edgeDepthView = edgeFB.depthSampleableView ?? null;
      this._edgeTexturesPopulated = true;
    } else if (edgeCommandCount > 0) {
      // Edges present but FBO isn't ready (scene just enabled
      // `_enableEdgeVisibility` this frame, or allocation raced with
      // resize). Run on the current scene target — visually equivalent
      // to the pre-Batch-44 path; no edge textures are populated.
      runPass(Pass.CESIUM_3D_TILE_EDGES);
      context._edgeColorView = null;
      context._edgeIdView = null;
      context._edgeDepthView = null;
      this._edgeTexturesPopulated = false;
    } else {
      // No edge commands this frame — clear the context slots so a
      // stale view from a previous frame doesn't leak into the
      // composite (which gates on `_edgeTexturesPopulated`).
      context._edgeColorView = null;
      context._edgeIdView = null;
      context._edgeDepthView = null;
      this._edgeTexturesPopulated = false;
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
          tilePass.setViewport(0, 0, this._width, this._height, 0, 1);
          tilePass.setScissorRect(0, 0, this._width, this._height);
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
            ignoreShowPass.setViewport(0, 0, this._width, this._height, 0, 1);
            ignoreShowPass.setScissorRect(0, 0, this._width, this._height);
            runPass(Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW);
            context.endCurrentRenderPass?.();
            invertHasStencilData = true;
          }
        }

        // Resume scene pass for the normal CLASSIFICATION pass which
        // runs on scene color (regular behavior, not redirected).
        this._resumeScenePass(context);
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
        this._resumeScenePass(context);
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
      this._invertClassStencilReady = true;
    }
  }

  // --- Opaque pass ---

  private _executeOpaquePass(
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

  private _executeTranslucentPass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const commands = frustumCommands.commands[Pass.TRANSLUCENT];
    const count: number = frustumCommands.indices[Pass.TRANSLUCENT];
    if (count === 0) {
      return;
    }

    context.uniformState?.updatePass(Pass.TRANSLUCENT);

    // OIT accumulation + composite path.
    // Full MRT OIT (McGuire & Bavoil 2013) requires 2-target pipeline variants
    // for each renderer (accumulation rgba16float + revealage r8unorm).
    // Pipeline variant support is implemented per-renderer by checking
    // command._oitPipeline. When available, we use the MRT accumulation pass;
    // otherwise fall back to standard alpha blending.
    if (
      this._oit &&
      this._oit.isSupported &&
      config.useOIT &&
      !config.picking
    ) {
      // Auto-create OIT pipeline variants for commands that have shader code
      // but no OIT pipeline yet. This enables OIT for any command that opts in
      // by storing its WGSL source in _shaderCode.
      let hasOITPipelines = false;
      for (let ci = 0; ci < count; ci++) {
        const cmd = commands[ci];
        if (!cmd) continue;
        if (cmd._oitPipeline) {
          hasOITPipelines = true;
        } else if (cmd._shaderCode && cmd.isWebGPUDrawCommand && this._oit) {
          const pipelineConfig = cmd._pipelineConfig as
            | {
                label?: string;
                layout: GPUPipelineLayout | "auto";
                vertexBuffers?: GPUVertexBufferLayout[];
                vertexEntryPoint?: string;
                fragmentEntryPoint?: string;
                primitive?: GPUPrimitiveState;
                depthStencil?: GPUDepthStencilState;
                multisample?: GPUMultisampleState;
              }
            | undefined;
          const oitPipeline = this._oit.createOITPipeline(
            context.device,
            cmd._shaderCode,
            pipelineConfig ?? {
              label: cmd.owner?.constructor?.name ?? "auto",
              layout: "auto",
              primitive: { topology: "triangle-list" },
              depthStencil: context.depthFormat
                ? {
                    format: context.depthFormat,
                    depthWriteEnabled: false,
                    depthCompare: "less-equal" as GPUCompareFunction,
                  }
                : undefined,
            },
          );
          if (oitPipeline) {
            cmd._oitPipeline = oitPipeline;
            hasOITPipelines = true;
          }
        }
      }

      if (hasOITPipelines) {
        // Full OIT path: end opaque render pass → accumulation → composite
        const encoder: GPUCommandEncoder | undefined =
          context._currentCommandEncoder;
        const depthView = context._depthStencilView;
        if (encoder && depthView) {
          context.endCurrentRenderPass?.();

          // Begin OIT accumulation render pass (2 MRT targets, depth read-only)
          const accPassDesc =
            this._oit.getAccumulationPassDescriptor(depthView);
          if (accPassDesc) {
            const accPass = encoder.beginRenderPass(accPassDesc);
            // Helper to execute a single OIT command in the accumulation pass
            const executeOITCommand = (cmd: CesiumAnyDrawCommand) => {
              if (!cmd?._oitPipeline) return;
              accPass.setPipeline(cmd._oitPipeline);
              for (let bi = 0; bi < cmd.bindGroups.length; bi++) {
                accPass.setBindGroup(bi, cmd.bindGroups[bi]);
              }
              for (let vi = 0; vi < cmd.vertexBuffers.length; vi++) {
                accPass.setVertexBuffer(
                  vi,
                  (cmd.vertexBuffers[vi] as { buffer: GPUBuffer })?.buffer,
                );
              }
              if (cmd.indexBuffer && cmd.indexCount) {
                accPass.setIndexBuffer(
                  (cmd.indexBuffer as { buffer: GPUBuffer }).buffer,
                  cmd.indexFormat ?? "uint16",
                );
                accPass.drawIndexed(cmd.indexCount, cmd.instanceCount ?? 1);
              } else if (cmd.vertexCount) {
                accPass.draw(cmd.vertexCount, cmd.instanceCount ?? 1);
              }
            };

            // Execute translucent commands with OIT pipeline variants
            for (let ci = 0; ci < count; ci++) {
              const cmd = commands[ci];
              if (cmd?.isWebGPUDrawCommand && cmd._oitPipeline) {
                executeOITCommand(cmd);
              }
            }

            // GS-WSR: Include deferred Gaussian splat commands in OIT accumulation
            const deferredSplats = this._deferredOITSplats;
            if (deferredSplats) {
              for (let si = 0; si < deferredSplats.count; si++) {
                executeOITCommand(deferredSplats.commands[si]);
              }
              this._deferredOITSplats = null;
            }

            accPass.end();

            // Composite OIT result over opaque scene
            const sceneColorView = context._sceneColorView;
            const sceneColorFormat = context._sceneColorFormat ?? "bgra8unorm";
            if (sceneColorView) {
              this._oit.executeComposite(
                encoder,
                sceneColorView,
                sceneColorFormat,
              );
            }
          }

          // Resume default render pass for subsequent passes
          context.resumeDefaultRenderPass?.();
          return;
        }
      }
    }

    // Fallback: render translucent commands with standard alpha blending.
    // Without OIT, alpha compositing is order-dependent — commands MUST be
    // drawn back-to-front for correct results. Without this sort, overlapping
    // translucent UI (labels through buildings, semi-transparent layers, etc.)
    // composites in command-push order and shows visibly wrong occlusion.
    //
    // We sort a slice rather than the full backing array so pooled slots at
    // [count, length) keep their last-frame contents for the next frame's
    // reuse logic, and `frustumCommands.indices` stays authoritative.
    sortCommandsBackToFront(commands, count, scene);
    executeBatch(commands, count, scene, context, passState);
  }

  // --- Overlay pass ---

  private _executeOverlayPass(
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

  private _renderDepthPlane(config: WebGPURenderFrameConfig): void {
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
  private _executeEnvironmentalEffects(config: WebGPURenderFrameConfig): void {
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
  private _runInvertClassificationComposite(
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
  private _captureRefractionScene(config: WebGPURenderFrameConfig): void {
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
  private _runVelocityPass(config: WebGPURenderFrameConfig): void {
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
    passEncoder.setViewport(0, 0, width, height, 0, 1);
    passEncoder.setScissorRect(0, 0, width, height);

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

  private _runPostProcessing(config: WebGPURenderFrameConfig): void {
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

  private _executePassCommands(
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
}
