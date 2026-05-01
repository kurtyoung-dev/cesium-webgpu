/**
 * Registry of cache-clear callbacks owned by a WebGPU context.
 *
 * Extracted from `WebGPUContext._clearAllCaches`'s inline cache list
 * as Batch 131 of the audit-recommended Context decomposition. See
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` for the
 * roadmap and `migration_doc/BATCH_131_PLAN_RESOURCE_CACHE_REGISTRY.md`
 * for this specific extraction.
 *
 * The Context registers each of its caches once at init; the
 * recovery path calls `clearAll()` to drop stale GPU handles after
 * device loss. Each entry runs inside its own try/catch so a single
 * misbehaving cache (e.g. a concurrent compile racing with the
 * recovery flow) doesn't block the rest of the cleanup or the
 * downstream `_fireDeviceInvalidated()` notification.
 *
 * The registry doesn't track which caches "own" GPU handles vs. JS
 * references — every entry is just a `() => void` callback. The
 * Context retains responsibility for the actual clear logic; the
 * registry is the dispatcher.
 *
 * @module WebGPUResourceCacheRegistry
 */

interface CacheEntry {
  name: string;
  clear: () => void;
}

export class WebGPUResourceCacheRegistry {
  private entries: CacheEntry[] = [];
  private contextIdProvider: () => string | undefined;

  /**
   * @param contextIdProvider - Returns the owning context's id when
   *   called. Used in error logs so multi-context setups can
   *   attribute failures.
   */
  constructor(contextIdProvider: () => string | undefined) {
    this.contextIdProvider = contextIdProvider;
  }

  /**
   * Register a cache-clear callback. Returns `this` so registration
   * blocks can chain. The same `name` may be registered more than
   * once — duplicates are kept and called in registration order
   * (some callers may legitimately split a single conceptual cache
   * across multiple slots).
   */
  register(name: string, clearFn: () => void): this {
    this.entries.push({ name, clear: clearFn });
    return this;
  }

  /**
   * Clear every registered cache, in registration order. Each entry
   * runs inside its own try/catch so one failing clear doesn't block
   * the rest. Errors are logged with the cache name + owning context
   * id for diagnostic attribution.
   */
  clearAll(): void {
    for (const entry of this.entries) {
      try {
        entry.clear();
      } catch (e) {
        const id = this.contextIdProvider() ?? "?";
        console.error(
          `[WebGPU:ctx-${id}:cache-registry] '${entry.name}' clear threw:`,
          e,
        );
      }
    }
  }

  /**
   * Number of registered cache entries. Exposed for diagnostics +
   * tests.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Names of registered caches in registration order. Useful for
   * snapshot tests that pin the expected registry shape.
   */
  get names(): readonly string[] {
    return this.entries.map((e) => e.name);
  }

  /**
   * Drop every registered entry. Used by the Context's destroy path
   * so registered closures release immediately.
   */
  clear(): void {
    this.entries = [];
  }
}

export default WebGPUResourceCacheRegistry;
