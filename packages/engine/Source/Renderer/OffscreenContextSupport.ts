/**
 * @module OffscreenContextSupport
 *
 * Strategy C: OffscreenCanvas in WebWorker for Background Rendering.
 *
 * Enables a secondary rendering context to operate on an OffscreenCanvas
 * within a WebWorker, freeing the main thread for primary view rendering.
 * This is an opt-in feature — disabled by default, enabled via constructor
 * parameter `useOffscreenCanvas: true`.
 *
 * ## Supported Scenarios
 * - **WebGL in OffscreenCanvas Worker**: Well-supported across browsers
 * - **WebGPU in OffscreenCanvas Worker**: Experimental; Chrome 113+ supports
 *   WebGPU in dedicated workers, Safari/Firefox support is evolving
 *
 * ## Architecture
 * ```
 * Main Thread                          WebWorker
 * ┌─────────────────────┐              ┌──────────────────────┐
 * │ Primary View         │              │ OffscreenCanvas       │
 * │ (full quality)       │   transfer   │ (reduced quality)     │
 * │ HTMLCanvasElement     │ ←──────────→ │ OffscreenCanvas       │
 * │                      │   ImageBitmap │ Rendering context     │
 * └─────────────────────┘              └──────────────────────┘
 * ```
 *
 * ## Usage
 * ```typescript
 * // Enable offscreen rendering for a secondary view
 * const support = new OffscreenContextSupport({
 *   width: 640,
 *   height: 480,
 *   rendererType: 'webgl', // or 'webgpu'
 * });
 *
 * // Start the worker
 * await support.initialize();
 *
 * // Render a frame (worker does the GPU work)
 * const frameBitmap = await support.renderFrame(frameData);
 *
 * // Display the result on the main thread
 * mainCtx.drawImage(frameBitmap, 0, 0);
 *
 * // Cleanup
 * support.destroy();
 * ```
 *
 * @see SharedResourcePool
 * @see WebGPUDevicePool
 * @see ContextRegistry
 */

import RendererType from "./RendererType.js";

/**
 * Check if OffscreenCanvas is supported in the current environment.
 */
export function isOffscreenCanvasSupported(): boolean {
  return typeof OffscreenCanvas !== "undefined";
}

/**
 * Check if OffscreenCanvas can be transferred to a WebWorker.
 */
export function isOffscreenCanvasTransferSupported(): boolean {
  if (typeof HTMLCanvasElement === "undefined") {
    return false;
  }
  return (
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
  );
}

/**
 * Options for OffscreenContextSupport.
 */
export interface OffscreenContextOptions {
  /**
   * Width of the offscreen canvas in pixels.
   */
  width: number;

  /**
   * Height of the offscreen canvas in pixels.
   */
  height: number;

  /**
   * Which renderer to use in the worker.
   * @default RendererType.WEBGL
   */
  rendererType?: RendererType;

  /**
   * Path to the worker script.
   * Defaults to a built-in minimal rendering worker.
   */
  workerScriptUrl?: string;

  /**
   * Whether to use a lower level-of-detail in the offscreen renderer.
   * Reduces GPU load for secondary views.
   * @default true
   */
  reducedLOD?: boolean;

  /**
   * Maximum frames per second for the offscreen renderer.
   * Lower values reduce CPU/GPU usage for background rendering.
   * @default 30
   */
  maxFPS?: number;
}

/**
 * State of the offscreen context.
 */
export type OffscreenState =
  | "idle"
  | "initializing"
  | "ready"
  | "rendering"
  | "error"
  | "destroyed";

/**
 * Messages sent to the offscreen worker.
 */
export interface WorkerMessage {
  type: "init" | "render" | "resize" | "destroy";
  payload?: Record<string, unknown>;
}

/**
 * Messages received from the offscreen worker.
 */
export interface WorkerResponse {
  type: "initialized" | "frame" | "error";
  payload?: unknown;
}

/**
 * Manages an OffscreenCanvas rendering context in a WebWorker.
 *
 * This is an opt-in feature for secondary views (minimaps, picture-in-picture,
 * background rendering). The primary view always renders on the main thread.
 *
 * Both WebGL and WebGPU backends support OffscreenCanvas, but WebGPU support
 * in workers is still experimental in some browsers.
 */
export class OffscreenContextSupport {
  private _state: OffscreenState = "idle";
  private _worker: Worker | null = null;
  private _canvas: OffscreenCanvas | null = null;
  private _options: Required<OffscreenContextOptions>;
  private _pendingFrameResolve: ((bitmap: ImageBitmap) => void) | null = null;
  private _pendingFrameReject: ((error: Error) => void) | null = null;
  private _lastError: string | null = null;

