/**
 * WGSL Shader Preprocessor for CesiumJS WebGPU
 *
 * Since WGSL does not natively support `#import` or `#include` directives,
 * this preprocessor provides a compile-time module system for WGSL shaders.
 *
 * ## Features
 * 1. **Explicit imports**: `#import "path/to/module"` directives resolved at preprocessing time
 * 2. **Automatic dependency resolution**: References to `csm_*` identifiers are auto-resolved
 *    (mirrors Cesium's `czm_*` pattern for GLSL shaders in ShaderSource.js)
 * 3. **Dependency graph**: Topological sort ensures correct declaration order
 * 4. **Deduplication**: Each chunk is included only once, even if imported multiple times
 * 5. **#define support**: Conditional compilation via `#define` / `#ifdef` / `#ifndef` / `#else` / `#endif`
 * 6. **Circular dependency detection**: Throws clear error if cycles are found
 *
 * ## Import Syntax
 * ```wgsl
 * // #import "structs/CameraUniforms"
 * // #import "functions/csm_phong"
 * // #import "functions/csm_constants"
 * ```
 *
 * The `//` prefix keeps the import directive as a valid WGSL comment, so raw
 * WGSL parsers and IDE extensions won't choke on unknown preprocessor directives.
 * The preprocessor strips these lines and replaces them with resolved code.
 *
 * ## Automatic Resolution
 * Any reference to a `csm_` prefixed identifier (function, constant, struct)
 * is automatically resolved from the shader library, similar to how Cesium's
 * GLSL system resolves `czm_` prefixed builtins.
 *
 * @example
 * ```typescript
 * import { WGSLShaderPreprocessor } from './WGSLShaderPreprocessor';
 * import { WGSLShaderLibrary } from './WGSLShaderLibrary';
 *
 * const library = WGSLShaderLibrary.createDefault();
 * const preprocessor = new WGSLShaderPreprocessor(library);
 *
 * const resolvedCode = preprocessor.process(myShaderSource, {
 *   defines: ['USE_NORMAL_MAP', 'MAX_LIGHTS 4'],
 * });
 * ```
 * @module WGSLShaderPreprocessor
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A registered shader chunk in the library
 */
export interface WGSLShaderChunk {
  /** Unique name/path for the chunk (e.g., "structs/CameraUniforms") */
  name: string;
  /** Raw WGSL source code */
  code: string;
  /** Explicit dependencies declared via `#import` in the chunk itself */
  imports: string[];
}

/**
 * Options for preprocessing a shader
 */
export interface WGSLPreprocessOptions {
  /** Array of `#define` strings (e.g., ["USE_NORMAL_MAP", "MAX_LIGHTS 4"]) */
  defines?: string[];
  /** If true, auto-resolve `csm_*` references (default: true) */
  autoResolve?: boolean;
  /** If true, strip all comments from output (default: false) */
  stripComments?: boolean;
  /** Label for debugging/error messages */
  label?: string;
}

/**
 * Result of preprocessing a shader
 */
export interface WGSLPreprocessResult {
  /** Final resolved WGSL code ready for createShaderModule() */
  code: string;
  /** List of chunk names that were included */
  includedChunks: string[];
  /** Dependency graph (for debugging) */
  dependencyOrder: string[];
}

/**
 * Internal node in the dependency graph
 */
interface DependencyNode {
  name: string;
  code: string;
  dependsOn: DependencyNode[];
  requiredBy: DependencyNode[];
  evaluated: boolean;
}

// ============================================================================
// WGSLShaderLibrary
// ============================================================================

/**
 * Registry of reusable WGSL shader chunks.
 *
 * Chunks can be registered by name and then resolved by the preprocessor.
 * This is the WGSL equivalent of CzmBuiltins for GLSL.
 *
 * @example
 * ```typescript
 * const library = new WGSLShaderLibrary();
 * library.register({
 *   name: 'structs/CameraUniforms',
 *   code: `struct CameraUniforms { ... }`,
 * });
 * ```
 */
export class WGSLShaderLibrary {
  private _chunks: Map<string, WGSLShaderChunk> = new Map();

  /**
   * Also index by `csm_` identifiers found in the chunk code
   * Maps: csm_identifier → chunk name
   */
  private _autoResolveIndex: Map<string, string> = new Map();

