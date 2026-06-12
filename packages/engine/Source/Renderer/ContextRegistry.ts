/**
 * Tracks all active GraphicsContext instances across the application.
 * Supports multi-view and split-screen scenarios where multiple rendering
 * contexts (WebGL, WebGPU, or mixed) run simultaneously.
 *
 * This is a singleton managed as a static property on GraphicsContext.
 * Access via `GraphicsContext.registry` or `scene.contextRegistry`.
 *
 * @example
 * // Get all active contexts
 * const allContexts = GraphicsContext.registry.all;
 *
 * // Get all WebGPU contexts
 * const webgpuContexts = GraphicsContext.registry.getByType(RendererType.WEBGPU);
 *
 * // Check if any WebGPU context is running
 * if (GraphicsContext.registry.hasType(RendererType.WEBGPU)) { ... }
 * @module ContextRegistry
 */

import RendererType from "./RendererType.js";

/**
 * Interface that registered contexts must satisfy.
 * Kept minimal to avoid circular dependency with GraphicsContext.
 */
export interface RegistrableContext {
  readonly id: string;
  readonly rendererType: RendererType;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
}

/**
 * Registry that tracks all active GraphicsContext instances.
 * Supports multi-context, multi-view, and mixed-backend scenarios.
 */
export class ContextRegistry {
  private _contexts: Map<string, RegistrableContext> = new Map();
  private _primaryId: string | null = null;
  private _listeners: Array<
    (event: RegistryEvent, context: RegistrableContext) => void
  > = [];

  /**
   * Register a context when it is created.
   * The first registered context becomes the primary by default.
   *
   * @param context - The context to register
   */
  register(context: RegistrableContext): void {
    if (this._contexts.has(context.id)) {
      return; // Already registered
    }
    this._contexts.set(context.id, context);

    // First context becomes primary by default
    if (this._primaryId === null) {
      this._primaryId = context.id;
    }

    this._notifyListeners("register", context);
  }

  /**
   * Unregister a context when it is destroyed.
   *
   * @param id - The unique ID of the context to unregister
   */
  unregister(id: string): void {
    const context = this._contexts.get(id);
    if (!context) {
      return;
    }
    this._contexts.delete(id);

    // If the primary was removed, pick the next available
    if (this._primaryId === id) {
      const next = this._contexts.keys().next();
      this._primaryId = next.done ? null : next.value;
    }

    this._notifyListeners("unregister", context);
  }

  /**
   * Get the primary (default) context.
   * This is typically the first context created.
   */
  get primary(): RegistrableContext | undefined {
    if (this._primaryId === null) {
      return undefined;
    }
    return this._contexts.get(this._primaryId);
  }

  /**
   * Set a specific context as the primary.
   *
   * @param id - The ID of the context to set as primary
   */
  setPrimary(id: string): void {
    if (this._contexts.has(id)) {
      this._primaryId = id;
    }
  }

  /**
   * Get a specific context by its unique ID.
   *
   * @param id - The context ID to look up
   * @returns The context, or undefined if not found
   */
  get(id: string): RegistrableContext | undefined {
    return this._contexts.get(id);
  }

  /**
   * Get all active contexts as a read-only Map.
   */
  get all(): ReadonlyMap<string, RegistrableContext> {
    return this._contexts;
  }

  /**
   * Get the number of active contexts.
   */
  get count(): number {
    return this._contexts.size;
  }

  /**
   * Get all contexts of a specific renderer type.
   *
   * @param type - The renderer type to filter by
   * @returns Array of matching contexts
   */
  getByType(type: RendererType): RegistrableContext[] {
    const result: RegistrableContext[] = [];
    for (const ctx of this._contexts.values()) {
      if (ctx.rendererType === type) {
        result.push(ctx);
      }
    }
    return result;
  }

  /**
   * Check if any context of a given type is currently active.
   *
   * @param type - The renderer type to check
   * @returns True if at least one context of the given type exists
   */
  hasType(type: RendererType): boolean {
    for (const ctx of this._contexts.values()) {
      if (ctx.rendererType === type) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add a listener for registry events (register/unregister).
   *
   * @param listener - Callback invoked when contexts are added or removed
   * @returns A function that removes the listener when called
   */
  addListener(
    listener: (event: RegistryEvent, context: RegistrableContext) => void,
  ): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Get a diagnostic summary of all active contexts.
   * Useful for debugging and logging.
   */
  getDiagnostics(): ContextDiagnostics[] {
    const results: ContextDiagnostics[] = [];
    for (const [id, ctx] of this._contexts) {
      results.push({
        id,
        rendererType: ctx.rendererType,
        isPrimary: id === this._primaryId,
        canvasId:
          ctx.canvas instanceof HTMLCanvasElement
            ? ctx.canvas.id || "(unnamed)"
            : "(offscreen)",
      });
    }
    return results;
  }

  /**
   * Get a human-readable formatted diagnostics string for all active contexts.
   * Suitable for logging to console or displaying in debug UIs.
   *
   * @returns A multi-line string summarizing all active contexts
   *
   * @example
   * console.log(GraphicsContext.registry.getFormattedDiagnostics());
   * // Output:
   * // [CesiumJS:ContextRegistry] 2 active context(s):
   * //   * ctx-a3f7 [webgpu] canvas="cesium-left" (primary)
   * //     ctx-9b2e [webgl]  canvas="cesium-right"
   */
  getFormattedDiagnostics(): string {
    const diags = this.getDiagnostics();
    if (diags.length === 0) {
      return "[CesiumJS:ContextRegistry] No active contexts";
    }
    const lines = [
      `[CesiumJS:ContextRegistry] ${diags.length} active context(s):`,
    ];
    for (const d of diags) {
      const primary = d.isPrimary ? " (primary)" : "";
      const shortId = d.id.substring(0, 8);
      const type = d.rendererType.padEnd(6);
      lines.push(
        `  ${d.isPrimary ? "*" : " "} ${shortId} [${type}] canvas="${d.canvasId}"${primary}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Dump diagnostics for all active contexts to the console.
   * Includes context IDs, renderer types, canvas info, and primary status.
   *
   * This is a convenience method for quick debugging — equivalent to:
   * `console.log(registry.getFormattedDiagnostics())`
   *
   * @param level - Console log level. Defaults to 'info'.
   */
  dumpDiagnostics(level: "info" | "warn" | "error" = "info"): void {
    const formatted = this.getFormattedDiagnostics();
    switch (level) {
      case "info":
        console.log(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
        console.error(formatted);
        break;
    }
  }

  /**
   * Iterator support — iterate over all contexts.
   */
  [Symbol.iterator](): Iterator<[string, RegistrableContext]> {
    return this._contexts[Symbol.iterator]();
  }

  /**
   * Notify all listeners of a registry event.
   * @private
   */
  private _notifyListeners(
    event: RegistryEvent,
    context: RegistrableContext,
  ): void {
    for (const listener of this._listeners) {
      try {
        listener(event, context);
      } catch (e) {
        console.error(
          `[CesiumJS:ContextRegistry] Listener error on ${event}:`,
          e,
        );
      }
    }
  }
}

/**
 * Registry event types.
 */
export type RegistryEvent = "register" | "unregister";

/**
 * Diagnostic information about a single context.
 */
export interface ContextDiagnostics {
  id: string;
  rendererType: RendererType;
  isPrimary: boolean;
  canvasId: string;
}

export default ContextRegistry;