  /**
   * Create a new OffscreenContextSupport instance.
   *
   * @param options - Configuration for the offscreen canvas
   */
  constructor(options: OffscreenContextOptions) {
    this._options = {
      width: options.width,
      height: options.height,
      rendererType: options.rendererType ?? RendererType.WEBGL,
      workerScriptUrl: options.workerScriptUrl ?? "",
      reducedLOD: options.reducedLOD ?? true,
      maxFPS: options.maxFPS ?? 30,
    };
  }

  /**
   * Current state of the offscreen context.
   */
  get state(): OffscreenState {
    return this._state;
  }

  /**
   * Whether the offscreen context is ready to render.
   */
  get isReady(): boolean {
    return this._state === "ready";
  }

  /**
   * The renderer type used by this offscreen context.
   */
  get rendererType(): RendererType {
    return this._options.rendererType;
  }

  /**
   * Last error message, if any.
   */
  get lastError(): string | null {
    return this._lastError;
  }

  /**
   * Initialize the offscreen canvas and worker.
   * Creates an OffscreenCanvas and transfers it to a dedicated WebWorker.
   *
   * @returns Promise that resolves when the worker is ready to render
   * @throws Error if OffscreenCanvas is not supported
   */
  async initialize(): Promise<void> {
    if (!isOffscreenCanvasSupported()) {
      throw new Error(
        "OffscreenCanvas is not supported in this browser. " +
          "OffscreenContextSupport requires OffscreenCanvas for background rendering.",
      );
    }

    this._state = "initializing";

    try {
      // Create the offscreen canvas
      this._canvas = new OffscreenCanvas(
        this._options.width,
        this._options.height,
      );

      // Create the worker
      if (this._options.workerScriptUrl) {
        this._worker = new Worker(this._options.workerScriptUrl, {
          type: "module",
        });
      } else {
        // Create an inline worker with minimal rendering capability
        this._worker = this._createInlineWorker();
      }

      // Set up message handling
      this._setupWorkerHandlers();

      // Transfer the canvas to the worker and initialize
      await this._initializeWorker();

      this._state = "ready";
    } catch (error: unknown) {
      this._state = "error";
      this._lastError =
        (error instanceof Error ? error.message : undefined) ?? String(error);
      throw error;
    }
  }

  /**
   * Request the worker to render a frame.
   *
   * @param frameData - Serializable frame data (camera position, entities, etc.)
   * @returns Promise that resolves with the rendered ImageBitmap
   */
  async renderFrame(frameData: Record<string, unknown>): Promise<ImageBitmap> {
    if (this._state !== "ready") {
      throw new Error(
        `Cannot render: offscreen context is in '${this._state}' state.`,
      );
    }

    if (!this._worker) {
      throw new Error("Worker not initialized.");
    }

    this._state = "rendering";

    return new Promise<ImageBitmap>((resolve, reject) => {
      this._pendingFrameResolve = resolve;
      this._pendingFrameReject = reject;

      const message: WorkerMessage = {
        type: "render",
        payload: frameData,
      };

      this._worker!.postMessage(message);
    });
  }

  /**
   * Resize the offscreen canvas.
   *
   * @param width - New width in pixels
   * @param height - New height in pixels
   */
  resize(width: number, height: number): void {
    this._options.width = width;
    this._options.height = height;

    if (this._canvas) {
      this._canvas.width = width;
      this._canvas.height = height;
    }

    if (this._worker && this._state === "ready") {
      const message: WorkerMessage = {
        type: "resize",
        payload: { width, height },
      };
      this._worker.postMessage(message);
    }
  }

  /**
   * Destroy the offscreen context and terminate the worker.
   */
  destroy(): void {
    if (this._worker) {
      const message: WorkerMessage = { type: "destroy" };
      this._worker.postMessage(message);
      this._worker.terminate();
      this._worker = null;
    }

    this._canvas = null;
    this._state = "destroyed";
    this._pendingFrameResolve = null;
    this._pendingFrameReject = null;
  }

  /**
   * Check if this offscreen context has been destroyed.
   */
  isDestroyed(): boolean {
    return this._state === "destroyed";
  }

