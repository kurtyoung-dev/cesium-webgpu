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
 *   3. Execute ENVIRONMENT pass (skybox, sun, moon, atmosphere)
 *   4. Execute COMPUTE pass
 *   5. Execute GLOBE pass commands → GlobeDepth framebuffer
 *   6. Copy depth for shader access
 *   7. Execute TERRAIN_CLASSIFICATION pass
 *   8. Execute CESIUM_3D_TILE* passes
 *   9. Execute OPAQUE pass → main framebuffer
 *   10. Execute TRANSLUCENT pass → OIT framebuffer
 *   11. OIT composite over opaque
 *   12. Execute VOXELS, GAUSSIAN_SPLATS
 *
 * After frustum loop:
 *   - Execute OVERLAY pass (once)
 *   - Render depth plane (if enabled)
 *   - Run post-processing pipeline (if enabled)
 *
 * @private
 */

import Pass from "../../Renderer/Pass.js";
import { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import { WebGPUOIT } from "./WebGPUOIT.js";
import { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import { WebGPUDepthPlane } from "./WebGPUDepthPlane.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { WebGPUDerivedCommand } from "./WebGPUDerivedCommand.js";

/**
 * Configuration for a single frame's rendering.
 */
export interface WebGPURenderFrameConfig {
  scene: any;
  context: any;
  passState: any;
  backgroundColor: { red: number; green: number; blue: number; alpha: number };
  picking: boolean;
  useGlobeDepthFramebuffer: boolean;
  clearGlobeDepth: boolean;
  useOIT: boolean;
  useDepthPlane: boolean;
  useInvertClassification: boolean;
  usePostProcessing?: boolean;
  hdr?: boolean;
}

// --------------- Module-level helpers ---------------

function executeWebGPUCommand(
  command: any,
  scene: any,
  context: any,
  passState: any,
): void {
  if (scene.debugCommandFilter && !scene.debugCommandFilter(command)) {
    return;
  }
  if (command.execute && !command.isWebGPUDrawCommand) {
    command.execute(context, passState);
    return;
  }
  if (command.isWebGPUDrawCommand === true) {
    const renderPass = context.currentRenderPassEncoder;
    if (renderPass) {
      command.execute(renderPass, context);
    }
    return;
  }
}

function executeBatch(
  commands: any[],
  count: number,
  scene: any,
  context: any,
  passState: any,
): void {
  for (let i = 0; i < count; i++) {
    executeWebGPUCommand(commands[i], scene, context, passState);
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
  private _initialized: boolean = false;
  private _width: number = 0;
  private _height: number = 0;

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
    const hdr = config.hdr ?? false;

    // Scene framebuffer (main color + depth + ID targets)
    if (!this._sceneFramebuffer) {
      this._sceneFramebuffer = new WebGPUSceneFramebuffer();
    }
    if (!this._initialized || needsResize) {
      const numSamples: number = context._msaaSamples ?? 1;
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      // SCENE-2 fix: pass all 6 arguments including hdr
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
      // SCENE-3 fix: call update() not initialize() — matches WebGPUOIT's actual API
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
      this._depthPlane.initialize(device, depthFormat);
    }

    // Post-processing pipeline
    if (config.usePostProcessing && !this._postProcess) {
      this._postProcess = new WebGPUPostProcessPipeline();
      const canvasFormat: GPUTextureFormat =
        context.presentationFormat ?? "bgra8unorm";
      this._postProcess.initialize(device, width, height, canvasFormat);
      // Add default stages
      this._postProcess.addTonemapping(device, canvasFormat);
      this._postProcess.addFXAA(device, canvasFormat);
    }
    if (this._postProcess && needsResize) {
      this._postProcess.resize(width, height);
    }

    this._width = width;
    this._height = height;
    this._initialized = true;
  }

  // --- Main entry point ---

  executeCommands(config: WebGPURenderFrameConfig): void {
    const { scene, context, passState, picking } = config;
    const view = scene._view;
    const { frustumCommandsList } = view;
    const numFrustums: number = frustumCommandsList.length;
    const { uniformState } = context;

    if (numFrustums === 0) {
      return;
    }

    // Ensure rendering resources are created/sized
    this._ensureResources(config);

    // --- Multi-frustum loop: iterate from far to near ---
    for (let frustumIndex = 0; frustumIndex < numFrustums; frustumIndex++) {
      const frustumCommands = frustumCommandsList[frustumIndex];

      this._updateFrustumUniforms(
        uniformState,
        frustumCommands.near,
        frustumCommands.far,
        scene,
      );

      if (frustumIndex > 0 || config.clearGlobeDepth) {
        this._clearDepthStencil(context);
      }

      // SCENE-1 fix: Pass 0 — ENVIRONMENT (skybox, sun, moon, atmosphere)
      // In WebGL's Scene.js, environment is rendered per-frustum for correct depth.
      this._executePassCommands(
        frustumCommands,
        Pass.ENVIRONMENT,
        scene,
        context,
        passState,
      );

      // Pass 1: COMPUTE
      this._executePassCommands(
        frustumCommands,
        Pass.COMPUTE,
        scene,
        context,
        passState,
      );

      // Pass 2: GLOBE (with globe depth framebuffer if available)
      this._executeGlobePass(frustumCommands, config);

      // Pass 3: TERRAIN_CLASSIFICATION
      this._executePassCommands(
        frustumCommands,
        Pass.TERRAIN_CLASSIFICATION,
        scene,
        context,
        passState,
      );

      // Pass 4-7: 3D Tiles passes
      this._execute3DTilePasses(frustumCommands, config);

      // Pass 8: OPAQUE
      this._executeOpaquePass(frustumCommands, config);

      // Pass 9: TRANSLUCENT (with OIT if enabled)
      this._executeTranslucentPass(frustumCommands, config);

      // Pass 10: VOXELS
      this._executePassCommands(
        frustumCommands,
        Pass.VOXELS,
        scene,
        context,
        passState,
      );

      // Pass 11: GAUSSIAN_SPLATS
      this._executePassCommands(
        frustumCommands,
        Pass.GAUSSIAN_SPLATS,
        scene,
        context,
        passState,
      );
    }

    // Pass 12: OVERLAY (runs once, not per-frustum)
    this._executeOverlayPass(frustumCommandsList, config);

    // Depth plane (if enabled, renders after all frustums)
    this._renderDepthPlane(config);

    // Post-processing (tonemapping, FXAA, etc.)
    this._runPostProcessing(config);
  }

  // --- Frustum state ---

  private _updateFrustumUniforms(
    uniformState: any,
    near: number,
    far: number,
    scene: any,
  ): void {
    const camera = scene._frameState.camera;
    if (camera.frustum.near !== undefined) {
      camera.frustum.near = near;
      camera.frustum.far = far;
      uniformState.updateFrustum(camera.frustum);
    }
    // Log depth values are computed inside updateFrustum() when it sets
    // _farDepthFromNearPlusOne and _log2FarDepthFromNearPlusOne.
    // No separate updateLogDepth call is needed.
  }

  private _clearDepthStencil(context: any): void {
    context.clear({ depth: true, stencil: true, color: false });
  }

  // --- Globe pass (with GlobeDepth integration) ---

  private _executeGlobePass(
    frustumCommands: any,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const commands = frustumCommands.commands[Pass.GLOBE];
    const count: number = frustumCommands.indices[Pass.GLOBE];
    if (count === 0) {
      return;
    }

    // When globe depth is available, globe renders to its own framebuffer
    // so depth can be sampled in subsequent passes (terrain clamping, picking)
    if (this._globeDepth && config.useGlobeDepthFramebuffer) {
      // Future: switch render target to globe depth FBO
      executeBatch(commands, count, scene, context, passState);
      // Future: copy depth for shader access
      return;
    }

    executeBatch(commands, count, scene, context, passState);
  }

  // --- 3D Tiles passes ---

  private _execute3DTilePasses(
    frustumCommands: any,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const passes = [
      Pass.CESIUM_3D_TILE_EDGES,
      Pass.CESIUM_3D_TILE,
      Pass.CESIUM_3D_TILE_CLASSIFICATION,
      Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
    ];
    for (const passIndex of passes) {
      const cmds = frustumCommands.commands[passIndex];
      const cnt: number = frustumCommands.indices[passIndex];
      if (cnt > 0) {
        executeBatch(cmds, cnt, scene, context, passState);
      }
    }
  }

  // --- Opaque pass ---

  private _executeOpaquePass(
    frustumCommands: any,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const commands = frustumCommands.commands[Pass.OPAQUE];
    const count: number = frustumCommands.indices[Pass.OPAQUE];
    if (count === 0) {
      return;
    }
    executeBatch(commands, count, scene, context, passState);
  }

  // --- Translucent pass (with OIT integration) ---

  private _executeTranslucentPass(
    frustumCommands: any,
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const commands = frustumCommands.commands[Pass.TRANSLUCENT];
    const count: number = frustumCommands.indices[Pass.TRANSLUCENT];
    if (count === 0) {
      return;
    }

    if (this._oit && config.useOIT && !config.picking) {
      // OIT accumulation pass: render translucent geometry with
      // additive blending into accumulation + revealage textures
      const encoder: GPUCommandEncoder | undefined =
        context._currentCommandEncoder;
      if (encoder && this._oit.getAccumulationPassDescriptor) {
        // Get the depth-stencil view from scene framebuffer for depth testing
        const depthView =
          this._sceneFramebuffer?.depthStencilTexture?.createView();
        if (depthView) {
          const passDesc = this._oit.getAccumulationPassDescriptor(depthView);
          if (passDesc) {
            // End the current render pass before starting OIT pass
            context.endCurrentRenderPass?.();
            const oitPass = encoder.beginRenderPass(passDesc);
            for (let i = 0; i < count; i++) {
              const cmd = commands[i];
              if (cmd.isWebGPUDrawCommand) {
                cmd.execute(oitPass);
              }
            }
            oitPass.end();
          }
        }

        // Composite OIT result over the opaque scene
        const canvasView: GPUTextureView | undefined =
          context.currentTextureView;
        const canvasFormat: GPUTextureFormat =
          context.presentationFormat ?? "bgra8unorm";
        if (canvasView && encoder) {
          this._oit.executeComposite(encoder, canvasView, canvasFormat);
        }

        // Resume default render pass
        context.resumeDefaultRenderPass?.();
        return;
      }
    }

    // Fallback: render translucent commands directly (no OIT)
    executeBatch(commands, count, scene, context, passState);
  }

  // --- Overlay pass ---

  private _executeOverlayPass(
    frustumCommandsList: any[],
    config: WebGPURenderFrameConfig,
  ): void {
    const { scene, context, passState } = config;
    const lastFrustum = frustumCommandsList[frustumCommandsList.length - 1];
    if (!lastFrustum) {
      return;
    }
    const commands = lastFrustum.commands[Pass.OVERLAY];
    const count: number = lastFrustum.indices[Pass.OVERLAY];
    if (count === 0) {
      return;
    }
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

    // Update depth plane geometry based on camera
    this._depthPlane.update(scene._frameState, device);

    // Execute depth plane draw into the active render pass
    const renderPass: GPURenderPassEncoder | undefined =
      context.currentRenderPassEncoder;
    if (renderPass) {
      this._depthPlane.execute(renderPass);
    }
  }

  // --- Post-processing ---

  private _runPostProcessing(config: WebGPURenderFrameConfig): void {
    if (!this._postProcess || !config.usePostProcessing) {
      return;
    }
    const { context } = config;
    const device: GPUDevice | undefined = context._device;
    if (!device) {
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

    if (encoder && sourceView && targetView) {
      this._postProcess.execute(encoder, sourceView, targetView);
    }

    // Resume the default render pass for any subsequent operations
    context.resumeDefaultRenderPass?.();
  }

  // --- Pass helper ---

  private _executePassCommands(
    frustumCommands: any,
    passIndex: number,
    scene: any,
    context: any,
    passState: any,
  ): void {
    const commands = frustumCommands.commands[passIndex];
    const count: number = frustumCommands.indices[passIndex];
    if (count === 0) {
      return;
    }
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
    baseCommand: any,
    type: string,
    context: any,
  ): any {
    switch (type) {
      case "depthOnly":
        return WebGPUDerivedCommand.createDepthOnlyDerivedCommand(
          baseCommand,
          context,
        );
      case "logDepth":
        return WebGPUDerivedCommand.createLogDepthCommand(baseCommand);
      case "pick":
        return WebGPUDerivedCommand.createPickDerivedCommand(
          baseCommand,
          context,
        );
      case "hdr":
        return WebGPUDerivedCommand.createHDRDerivedCommand(
          baseCommand,
          context,
        );
      case "shadow":
        return WebGPUDerivedCommand.createShadowDerivedCommand(
          baseCommand,
          context,
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
}
