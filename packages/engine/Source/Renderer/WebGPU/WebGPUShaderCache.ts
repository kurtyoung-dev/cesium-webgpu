/**
 * WebGPUShaderCache.ts
 * Manages WebGPU shader modules with caching and lazy loading
 * Provides efficient shader compilation and reuse across the renderer
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";

/**
 * Shader cache entry containing the compiled shader module and metadata
 */
interface ShaderCacheEntry {
  module: GPUShaderModule;
  code: string;
  entryPoints: {
    vertex?: string;
    fragment?: string;
    compute?: string;
  };
  timestamp: number;
}

/**
 * Shader descriptor for creating or retrieving shader modules
 */
export interface ShaderDescriptor {
  /** Unique identifier for the shader */
  name: string;
  /** WGSL shader code */
  code: string;
  /** Entry point names */
  entryPoints?: {
    vertex?: string;
    fragment?: string;
    compute?: string;
  };
  /** Optional label for debugging */
  label?: string;
}

/**
 * Manages WebGPU shader modules with caching
 *
 * Features:
 * - Automatic caching of compiled shaders
 * - Lazy loading and compilation
 * - Built-in shader library support
 * - Cache statistics and management
 *
 * @example
 * const cache = new WebGPUShaderCache(device);
 * const shader = await cache.getShader({
 *   name: 'PhongLighting',
 *   code: phongShaderCode,
 *   entryPoints: { vertex: 'vertexMain', fragment: 'fragmentMain' }
 * });
 */
export class WebGPUShaderCache {
  private _device: GPUDevice;
  private _cache: Map<string, ShaderCacheEntry>;
  private _pendingCompilations: Map<string, Promise<GPUShaderModule>>;

  // Statistics
  private _stats = {
    hits: 0,
    misses: 0,
    compilations: 0,
    errors: 0,
  };

  /**
   * Creates a new shader cache
   * @param device - WebGPU device for shader compilation
   */
  constructor(device: GPUDevice) {
    if (!defined(device)) {
      throw new DeveloperError("device is required");
    }

    this._device = device;
    this._cache = new Map();
    this._pendingCompilations = new Map();
  }