  /**
   * Register a shader chunk
   * @param chunk - The chunk to register
   */
  register(chunk: WGSLShaderChunk): void {
    if (!defined(chunk.name)) {
      throw new DeveloperError("chunk.name is required");
    }
    if (!defined(chunk.code)) {
      throw new DeveloperError("chunk.code is required");
    }

    // Parse imports from the chunk code if not explicitly provided
    if (!chunk.imports) {
      chunk.imports = WGSLShaderPreprocessor.parseImports(chunk.code);
    }

    this._chunks.set(chunk.name, chunk);

    // Index csm_ identifiers for auto-resolution
    this._indexCsmIdentifiers(chunk);
  }

  /**
   * Register a chunk from raw code with a given name
   * @param name - Chunk name/path
   * @param code - WGSL source code
   */
  registerCode(name: string, code: string): void {
    this.register({
      name,
      code,
      imports: WGSLShaderPreprocessor.parseImports(code),
    });
  }

  /**
   * Get a chunk by name
   * @param name - Chunk name
   * @returns The chunk or undefined
   */
  get(name: string): WGSLShaderChunk | undefined {
    return this._chunks.get(name);
  }

  /**
   * Check if a chunk exists
   * @param name - Chunk name
   */
  has(name: string): boolean {
    return this._chunks.has(name);
  }

  /**
   * Get the chunk name that provides a given csm_ identifier
   * @param identifier - A csm_ prefixed identifier
   * @returns The chunk name or undefined
   */
  getChunkForIdentifier(identifier: string): string | undefined {
    return this._autoResolveIndex.get(identifier);
  }

  /**
   * Get all registered chunk names
   */
  getRegisteredNames(): string[] {
    return Array.from(this._chunks.keys());
  }

  /**
   * Get all indexed csm_ identifiers
   */
  getIndexedIdentifiers(): string[] {
    return Array.from(this._autoResolveIndex.keys());
  }

  /**
   * Get number of registered chunks
   */
  get size(): number {
    return this._chunks.size;
  }

  /**
   * Clear all registered chunks
   */
  clear(): void {
    this._chunks.clear();
    this._autoResolveIndex.clear();
  }