  /**
   * Create an inline worker using a Blob URL.
   * This provides minimal rendering capability without a separate script file.
   * @private
   */
  private _createInlineWorker(): Worker {
    const workerCode = `
      let canvas = null;
      let ctx = null;
      let rendererType = 'webgl';

      self.onmessage = async function(e) {
        const { type, payload } = e.data;

        switch (type) {
          case 'init': {
            canvas = payload.canvas;
            rendererType = payload.rendererType || 'webgl';

            if (rendererType === 'webgpu' && navigator.gpu) {
              // WebGPU in worker (experimental)
              try {
                const adapter = await navigator.gpu.requestAdapter();
                const device = await adapter.requestDevice();
                ctx = canvas.getContext('webgpu');
                ctx.configure({
                  device,
                  format: navigator.gpu.getPreferredCanvasFormat(),
                });
                self.postMessage({ type: 'initialized', payload: { rendererType: 'webgpu' } });
              } catch (err) {
                // Fallback to WebGL
                ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
                self.postMessage({ type: 'initialized', payload: { rendererType: 'webgl', fallback: true } });
              }
            } else {
              ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
              self.postMessage({ type: 'initialized', payload: { rendererType: 'webgl' } });
            }
            break;
          }

          case 'render': {
            // Minimal render — clear with background color
            if (ctx && ctx.clearColor) {
              // WebGL path
              ctx.clearColor(0.0, 0.0, 0.0, 1.0);
              ctx.clear(ctx.COLOR_BUFFER_BIT | ctx.DEPTH_BUFFER_BIT);
            }
            // Transfer the rendered frame back
            const bitmap = canvas.transferToImageBitmap();
            self.postMessage({ type: 'frame', payload: bitmap }, [bitmap]);
            break;
          }

          case 'resize': {
            if (canvas) {
              canvas.width = payload.width;
              canvas.height = payload.height;
            }
            break;
          }

          case 'destroy': {
            canvas = null;
            ctx = null;
            self.close();
            break;
          }
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    // Clean up the blob URL after the worker is created
    URL.revokeObjectURL(url);

    return worker;
  }

  /**
   * Set up message handlers for the worker.
   * @private
   */
  private _setupWorkerHandlers(): void {
    if (!this._worker) {
      return;
    }

    this._worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { type, payload } = e.data;

      switch (type) {
        case "initialized":
          // Worker is ready — initialization promise will resolve
          break;

        case "frame":
          if (this._pendingFrameResolve) {
            this._state = "ready";
            this._pendingFrameResolve(payload as ImageBitmap);
            this._pendingFrameResolve = null;
            this._pendingFrameReject = null;
          }
          break;

        case "error":
          this._lastError =
            ((payload as Record<string, unknown> | undefined)
              ?.message as string) ?? "Unknown worker error";
          if (this._pendingFrameReject) {
            this._state = "error";
            this._pendingFrameReject(new Error(this._lastError!));
            this._pendingFrameResolve = null;
            this._pendingFrameReject = null;
          }
          break;
      }
    };

    this._worker.onerror = (e: ErrorEvent) => {
      this._lastError = e.message ?? "Worker error";
      this._state = "error";
      if (this._pendingFrameReject) {
        this._pendingFrameReject(new Error(this._lastError));
        this._pendingFrameResolve = null;
        this._pendingFrameReject = null;
      }
    };
  }

  /**
   * Transfer the offscreen canvas to the worker and initialize rendering.
   * @private
   */
  private async _initializeWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._worker || !this._canvas) {
        reject(new Error("Worker or canvas not created."));
        return;
      }

      const handler = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === "initialized") {
          this._worker!.removeEventListener(
            "message",
            handler as EventListener,
          );
          resolve();
        } else if (e.data.type === "error") {
          this._worker!.removeEventListener(
            "message",
            handler as EventListener,
          );
          reject(
            new Error(
              ((e.data.payload as Record<string, unknown> | undefined)
                ?.message as string) ?? "Worker init failed",
            ),
          );
        }
      };

      this._worker.addEventListener("message", handler as EventListener);

      // Transfer the canvas to the worker
      const message: WorkerMessage = {
        type: "init",
        payload: {
          canvas: this._canvas,
          rendererType: this._options.rendererType,
          reducedLOD: this._options.reducedLOD,
          maxFPS: this._options.maxFPS,
        },
      };

      this._worker.postMessage(message, [this._canvas as Transferable]);
    });
  }

  /**
   * Get diagnostic info about this offscreen context.
   */
  getDiagnostics(): {
    state: OffscreenState;
    rendererType: RendererType;
    width: number;
    height: number;
    lastError: string | null;
  } {
    return {
      state: this._state,
      rendererType: this._options.rendererType,
      width: this._options.width,
      height: this._options.height,
      lastError: this._lastError,
    };
  }
}

export default OffscreenContextSupport;