  /**
   * Get or compile a shader module
   * @param descriptor - Shader descriptor
   * @returns The compiled shader module
   */
  async getShader(descriptor: ShaderDescriptor): Promise<GPUShaderModule> {
    if (!defined(descriptor)) {
      throw new DeveloperError("descriptor is required");
    }
    if (!defined(descriptor.name)) {
      throw new DeveloperError("descriptor.name is required");
    }
    if (!defined(descriptor.code)) {
      throw new DeveloperError("descriptor.code is required");
    }

    const cacheKey = this._getCacheKey(descriptor);

    // Check cache first
    const cached = this._cache.get(cacheKey);
    if (cached) {
      this._stats.hits++;
      return cached.module;
    }

    // Check if compilation is already in progress
    const pending = this._pendingCompilations.get(cacheKey);
    if (pending) {
      return pending;
    }

    // Compile new shader
    this._stats.misses++;
    const compilationPromise = this._compileShader(descriptor, cacheKey);
    this._pendingCompilations.set(cacheKey, compilationPromise);

    try {
      const module = await compilationPromise;
      this._pendingCompilations.delete(cacheKey);
      return module;
    } catch (error) {
      this._pendingCompilations.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Get a shader synchronously (only if already cached)
   * @param name - Shader name
   * @returns The cached shader module or undefined
   */
  getCachedShader(name: string): GPUShaderModule | undefined {
    const entry = this._cache.get(name);
    if (entry) {
      this._stats.hits++;
      return entry.module;
    }
    return undefined;
  }

  /**
   * Preload a shader (compile and cache it)
   * @param descriptor - Shader descriptor
   */
  async preload(descriptor: ShaderDescriptor): Promise<void> {
    await this.getShader(descriptor);
  }

  /**
   * Preload multiple shaders in parallel
   * @param descriptors - Array of shader descriptors
   */
  async preloadBatch(descriptors: ShaderDescriptor[]): Promise<void> {
    await Promise.all(descriptors.map((desc) => this.preload(desc)));
  }

  /**
   * Check if a shader is cached
   * @param name - Shader name
   * @returns True if cached
   */
  has(name: string): boolean {
    return this._cache.has(name);
  }

  /**
   * Remove a shader from cache
   * @param name - Shader name
   * @returns True if removed
   */
  remove(name: string): boolean {
    return this._cache.delete(name);
  }

  /**
   * Clear all cached shaders
   */
  clear(): void {
    this._cache.clear();
    this._pendingCompilations.clear();
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getStats() {
    return {
      ...this._stats,
      size: this._cache.size,
      pending: this._pendingCompilations.size,
      hitRate: this._stats.hits / (this._stats.hits + this._stats.misses) || 0,
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this._stats = {
      hits: 0,
      misses: 0,
      compilations: 0,
      errors: 0,
    };
  }

  /**
   * Get all cached shader names
   * @returns Array of shader names
   */
  getCachedNames(): string[] {
    return Array.from(this._cache.keys());
  }

  /**
   * Compile a shader module
   * @private
   */
  private async _compileShader(
    descriptor: ShaderDescriptor,
    cacheKey: string,
  ): Promise<GPUShaderModule> {
    try {
      this._stats.compilations++;

      // Create shader module
      const module = this._device.createShaderModule({
        label: descriptor.label || descriptor.name,
        code: descriptor.code,
      });

      // Get compilation info (for error checking)
      const compilationInfo = await module.getCompilationInfo();

      // Check for errors
      const errors = compilationInfo.messages.filter(
        (msg) => msg.type === "error",
      );

      if (errors.length > 0) {
        this._stats.errors++;
        const errorMessages = errors
          .map((e) => `  Line ${e.lineNum}: ${e.message}`)
          .join("\n");
        throw new Error(
          `Shader compilation failed for "${descriptor.name}":\n${errorMessages}`,
        );
      }

      // Log warnings if any
      const warnings = compilationInfo.messages.filter(
        (msg) => msg.type === "warning",
      );
      if (warnings.length > 0) {
        console.warn(
          `Shader compilation warnings for "${descriptor.name}":`,
          warnings,
        );
      }

      // Cache the compiled module
      const entry: ShaderCacheEntry = {
        module,
        code: descriptor.code,
        entryPoints: descriptor.entryPoints || {
          vertex: "vertexMain",
          fragment: "fragmentMain",
        },
        timestamp: Date.now(),
      };

      this._cache.set(cacheKey, entry);

      return module;
    } catch (error) {
      this._stats.errors++;
      console.error(`Failed to compile shader "${descriptor.name}":`, error);
      throw error;
    }
  }

  /**
   * Generate cache key from descriptor
   * @private
   */
  private _getCacheKey(descriptor: ShaderDescriptor): string {
    // For now, use the name as the cache key
    // Could hash the code for more robust caching
    return descriptor.name;
  }

  /**
   * Destroy the cache and release resources
   */
  destroy(): void {
    this.clear();
  }

  /**
   * Check if the cache is destroyed
   */
  isDestroyed(): boolean {
    return false; // Could add destroyed flag if needed
  }
}

/**
 * Built-in shader library names
 */
export const BuiltInShaders = {
  BASIC_COLOR: "BasicColor",
  BASIC_TEXTURED: "BasicTextured",
  PHONG_LIGHTING: "PhongLighting",
  PBR_METALLIC_ROUGHNESS: "PBRMetallicRoughness",
} as const;

/**
 * Helper function to load a built-in shader
 * @param cache - Shader cache instance
 * @param shaderName - Name of built-in shader
 * @returns Promise resolving to shader module
 */
export async function loadBuiltInShader(
  cache: WebGPUShaderCache,
  shaderName: string,
): Promise<GPUShaderModule> {
  // In a real implementation, this would fetch the shader file
  // For now, this is a placeholder that would be implemented
  // when we have a shader loading system in place

  throw new Error(
    `Built-in shader loading not yet implemented. ` +
      `Please use cache.getShader() with explicit shader code.`,
  );
}

export default WebGPUShaderCache;