  /**
   * Index all csm_ identifiers found in a chunk's code
   * @private
   */
  private _indexCsmIdentifiers(chunk: WGSLShaderChunk): void {
    // Find all csm_ prefixed identifiers (functions, constants, structs, type names)
    const csmPattern = /\b(csm_[a-zA-Z0-9_]+)\b/g;
    const code = WGSLShaderPreprocessor.removeComments(chunk.code);
    let match: RegExpExecArray | null;

    // Also check for struct names like CsmPhongResult, CameraUniforms, etc.
    // that are defined in chunks (for auto-resolution of struct types)
    const structPattern =
      /\bstruct\s+(Csm[a-zA-Z0-9_]+|[A-Z][a-zA-Z0-9_]*Uniforms|PBRMaterial|LightingUniforms)\b/g;

    while ((match = csmPattern.exec(code)) !== null) {
      const identifier = match[1];
      // Only index if this looks like a definition (fn, const, var, struct)
      // Check if this identifier is defined (declared) in this chunk
      const defPattern = new RegExp(
        `\\b(?:fn|const|var|let|struct)\\s+${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (defPattern.test(code)) {
        this._autoResolveIndex.set(identifier, chunk.name);
      }
    }

    // Index struct definitions
    while ((match = structPattern.exec(code)) !== null) {
      const structName = match[1];
      this._autoResolveIndex.set(structName, chunk.name);
    }
  }
}

// ============================================================================
// WGSLShaderPreprocessor
// ============================================================================

/**
 * Preprocesses WGSL shader source code, resolving imports and dependencies.
 *
 * Inspired by Cesium's GLSL ShaderSource.js system, adapted for WGSL:
 * - Resolves `// #import "path"` directives
 * - Auto-resolves `csm_*` references from the shader library
 * - Topologically sorts dependencies
 * - Deduplicates included chunks
 * - Processes `#define` / `#ifdef` / `#ifndef` / `#else` / `#endif` conditionals
 *
 * @example
 * ```typescript
 * const preprocessor = new WGSLShaderPreprocessor(library);
 * const result = preprocessor.process(shaderCode, { defines: ['USE_PHONG'] });
 * const module = device.createShaderModule({ code: result.code });
 * ```
 */
export class WGSLShaderPreprocessor {
  private _library: WGSLShaderLibrary;

  /**
   * Create a new preprocessor
   * @param library - The shader library to resolve imports from
   */
  constructor(library: WGSLShaderLibrary) {
    if (!defined(library)) {
      throw new DeveloperError("library is required");
    }
    this._library = library;
  }

  /**
   * Get the shader library
   */
  get library(): WGSLShaderLibrary {
    return this._library;
  }

  /**
   * Process WGSL shader source code, resolving all imports and dependencies.
   *
   * @param source - Raw WGSL shader source with optional `#import` directives
   * @param options - Preprocessing options
   * @returns Preprocessed result with resolved code and metadata
   */
  process(
    source: string,
    options?: WGSLPreprocessOptions,
  ): WGSLPreprocessResult {
    const opts: WGSLPreprocessOptions = {
      defines: [],
      autoResolve: true,
      stripComments: false,
      label: "shader",
      ...options,
    };

    // Step 1: Process #define conditionals first
    let processedSource = this._processConditionals(source, opts.defines ?? []);

    // Step 2: Parse explicit #import directives
    const explicitImports =
      WGSLShaderPreprocessor.parseImports(processedSource);

    // Step 3: Strip #import lines from the source
    processedSource = WGSLShaderPreprocessor.stripImportLines(processedSource);

    // Step 4: If autoResolve is enabled, find csm_ references
    let autoImports: string[] = [];
    if (opts.autoResolve) {
      autoImports = this._findAutoImports(processedSource, explicitImports);
    }

    // Step 5: Combine all imports (explicit + auto-resolved)
    const allImports = [...new Set([...explicitImports, ...autoImports])];

    // Step 6: Build dependency graph and resolve transitively
    const dependencyOrder = this._resolveDependencies(
      allImports,
      opts.label ?? "shader",
    );

    // Step 7: Concatenate resolved chunks + source
    let resolvedCode = "";
    const includedChunks: string[] = [];

    // Prepend #defines as WGSL override constants or const declarations
    if (opts.defines && opts.defines.length > 0) {
      resolvedCode += "// === Preprocessor Defines ===\n";
      for (const define of opts.defines) {
        // Support "NAME value" format
        const parts = define.split(/\s+/, 2);
        if (parts.length === 2) {
          const value = parts[1];
          // Infer WGSL type from the value
          const typedValue = WGSLShaderPreprocessor.inferDefineType(value);
          resolvedCode += `const ${parts[0]}: ${typedValue.type} = ${typedValue.literal};\n`;
        }
        // Simple "NAME" defines are handled by the conditional processing
      }
      resolvedCode += "\n";
    }

    // Prepend resolved chunks in dependency order
    if (dependencyOrder.length > 0) {
      resolvedCode += "// === Imported Chunks ===\n";
      for (const chunkName of dependencyOrder) {
        const chunk = this._library.get(chunkName);
        if (chunk) {
          let chunkCode = chunk.code;

          // Process conditionals in the chunk too
          chunkCode = this._processConditionals(chunkCode, opts.defines ?? []);

          // Strip import lines from chunk code (already resolved)
          chunkCode = WGSLShaderPreprocessor.stripImportLines(chunkCode);

          // Strip doc comments from chunks
          chunkCode = WGSLShaderPreprocessor.stripDocComments(chunkCode);

          resolvedCode += `// --- chunk: ${chunkName} ---\n`;
          resolvedCode += chunkCode.trim() + "\n\n";
          includedChunks.push(chunkName);
        }
      }
      resolvedCode += "// === End Imported Chunks ===\n\n";
    }

    // Append the main shader source
    resolvedCode += processedSource;

    // Step 8: Optionally strip all comments
    if (opts.stripComments) {
      resolvedCode = WGSLShaderPreprocessor.removeComments(resolvedCode);
    }

    return {
      code: resolvedCode,
      includedChunks,
      dependencyOrder,
    };
  }

  /**
   * Quick method: process and return just the code string
   */
  resolve(source: string, options?: WGSLPreprocessOptions): string {
    return this.process(source, options).code;
  }

  // ==========================================================================
  // Static utility methods
  // ==========================================================================

  /**
   * Parse `#import` directives from WGSL source code.
   * Supports both `// #import "path"` and `#import "path"` syntax.
   *
   * @param source - WGSL source code
   * @returns Array of import paths
   */
  static parseImports(source: string): string[] {
    const imports: string[] = [];
    // Match: // #import "path" or #import "path" or // #import 'path'
    const importRegex = /(?:\/\/\s*)?#import\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(source)) !== null) {
      const importPath = match[1];
      if (!imports.includes(importPath)) {
        imports.push(importPath);
      }
    }

    return imports;
  }

  /**
   * Strip `#import` lines from source code
   */
  static stripImportLines(source: string): string {
    return source.replace(
      /(?:\/\/\s*)?#import\s+["'][^"']+["']\s*;?\s*\n?/g,
      "",
    );
  }

  /**
   * Remove all comments from WGSL source
   */
  static removeComments(source: string): string {
    // Remove single-line comments
    source = source.replace(/\/\/.*/g, "");
    // Remove multi-line comments (block comments)
    source = source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
      // Preserve line count for debugging
      const lineCount = (match.match(/\n/g) || []).length;
      return "\n".repeat(lineCount);
    });
    return source;
  }

  /**
   * Infer the WGSL type and literal suffix for a #define value.
   *
   * Examples:
   * - "4"     → { type: "u32", literal: "4u" }
   * - "-3"    → { type: "i32", literal: "-3i" }
   * - "2.5"   → { type: "f32", literal: "2.5" }
   * - "true"  → { type: "bool", literal: "true" }
   * - "false" → { type: "bool", literal: "false" }
   *
   * Values that already have a WGSL suffix (e.g., "4u", "3.0f") are preserved.
   *
   * @param value - The raw define value string
   * @returns Object with `type` (WGSL type) and `literal` (WGSL literal expression)
   */
  static inferDefineType(value: string): { type: string; literal: string } {
    const trimmed = value.trim();

    // Boolean
    if (trimmed === "true" || trimmed === "false") {
      return { type: "bool", literal: trimmed };
    }

    // Already has a WGSL suffix (e.g., 4u, 3i, 2.0f, 1.0h)
    if (/^-?\d+u$/.test(trimmed)) {
      return { type: "u32", literal: trimmed };
    }
    if (/^-?\d+i$/.test(trimmed)) {
      return { type: "i32", literal: trimmed };
    }
    if (/^-?\d+(\.\d*)?f$/.test(trimmed)) {
      return { type: "f32", literal: trimmed };
    }
    if (/^-?\d+(\.\d*)?h$/.test(trimmed)) {
      return { type: "f16", literal: trimmed };
    }

    // Float (contains a decimal point or scientific notation)
    if (
      /^-?\d+\.\d*$/.test(trimmed) ||
      /^-?\d+(\.\d*)?[eE][+-]?\d+$/.test(trimmed)
    ) {
      return { type: "f32", literal: trimmed };
    }

    // Negative integer
    if (/^-\d+$/.test(trimmed)) {
      return { type: "i32", literal: `${trimmed}i` };
    }

    // Positive integer (no suffix → default to u32 for backward compat)
    if (/^\d+$/.test(trimmed)) {
      return { type: "u32", literal: `${trimmed}u` };
    }

    // Fallback: treat as u32 with the raw value (preserves old behavior)
    return { type: "u32", literal: `${trimmed}u` };
  }

  /**
   * Strip doc comments (/** ... *​/) but keep regular comments
   */
  static stripDocComments(source: string): string {
    return source.replace(/\/\*\*[\s\S]*?\*\//g, (match) => {
      const lineCount = (match.match(/\n/g) || []).length;
      return "\n".repeat(lineCount);
    });
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Find csm_ identifiers referenced in the source that need auto-import
   * @private
   */
  private _findAutoImports(
    source: string,
    alreadyImported: string[],
  ): string[] {
    const autoImports: string[] = [];
    const cleanSource = WGSLShaderPreprocessor.removeComments(source);

    // Find all csm_ prefixed identifiers
    const csmMatches = cleanSource.match(/\bcsm_[a-zA-Z0-9_]*/g);
    if (csmMatches) {
      // Deduplicate
      const unique = [...new Set(csmMatches)];
      for (const identifier of unique) {
        const chunkName = this._library.getChunkForIdentifier(identifier);
        if (chunkName && !alreadyImported.includes(chunkName)) {
          autoImports.push(chunkName);
        }
      }
    }

    // Also find struct names that might be from chunks (CameraUniforms, etc.)
    const structRefs = cleanSource.match(
      /\b(Csm[a-zA-Z0-9_]+|[A-Z][a-zA-Z0-9_]*Uniforms|PBRMaterial|LightingUniforms)\b/g,
    );
    if (structRefs) {
      const unique = [...new Set(structRefs)];
      for (const structName of unique) {
        const chunkName = this._library.getChunkForIdentifier(structName);
        if (
          chunkName &&
          !alreadyImported.includes(chunkName) &&
          !autoImports.includes(chunkName)
        ) {
          autoImports.push(chunkName);
        }
      }
    }

    return autoImports;
  }

  /**
   * Resolve the full dependency tree for a set of imports.
   * Returns chunk names in correct topological order (dependencies first).
   * @private
   */
  private _resolveDependencies(imports: string[], label: string): string[] {
    if (imports.length === 0) {
      return [];
    }

    const nodes: Map<string, DependencyNode> = new Map();
    const visited = new Set<string>();

    // Build dependency graph
    const getOrCreateNode = (name: string): DependencyNode | null => {
      if (nodes.has(name)) {
        return nodes.get(name)!;
      }

      const chunk = this._library.get(name);
      if (!chunk) {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WGSLPreprocessor] Warning: chunk "${name}" not found in library (referenced by "${label}")`,
        );
        //>>includeEnd('debug');
        return null;
      }

      const node: DependencyNode = {
        name,
        code: chunk.code,
        dependsOn: [],
        requiredBy: [],
        evaluated: false,
      };
      nodes.set(name, node);

      return node;
    };

    // Recursive dependency builder
    const buildDeps = (chunkName: string): void => {
      if (visited.has(chunkName)) {
        return;
      }
      visited.add(chunkName);

      const chunk = this._library.get(chunkName);
      if (!chunk) return;

      const node = getOrCreateNode(chunkName);
      if (!node) return;

      // Resolve explicit imports from this chunk
      for (const imp of chunk.imports) {
        const depNode = getOrCreateNode(imp);
        if (depNode) {
          node.dependsOn.push(depNode);
          depNode.requiredBy.push(node);
          buildDeps(imp);
        }
      }

      // Auto-resolve csm_ references within this chunk
      const cleanCode = WGSLShaderPreprocessor.removeComments(chunk.code);

      // Collect all auto-resolvable references: csm_* identifiers AND struct names
      const allRefs: string[] = [];

      const csmRefs = cleanCode.match(/\bcsm_[a-zA-Z0-9_]*/g);
      if (csmRefs) {
        allRefs.push(...csmRefs);
      }

      // Also resolve struct references transitively within chunks.
      // Without this, a chunk that references CameraUniforms or PBRMaterial
      // won't pull in the struct definition chunk, causing shader compilation failures.
      const structRefs = cleanCode.match(
        /\b(Csm[a-zA-Z0-9_]+|[A-Z][a-zA-Z0-9_]*Uniforms|PBRMaterial|LightingUniforms)\b/g,
      );
      if (structRefs) {
        allRefs.push(...structRefs);
      }

      const uniqueRefs = [...new Set(allRefs)];
      for (const ref of uniqueRefs) {
        const refChunkName = this._library.getChunkForIdentifier(ref);
        if (
          refChunkName &&
          refChunkName !== chunkName &&
          !node.dependsOn.some((d) => d.name === refChunkName)
        ) {
          const depNode = getOrCreateNode(refChunkName);
          if (depNode) {
            node.dependsOn.push(depNode);
            depNode.requiredBy.push(node);
            buildDeps(refChunkName);
          }
        }
      }
    };

    // Build graph starting from the requested imports
    for (const importName of imports) {
      buildDeps(importName);
    }

    // Topological sort (Kahn's algorithm) — same approach as Cesium's ShaderSource.js
    return this._topologicalSort(nodes, label);
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns chunk names in dependency order (leaves first).
   * @private
   */
  private _topologicalSort(
    nodes: Map<string, DependencyNode>,
    label: string,
  ): string[] {
    // Clone the requiredBy counts so we don't mutate originals
    const inDegree = new Map<string, number>();
    for (const [name, node] of nodes) {
      inDegree.set(name, node.requiredBy.length);
    }

    // Start with nodes that have no incoming edges (nothing requires them → they are leaves)
    // Actually for correct ordering we want: nodes with no dependencies first
    // Let me use proper Kahn's algorithm: start with nodes that have no dependencies (in-degree based on dependsOn)

    const depCount = new Map<string, number>();
    for (const [name, node] of nodes) {
      depCount.set(name, node.dependsOn.length);
    }

    const queue: string[] = [];
    for (const [name, count] of depCount) {
      if (count === 0) {
        queue.push(name);
      }
    }

    const sorted: string[] = [];
    const processed = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (processed.has(current)) continue;
      processed.add(current);
      sorted.push(current);

      const node = nodes.get(current)!;
      // For each node that depends on current, reduce their dependency count
      for (const dependent of node.requiredBy) {
        const newCount = (depCount.get(dependent.name) ?? 1) - 1;
        depCount.set(dependent.name, newCount);
        if (newCount === 0 && !processed.has(dependent.name)) {
          queue.push(dependent.name);
        }
      }
    }

    // Check for circular dependencies
    if (sorted.length < nodes.size) {
      const unresolved = [...nodes.keys()].filter((n) => !processed.has(n));
      throw new DeveloperError(
        `[WGSLPreprocessor] Circular dependency detected in "${label}". ` +
          `Unresolvable chunks: ${unresolved.join(", ")}`,
      );
    }

    return sorted;
  }

  /**
   * Process #define / #ifdef / #ifndef / #else / #endif conditionals
   * @private
   */
  private _processConditionals(source: string, defines: string[]): string {
    // Build set of defined symbols
    const definedSymbols = new Set<string>();
    for (const define of defines) {
      const name = define.split(/\s+/)[0];
      definedSymbols.add(name);
    }

    // Process line by line
    const lines = source.split("\n");
    const output: string[] = [];
    const conditionStack: { active: boolean; elseAllowed: boolean }[] = [];
    let currentlyActive = true;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for preprocessor directives
      // Support both `#ifdef` and `// #ifdef` syntax
      const directiveMatch = trimmed.match(
        /^(?:\/\/\s*)?#(ifdef|ifndef|else|endif|define)\s*(.*)?$/,
      );

      if (directiveMatch) {
        const directive = directiveMatch[1];
        const arg = (directiveMatch[2] || "").trim();

        switch (directive) {
          case "define": {
            const defName = arg.split(/\s+/)[0];
            definedSymbols.add(defName);
            // Don't output #define lines
            break;
          }
          case "ifdef": {
            conditionStack.push({
              active: currentlyActive,
              elseAllowed: true,
            });
            currentlyActive = currentlyActive && definedSymbols.has(arg);
            break;
          }
          case "ifndef": {
            conditionStack.push({
              active: currentlyActive,
              elseAllowed: true,
            });
            currentlyActive = currentlyActive && !definedSymbols.has(arg);
            break;
          }
          case "else": {
            if (conditionStack.length === 0) {
              throw new DeveloperError(
                "[WGSLPreprocessor] #else without matching #ifdef/#ifndef",
              );
            }
            const top = conditionStack[conditionStack.length - 1];
            if (!top.elseAllowed) {
              throw new DeveloperError(
                "[WGSLPreprocessor] Multiple #else for same #ifdef/#ifndef",
              );
            }
            top.elseAllowed = false;
            // Flip: if parent was active and we were active, now inactive; if parent was active and we were inactive, now active
            currentlyActive = top.active && !currentlyActive;
            break;
          }
          case "endif": {
            if (conditionStack.length === 0) {
              throw new DeveloperError(
                "[WGSLPreprocessor] #endif without matching #ifdef/#ifndef",
              );
            }
            const popped = conditionStack.pop()!;
            currentlyActive = popped.active;
            break;
          }
        }
        continue; // Don't include the directive line in output
      }

      // Only include line if currently active
      if (currentlyActive) {
        output.push(line);
      }
    }

    if (conditionStack.length > 0) {
      throw new DeveloperError(
        "[WGSLPreprocessor] Unterminated #ifdef/#ifndef (missing #endif)",
      );
    }

    return output.join("\n");
  }
}

export default WGSLShaderPreprocessor;
