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
import FeatureRendererKey from "../FeatureRendererKey.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import { WebGPUOIT } from "./WebGPUOIT.js";
import { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import { WebGPUDepthPlane } from "./WebGPUDepthPlane.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { WebGPUDebugDepthOverlay } from "./WebGPUDebugDepthOverlay.js";
import { WebGPUDebugFrustumOverlay } from "./WebGPUDebugFrustumOverlay.js";
import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";
import { WebGPUDerivedCommand } from "./WebGPUDerivedCommand.js";

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
const _warnedCommandsMap = new WeakMap<object, Set<string>>();
function _getWarnedCommands(context: object): Set<string> {
  let set = _warnedCommandsMap.get(context);
  if (!set) {
    set = new Set();
    _warnedCommandsMap.set(context, set);
  }
  return set;
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

  // Detect command type via duck-typing:
  // - WebGPU commands have `pipeline` or `_pipeline` -> execute(renderPass, context)
  // - WebGL commands have `shaderProgram` -> execute(context, passState)
  // - isWebGPUDrawCommand also supported for backwards compat
  const isGPU =
    command.isWebGPUDrawCommand === true ||
    command.pipeline !== undefined ||
    command._pipeline !== undefined;

  if (isGPU) {
    const renderPass = context.currentRenderPassEncoder;
    if (renderPass) {
      command.execute(renderPass, context);
    }
    return;
  }
  if (command.execute) {
    command.execute(context, passState);
    return;
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
  private _initialized: boolean = false;
  private _width: number = 0;
  private _height: number = 0;
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

  // --- Lazy initialization ---

  /**
   * Ensure scene-level resources are created and sized.
   * Called once per frame before the frustum loop.
   */
  private _ensureResources(config: WebGPURenderFrameConfig): void {
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

    // Scene framebuffer (main color + depth + ID targets)
    if (!this._sceneFramebuffer) {
      this._sceneFramebuffer = new WebGPUSceneFramebuffer();
    }
    if (!this._initialized || needsResize) {
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
    }

    // OIT (order-independent transparency)
    if (config.useOIT && !this._oit) {
      this._oit = new WebGPUOIT();
    }
    if (this._oit && (!this._initialized || needsResize)) {
      this._oit.update(device, width, height);
    }

    // Globe depth framebuffer
    if (config.useGlobeDepthFramebuffer && !this._globeDepth) {
      this._globeDepth = new WebGPUGlobeDepth();
    }
    if (this._globeDepth && (!this._initialized || needsResize)) {
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
      this._depthPlane.initialize(device, depthFormat, canvasFormat);
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
        this._postProcess.addAutoExposure(device);
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

    // --- Multi-frustum loop: iterate from FAR to NEAR ---
    // This matches the WebGL path in Scene.js which goes (numFrustums - 1 - i)
    for (let i = 0; i < numFrustums; i++) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      // Apply opaque near offset to avoid tearing artifacts between adjacent frustums
      // (except for the nearest frustum which uses the actual near value)
      const near =
        index !== 0
          ? frustumCommands.near * opaqueFrustumNearOffset
          : frustumCommands.near;
      const far = frustumCommands.far;

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

      // Copy globe depth for terrain clamping and picking
      if (this._globeDepth && config.useGlobeDepthFramebuffer) {
        const encoder: GPUCommandEncoder | undefined =
          context._currentCommandEncoder;
        if (encoder) {
          // End current render pass so the depth texture is available for reading
          context.endCurrentRenderPass?.();
          this._globeDepth.executeCopyDepth(encoder);
          // Resume default render pass for subsequent commands
          context.resumeDefaultRenderPass?.();
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

      // Pass 4-7: 3D Tiles passes
      this._execute3DTilePasses(frustumCommands, config);

      // Pass 8: OPAQUE
      this._executeOpaquePass(frustumCommands, config);

      // Pass 10: VOXELS
      this._executePassCommands(
        frustumCommands,
        Pass.VOXELS,
        scene,
        context,
        passState,
      );

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

      // Pass 9: TRANSLUCENT (with OIT if enabled)
      this._executeTranslucentPass(frustumCommands, config);

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
    const { scene, context, passState } = config;
    const view = scene._view;
    const { frustumCommandsList } = view;
    const numFrustums: number = frustumCommandsList.length;
    const { uniformState } = context;

    if (numFrustums === 0) {
      return;
    }

    // Get pick framebuffer from passState (set by WebGPUPickFramebuffer.begin())
    const pickFBORaw = passState?.framebuffer;
    const pickFBO = pickFBORaw as
      | (CesiumOpaqueFramebuffer & {
          _isWebGPUPickFBO?: boolean;
          colorView?: GPUTextureView;
          depthView?: GPUTextureView;
        })
      | undefined;
    if (!pickFBO || !pickFBO._isWebGPUPickFBO) {
      // No WebGPU pick framebuffer — fall back to rendering normally
      // (this shouldn't happen, but be safe)
      return;
    }

    const device: GPUDevice | undefined = context._device;
    const encoder: GPUCommandEncoder | undefined =
      context._currentCommandEncoder;
    if (!device || !encoder) {
      return;
    }

    // End the current render pass so we can start the pick render pass
    context.endCurrentRenderPass?.();

    // Create the pick render pass targeting the pick FBO textures
    const pickPassDescriptor: GPURenderPassDescriptor = {
      label: "Pick render pass",
      colorAttachments: [
        {
          view: pickFBO.colorView as GPUTextureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
      depthStencilAttachment: {
        view: pickFBO.depthView as GPUTextureView,
        depthClearValue: 1.0,
        depthLoadOp: "clear" as GPULoadOp,
        depthStoreOp: "store" as GPUStoreOp,
        stencilClearValue: 0,
        stencilLoadOp: "clear" as GPULoadOp,
        stencilStoreOp: "store" as GPUStoreOp,
      },
    };

    const pickRenderPass = encoder.beginRenderPass(pickPassDescriptor);

    // Set the pick render pass as the active pass on the context so that
    // executeWebGPUCommand() dispatches commands to it
    const savedRenderPass = context.currentRenderPassEncoder;
    context._currentRenderPassEncoder = pickRenderPass;

    // Execute all pickable passes across all frustums
    for (let i = 0; i < numFrustums; i++) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      const near = frustumCommands.near;
      const far = frustumCommands.far;
      this._updateFrustumUniforms(uniformState, near, far, scene);

      // Skip ENVIRONMENT pass — sky/sun/moon/atmosphere don't generate pick IDs

      // GLOBE pass
      this._executePickBatch(
        frustumCommands,
        Pass.GLOBE,
        scene,
        context,
        passState,
        pickRenderPass,
      );

      // 3D Tiles passes
      const tilePasses = [
        Pass.CESIUM_3D_TILE,
        Pass.CESIUM_3D_TILE_CLASSIFICATION,
      ];
      for (const passIndex of tilePasses) {
        this._executePickBatch(
          frustumCommands,
          passIndex,
          scene,
          context,
          passState,
          pickRenderPass,
        );
      }

      // OPAQUE pass
      this._executePickBatch(
        frustumCommands,
        Pass.OPAQUE,
        scene,
        context,
        passState,
        pickRenderPass,
      );

      // TRANSLUCENT pass
      this._executePickBatch(
        frustumCommands,
        Pass.TRANSLUCENT,
        scene,
        context,
        passState,
        pickRenderPass,
      );
    }

    pickRenderPass.end();

    // Restore the original render pass
    context._currentRenderPassEncoder = savedRenderPass;

    // Resume the default render pass if needed
    context.resumeDefaultRenderPass?.();
  }

  /**
   * Execute a batch of commands for a specific pass during pick rendering.
   * Commands are executed on the pick render pass encoder.
   */
  private _executePickBatch(
    frustumCommands: CesiumFrustumCommands,
    passIndex: number,
    scene: CesiumScene,
    context: WebGPUContext,
    passState: CesiumPassState,
    pickRenderPass: GPURenderPassEncoder,
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

      // Skip commands that don't participate in picking
      if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
        continue;
      }

      if (command.isWebGPUDrawCommand === true) {
        command.execute(pickRenderPass, context);
      } else if (command.execute) {
        command.execute(context, passState);
      }
    }
  }

  // --- Frustum state ---

  private _updateFrustumUniforms(
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
    const currentPass = context._currentRenderPassEncoder;
    const label: string = currentPass?.label ?? "";
    const colorTarget = this._sceneFramebuffer?.colorTarget;
    if (
      label === "Scene Framebuffer Render Pass" &&
      colorTarget &&
      context._currentCommandEncoder
    ) {
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
        const bundleEncoder = context._device.createRenderBundleEncoder({
          label: "Globe terrain bundle",
          colorFormats: [context.presentationFormat],
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
  ): void {
    const { scene, context, passState } = config;
    const passes = [
      Pass.CESIUM_3D_TILE_EDGES,
      Pass.CESIUM_3D_TILE,
      Pass.CESIUM_3D_TILE_CLASSIFICATION,
      Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
    ];
    // Indirect-draw fast path. Stays off until a tile renderer opts in
    // by setting `context.useIndirectDrawForTiles = true` after verifying
    // its commands hit the homogeneous-batch criteria in
    // `executeBatchIndirect` (shared pipeline + bind groups + index
    // buffer across runs of ≥2 commands). When the flag is off the loop
    // below is byte-for-byte identical to the previous behavior.
    const useIndirect =
      context.useIndirectDrawForTiles === true &&
      context.indirectDrawManager &&
      context.currentRenderPassEncoder;
    for (const passIndex of passes) {
      const cmds = frustumCommands.commands[passIndex];
      const cnt: number = frustumCommands.indices[passIndex];
      if (cnt > 0) {
        context.uniformState?.updatePass(passIndex);
        if (useIndirect) {
          executeBatchIndirect(cmds, cnt, scene, context, passState);
        } else {
          executeBatch(cmds, cnt, scene, context, passState);
        }
      }
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
    // This is correct for non-overlapping translucent geometry and has
    // minor ordering artifacts for overlapping geometry. To enable full OIT,
    // each feature renderer must create _oitPipeline variants with:
    //   1. Fragment targets: [{format:"rgba16float", blend:additive}, {format:"r8unorm", blend:product}]
    //   2. Fragment output: @location(0) weighted accumulation, @location(1) revealage
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
    const { scene, context } = config;
    const globe = scene.globe;

    // Get texture views needed by all environmental effects
    const colorView: GPUTextureView | undefined =
      context._sceneColorView ?? context.currentTextureView;
    const depthView: GPUTextureView | undefined = context._depthStencilView;
    const outputView: GPUTextureView | undefined = context.currentTextureView;

    if (!colorView || !depthView || !outputView) {
      return;
    }

    const frameState = scene._frameState;

    // 1. Procedural Clouds — volumetric ray-marched clouds
    if (globe?.showProceduralClouds) {
      const cloudFR = context.getFeatureRenderer(
        FeatureRendererKey.PROCEDURAL_CLOUDS,
      );
      if (cloudFR?.execute) {
        try {
          // End render pass so shaders can sample the depth texture
          context.endCurrentRenderPass?.();
          cloudFR.execute(
            context,
            frameState,
            colorView,
            depthView,
            outputView,
            globe,
          );
          context.resumeDefaultRenderPass?.();
        } catch (e: unknown) {
          context.log?.(
            "warn",
            `Procedural clouds failed: ${(e as Error).message}`,
          );
          context.resumeDefaultRenderPass?.();
        }
      }
    }

    // 2. Screen-Space Reflections — ray-marched reflections
    if (scene._enableSSR) {
      const ssrFR = context.getFeatureRenderer(
        FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
      );
      if (ssrFR?.execute) {
        try {
          context.endCurrentRenderPass?.();
          ssrFR.execute(
            context,
            frameState,
            colorView,
            depthView,
            undefined, // normalTextureView — uses placeholder
            outputView,
            scene,
          );
          context.resumeDefaultRenderPass?.();
        } catch (e: unknown) {
          context.log?.("warn", `SSR failed: ${(e as Error).message}`);
          context.resumeDefaultRenderPass?.();
        }
      }
    }

    // 3. Weather Particles — GPU compute rain/snow/fog/hail + render
    if (scene._enableWeather) {
      const weatherFR = context.getFeatureRenderer(
        FeatureRendererKey.WEATHER_PARTICLES,
      );
      if (weatherFR?.update) {
        try {
          // Compute simulation (needs own command encoder)
          weatherFR.update(context, frameState, scene);

          // Render particles into the current scene render pass
          if (weatherFR.render) {
            const passEncoder = context.currentRenderPassEncoder;
            if (passEncoder) {
              weatherFR.render(context, frameState, scene, passEncoder);
            }
          }
        } catch (e: unknown) {
          context.log?.(
            "warn",
            `Weather update failed: ${(e as Error).message}`,
          );
        }
      }
    }

    // 4. Volumetric fog — Phase 5a infrastructure (no visual change).
    // Runs the three compute passes that populate the froxel grid (Phase
    // 5a kernels are placeholders that clear their outputs), then the
    // composite pass that samples the integrated 3D volume in screen UV +
    // linearized depth and writes the modulated scene color back. Per
    // B22, this runs AFTER opaque + OIT-resolved color and after the
    // other environmental effects, BEFORE post-processing.
    //
    // Gated on `atmosphericConditions.volumetricFog.enabled` (B18:
    // default FALSE) — the entire path is skipped when the toggle is
    // off, so unsubscribed users pay zero cost.
    const ac = frameState.atmosphericConditions;
    const vf = ac && ac.volumetricFog ? ac.volumetricFog : undefined;
    if (vf?.enabled === true) {
      const fogFR = context.getFeatureRenderer(
        FeatureRendererKey.VOLUMETRIC_FOG,
      );
      if (fogFR?.update) {
        try {
          context.endCurrentRenderPass?.();
          fogFR.update(context, frameState, scene);
          if (fogFR.composite) {
            const fmt: GPUTextureFormat =
              context.presentationFormat || "bgra8unorm";
            fogFR.composite(
              context,
              frameState,
              colorView,
              depthView,
              outputView,
              fmt,
            );
          }
          context.resumeDefaultRenderPass?.();
        } catch (e: unknown) {
          context.log?.(
            "warn",
            `Volumetric fog failed: ${(e as Error).message}`,
          );
          context.resumeDefaultRenderPass?.();
        }
      }
    }
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
      this._postProcess.execute(
        encoder,
        sourceView,
        targetView,
        depthView,
        sceneColorTexture,
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
