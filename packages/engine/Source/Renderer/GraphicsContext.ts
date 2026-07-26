/**
 * Abstract base class that defines the unified API for both WebGL and WebGPU
 * rendering contexts. This is the cornerstone of CesiumJS's backend-agnostic
 * architecture — scene code interacts with this class, never with backend-specific
 * implementations directly.
 *
 * ## Design Philosophy (Three.js + PlayCanvas Hybrid)
 *
 * **From Three.js:** Both `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) extend
 * this class and implement the same abstract API. TypeScript enforces parity at compile
 * time — if you add a method to GraphicsContext, both backends must implement it.
 *
 * **From PlayCanvas:** This is a concrete base class (not just an interface) that
 * provides shared default implementations for logging, registry management, feature
 * renderer lookup, and capability queries. Backend-specific logic is in overridden
 * abstract methods only.
 *
 * ## Multi-Context Support
 *
 * Every GraphicsContext instance has a unique ID and is automatically tracked by the
 * static `ContextRegistry`. Multiple contexts can run simultaneously:
 * - Split-screen: WebGL left + WebGPU right (same scene graph)
 * - Multi-monitor: Different canvases, different or same backends
 * - Mixed: WebGL for rendering + WebGPU compute for processing
 *
 * ## Usage
 * ```typescript
 * // Scene code — backend-agnostic:
 * const ctx: GraphicsContext = scene.context;
 * ctx.log('info', 'Rendering frame');
 * ctx.clear(clearCommand);
 * ctx.draw(drawCommand);
 *
 * // External/extension code — can query but should not branch:
 * console.log(ctx.rendererType);  // 'webgl' or 'webgpu'
 * console.log(ctx.isWebGPU);      // true or false
 *
 * // Multi-context scenarios:
 * const registry = GraphicsContext.registry;
 * console.log(registry.count);    // number of active contexts
 * ```
 *
 * @see ContextRegistry
 * @see ContextFactory
 * @see SharedResourcePool
 * @module GraphicsContext
 */

import ClipSpaceConvention, {
  type ClipSpaceConventionRecord,
} from "../Core/ClipSpaceConvention.js";
import GraphicsCapabilities, {
  type GraphicsCapabilitiesRecord,
} from "./GraphicsCapabilities.js";
import RendererType from "./RendererType.js";

// ═══════════════════════════════════════════════════════════
// Shared rendering contracts
// ═══════════════════════════════════════════════════════════

/**
 * Structural contract for anything the scene graph can render.
 *
 * Cesium's scene graph has no common base class across Primitive,
 * Billboard, Label, Entity, PointPrimitive, Polyline, Cloud, tileset
 * content, etc. (each is a standalone `class X {}` by deliberate
 * 11-year-old design choice — composition over inheritance). The one
 * thing they all share is that `PrimitiveCollection.update()` and
 * `Scene` invoke `update(frameState)` on every registered member
 * each frame.
 *
 * This interface captures that duck-typed contract structurally.
 * TypeScript erases it at compile time — zero runtime cost, zero
 * bundle bytes, zero V8 hidden-class impact. Existing Cesium classes
 * and user plain-object primitives (`{ update: (fs) => {...} }`)
 * already satisfy it without code changes.
 *
 * Use this where scene code previously accepted `any` / `object` /
 * `unknown` for a "primitive" slot — it documents intent, catches
 * typos (`upate` vs `update`) at compile time, and gives TS consumers
 * IntelliSense on what their custom primitive needs to implement.
 */
export interface Renderable {
  /** Called once per frame to update state and enqueue draw commands. */
  update(frameState: CesiumFrameState): void;

  /**
   * Optional visibility flag. When false, the scene skips `update()`.
   * Most Cesium primitives expose this; not strictly required.
   */
  readonly show?: boolean;

  /**
   * Optional destroy-state guard. If present, the scene respects it
   * and stops dispatching to destroyed primitives. Follows the
   * destroyObject.js contract (method, not getter, so destroyObject
   * can overwrite it).
   */
  isDestroyed?(): boolean;
}

/**
 * A renderable that also accepts per-pass scene state — typically used
 * by primitives that participate in multiple render passes (e.g.,
 * ClassificationPrimitive, GroundPrimitive). Callers check for the
 * method's presence via `"updateForPass" in primitive` narrowing.
 */
export interface RenderableWithPass extends Renderable {
  updateForPass(frameState: CesiumFrameState, passState: CesiumPassState): void;
}

/**
 * JSON-safe value type used by {@link GraphicsContext.getRendererStatistics}
 * and other debug surfaces. Each backend, feature renderer, or subsystem
 * contributes a tree of these values, which downstream tooling logs,
 * serializes, or diffs. Kept strictly structural (no `any` / `unknown` /
 * `object`) so every reachable field is typechecked as either a primitive,
 * another snapshot, or an ordered list of snapshots.
 */
export type DebugStatsValue =
  | string
  | number
  | boolean
  | null
  | DebugStatsObject
  | readonly DebugStatsValue[];

/** Recursive record of {@link DebugStatsValue}s. */
export interface DebugStatsObject {
  readonly [key: string]: DebugStatsValue | undefined;
}

/**
 * Type of a single field within a {@link PickTarget}.
 *
 * TypeScript's `unknown` is the principled answer here — not an escape
 * hatch. A pick target's fields can be:
 *   - primitives (e.g., `index: 5` on a collection-pick wrapper)
 *   - class instances with methods (e.g., `primitive: Primitive`)
 *   - nested plain objects or arrays
 *   - user-defined types Cesium knows nothing about
 *
 * No narrower type describes all of these honestly. The point of
 * `unknown` is exactly "no shape guarantees; narrow before use" —
 * which is the safety contract we want at this JS↔TS boundary.
 * Consumers of a `PickTarget` always `instanceof`-narrow or type-guard
 * before reading fields; see Cesium's `Scene.pick`, `Cesium3DTileFeature`,
 * and `Entity`-picking code for the pattern.
 *
 * Exporting this as a named type so greps for "unknown" don't flag it
 * as a mystery; it's a deliberate, documented opaque.
 */
export type PickTargetField = unknown;

/**
 * The "thing" associated with a pick ID. Concretely, callers register
 * diverse types here: `Primitive`, `Billboard`, `Entity`,
 * `Cesium3DTileFeature`, `Label`, per-feature wrapper object literals
 * `{ primitive, collection, index }`, user-defined types, etc. There's no
 * common base class in Cesium for these — the shared contract is "it's a
 * class instance or plain object that the pick caller can later introspect
 * via `instanceof` or property checks".
 *
 * The type captures:
 *   - `constructor?.name` — present on every JS object via
 *     `Object.prototype`; picking code reads it for debug labels without
 *     a cast.
 *   - open index signature typed as {@link PickTargetField} — lets
 *     callers pass object literals (like `{ primitive, collection,
 *     index }` from the BufferPrimitive family) without TS
 *     excess-property errors, while still forcing consumers to narrow
 *     before reading unknown fields.
 *
 * When a caller needs a specific shape, they narrow at the call site
 * with `instanceof` or a type guard — that's the idiom Cesium's pick
 * API has always used, and it's still correct here.
 */
export interface PickTarget {
  readonly constructor?: { readonly name?: string };
  readonly [key: string]: PickTargetField;
}

/**
 * Discriminator string for a pick registration. Each internal Cesium
 * registrar passes the kind that best describes what was hit; external
 * callers default to `"custom"` when they register their own types.
 *
 * This is the compile-time narrowing knob that replaces most
 * `instanceof` chains in pick-consumer code. Downstream code does
 * `switch (result.kind)` and TypeScript narrows per branch.
 *
 * The set is a closed union — typos fail to typecheck — but new kinds
 * can be added as Cesium grows (breaking change for external TypeScript
 * callers that enumerate the union). External JS callers are unaffected.
 */
export type PickKind =
  | "billboard"
  | "label"
  | "point"
  | "polyline"
  | "polygon"
  | "primitive"
  | "ground-primitive"
  | "model"
  | "model-instance"
  | "entity"
  | "tile-feature"
  | "voxel"
  | "cloud"
  | "particle"
  | "buffer-primitive"
  | "compute-instance"
  | "custom";

/**
 * The full pick record returned from
 * {@link GraphicsContext.getPickResult}. Carries the original pick
 * target plus its declared {@link PickKind} so consumers can branch
 * on kind at compile time instead of walking `instanceof` chains.
 *
 * The `target` field is still {@link PickTarget} — narrowing its
 * contents is still the caller's job, but knowing the kind
 * up-front means the narrow is one line instead of ten.
 */
export interface PickResult {
  readonly target: PickTarget;
  readonly kind: PickKind;
}

// ═══════════════════════════════════════════════════════════
// Shared viewport-quad types (see createViewportQuadCommand)
// ═══════════════════════════════════════════════════════════

/**
 * Fields accepted by every backend's `createViewportQuadCommand`. Backends
 * extend this with their own additions (e.g., WebGPU adds
 * `bindGroupEntries` / `pipelineConfig`). Keeping the shared fields here
 * lets the abstract method declare a real parameter shape instead of
 * `unknown`, and lets Scene-side JS consumers target the shared fields
 * without a backend import.
 */
export interface ViewportQuadCommandOptionsBase {
  /** Map of uniform name → getter. Each backend narrows the value type. */
  readonly uniformMap?: { readonly [name: string]: (() => unknown) | unknown };
  /** Optional framebuffer target (scene code passes JS-side Framebuffer). */
  readonly framebuffer?: CesiumOpaqueFramebuffer;
  /** Owner object — accessed only for `.constructor.name` debug labels. */
  readonly owner?: { readonly constructor?: { readonly name?: string } };
  /** Backend-agnostic render state handle (resolved in the override). */
  readonly renderState?: CesiumOpaqueRenderState;
  /** Cesium Pass enum value. */
  readonly pass?: number;
}

/**
 * Return contract for `createViewportQuadCommand`. Both backends produce
 * objects with `execute` + optional `destroy` — the exact signature of
 * `execute` is backend-specific (WebGL takes context+passState; WebGPU
 * takes a GPURenderPassEncoder), so we use `never[]` args at this layer
 * to enforce that abstract callers only go through backend-specific refs.
 */
export interface ViewportQuadCommandHandle {
  execute(...args: never[]): void;
  destroy?(): void;
}
import { ContextRegistry } from "./ContextRegistry.js";
import FeatureRendererKey from "./FeatureRendererKey.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import PickId from "./PickId.js";

// ═══════════════════════════════════════════════════════════
// FEATURE RENDERER INTERFACES (Phase C — Sub-typed)
//
// Feature renderers are split into sub-types based on their
// actual API contract. This replaces the previous catch-all
// interface that had optional `update?()` with variadic args
// and `[key: string]: any` (which defeated type safety).
//
// Sub-types:
//   CollectionRenderer   — 21 of 28 renderers (most common)
//   PrimitiveCommandRenderer — 1 of 28 (PRIMITIVE)
//   SystemRenderer       — 6 of 28 (specialized entry points)
//
// See: FR-UPDATE tech debt item in UPSTREAM_ISSUES_AND_TECH_DEBT.md
// ═══════════════════════════════════════════════════════════

/**
 * Base interface for all backend-specific feature renderers.
 *
 * Scene code calls `context.getFeatureRenderer(FeatureRendererKey.XXX)`
 * instead of importing from `Renderer/WebGPU/` directly. Each backend
 * registers its own implementation of each feature renderer.
 *
 * Feature renderers handle:
 * - GPU resource creation (buffers, pipelines, textures)
 * - Draw command emission
 * - Backend-specific optimizations
 *
 * They do NOT handle:
 * - Entity management, dirty tracking (shared scene logic)
 * - Visibility checks, mode updates (shared pre-branch logic)
 *
 * Use the specific sub-type interfaces for type-safe access:
 * - {@link CollectionRenderer} for renderers with `update()`
 * - {@link PrimitiveCommandRenderer} for the PRIMITIVE command factory
 * - {@link SystemRenderer} for specialized entry points
 */
export interface FeatureRenderer {
  /**
   * Destroy GPU resources owned by this renderer.
   * @param collection - The scene collection being destroyed
   */
  destroy?(collection?: unknown): void;

  /**
   * Optional: name for debugging/diagnostics.
   */
  readonly name?: string;

  // Common lifecycle methods — optional on the base interface because
  // different renderer types implement different subsets. Callers check
  // existence before calling (duck-typed dispatch).
  update?(...args: unknown[]): void;
  execute?(...args: unknown[]): void;
  render?(...args: unknown[]): void;
  composite?(...args: unknown[]): void;

  /**
   * C-R9-VOXEL-CELL-PICK-TAIL — resolve a keyframe-node handle for a picked
   * tile index. Implemented by the WebGPU voxel renderer so `Scene.pickVoxel`
   * can build a `VoxelCell` without the CPU-side `VoxelTraversal` that only the
   * WebGL path constructs. Returns undefined when no tile resolves.
   */
  getPickKeyframeNode?(primitive: unknown, tileIndex: number): unknown;

  /** Lazy-construction pattern: some feature renderers register a
   *  `RendererClass` constructor that gets instantiated on first touch
   *  (or via `_warmUpPipelines`) and cached on `_instance`. */
  RendererClass?: new (ctx: unknown) => object;
  _instance?: object;
}

/**
 * Explicit readiness of a backend feature renderer.
 *
 * `generation` is a per-slot lifetime token. Async producers may only install
 * a renderer into the generation they started in; context destruction,
 * device loss, loader replacement, or an eager replacement advances it and
 * makes an older completion stale.
 */
export type FeatureRendererReadiness =
  | { readonly kind: "unsupported"; readonly generation: number }
  | {
      readonly kind: "loading";
      readonly promise: Promise<FeatureRenderer | undefined>;
      readonly generation: number;
    }
  | {
      readonly kind: "ready";
      readonly renderer: FeatureRenderer;
      readonly generation: number;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly generation: number;
    };

/** @deprecated Use {@link FeatureRendererReadiness}. */
export type FeatureRendererLoadStatus = FeatureRendererReadiness;

/** Notification emitted when an async feature load settles. */
export type FeatureRendererReadinessListener = (
  key: number,
  state: FeatureRendererReadiness,
) => void;

/** Minimal context shape accepted by the migration adapter below. */
export interface FeatureRendererReadinessContext {
  getFeatureRendererReadiness?: (key: number) => FeatureRendererReadiness;
  getFeatureRenderer?: (key: number) => FeatureRenderer | undefined;
}

/**
 * Backend-neutral migration adapter for Scene consumers and isolated tests.
 * Real GraphicsContext instances take the explicit-state path. Older context
 * doubles retain renderer/undefined compatibility, where undefined means the
 * legacy path is unsupported only because those doubles cannot model loading.
 */
export function resolveFeatureRendererReadiness(
  context: FeatureRendererReadinessContext | null | undefined,
  key: number,
): FeatureRendererReadiness {
  if (typeof context?.getFeatureRendererReadiness === "function") {
    return context.getFeatureRendererReadiness(key);
  }
  const renderer = context?.getFeatureRenderer?.(key);
  return renderer
    ? { kind: "ready", renderer, generation: 0 }
    : { kind: "unsupported", generation: 0 };
}

/**
 * Feature renderer with a per-frame `update()` entry point.
 * This is the most common pattern (21 of 28 renderers).
 *
 * Used by: Collections (Billboard, Point, Polyline, Cloud),
 * Environment (Sun, Moon, SkyAtmosphere, CubeMapPanorama),
 * Model, Advanced features (Ellipsoid, GaussianSplat, PointCloud,
 * Voxel, InvertClassification), IBL/Lighting (BrdfLut,
 * ImageBasedLighting, DynamicEnvironmentMap), Clipping
 * (Planes, Polygons), and Post-Processing.
 *
 * Scene code pattern:
 * ```javascript
 * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
 * if (fr) { fr.update(this, frameState, commandList); return; }
 * ```
 */
export interface CollectionRenderer extends FeatureRenderer {
  /**
   * Update and render this feature for the current frame.
   * @param collection - The scene object (BillboardCollection, Sun, etc.)
   * @param frameState - Current frame state (or options object)
   * @param args - Additional arguments (commandList, etc.)
   */
  update(collection: unknown, frameState: unknown, ...args: unknown[]): unknown;
}

/**
 * Feature renderer for the Primitive command factory.
 * Creates and updates WebGPU draw commands for Primitive geometry.
 *
 * Used by: PRIMITIVE (1 of 28 renderers).
 *
 * Scene code pattern:
 * ```javascript
 * const fr = context.getFeatureRenderer(FeatureRendererKey.PRIMITIVE);
 * if (fr) { fr.createCommands(primitive, appearance, ...); }
 * ```
 */
export interface PrimitiveCommandRenderer extends FeatureRenderer {
  /**
   * Create draw commands for a primitive with per-instance-color appearance.
   */
  createCommands(...args: unknown[]): void;

  /**
   * Update per-frame uniforms on existing commands.
   */
  updateCommandUniforms(...args: unknown[]): void;

  /**
   * Create draw commands for a primitive with material appearance.
   */
  createMaterialCommands?(...args: unknown[]): void;

  /**
   * Update per-frame uniforms on material commands.
   */
  updateMaterialCommandUniforms?(...args: unknown[]): void;

  /**
   * Update per-frame uniforms on pick commands.
   */
  updatePickCommandUniforms?(...args: unknown[]): void;
}

/**
 * Feature renderer with specialized entry points.
 * Used for system-level renderers that don't follow the
 * simple `update()` pattern.
 *
 * Used by: FOG (getParameters), SHADOW_MAP (init, renderCastPass),
 * GROUND_PRIMITIVE (destroy only), GLOBE_SURFACE (RendererClass),
 * GLOBE_TRANSLUCENCY (updateDerivedCommands), SCENE_RENDERER
 * (RendererClass, initPrimitiveShaders, initCollectionShaders).
 *
 * The index signature allows type-safe access to specialized methods.
 */
export interface SystemRenderer extends FeatureRenderer {
  /** Initialize primitive shaders (async, called during context init) */
  initPrimitiveShaders?(): Promise<void>;
  /** Initialize collection shaders (async, called during context init) */
  initCollectionShaders?(): Promise<void>;
  /** Render shadow cast pass */
  renderCastPass?(...args: unknown[]): void;
  /** Allow specialized entry points */
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════
// GRAPHICS CONTEXT OPTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Options for creating a graphics context.
 */
export interface GraphicsContextOptions {
  /**
   * The renderer type to use ('webgl', 'webgpu', or 'auto')
   */
  renderer?: RendererType | string;

  /**
   * Whether to prefer WebGPU when AUTO is selected
   */
  preferWebGPU?: boolean;

  /**
   * When true, an explicit concrete renderer request (e.g. 'webgpu') hard-fails
   * instead of gracefully falling back to WebGL. Default false — fallback with
   * a console warning.
   */
  strictRenderer?: boolean;

  /**
   * WebGL-specific options
   */
  webgl?: WebGLContextAttributes;

  /**
   * Whether to request a WebGL 1 context instead of WebGL 2
   */
  requestWebgl1?: boolean;

  /**
   * Whether to allow texture filter anisotropic extension
   */
  allowTextureFilterAnisotropic?: boolean;

  /**
   * A function stub for testing purposes. WebGL-only — the WebGPU
   * backend ignores this field.
   */
  getWebGLStub?: (
    canvas: HTMLCanvasElement,
    webglOptions: WebGLContextAttributes,
  ) => WebGLRenderingContext | WebGL2RenderingContext;

  /**
   * Whether to use OffscreenCanvas in a WebWorker for this context.
   * When true, the context renders in a background worker thread.
   * Requires OffscreenCanvas browser support.
   * @default false
   */
  useOffscreenCanvas?: boolean;

  /**
   * WebGPU feature level: "core" (default) or "compatibility".
   * "compatibility" runs WebGPU on WebGL2 hardware via restricted feature set.
   * Only relevant when renderer is "webgpu" or "webgpu-compat".
   */
  featureLevel?: "core" | "compatibility";

  /**
   * WebGPU-renderer-specific opt-in quality options. Every field here
   * defaults to the WebGL-parity behavior — the off path is byte-neutral.
   * See `migration_doc/ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`.
   */
  webgpu?: WebGPURendererOptions;
}

/**
 * Opt-in WebGPU renderer quality flags. Defaults reproduce today's
 * WebGL-parity pixels exactly (Batch 426, atmosphere/cloud plan Phase 1).
 */
export interface WebGPURendererOptions {
  /**
   * Item 1.2 (IBL-HDR). When true, the dynamic environment-map cube and
   * its procedural-sky storage texture are allocated as `rgba16float`
   * instead of `rgba8unorm`, so the HDR sun disc + bright sky survive
   * into the GGX prefilter. Default `false` keeps the LDR `rgba8unorm`
   * source (byte-identical to the shipped parity path).
   * @default false
   */
  hdrEnvironmentMap?: boolean;

  /**
   * Item 1.3 (IBL-PREFILTER-HQ). `'parity'` (default) samples the source
   * env cube at mip 0 in the radiance prefilter exactly as shipped.
   * `'high'` pre-generates a mip chain on the source cube and samples it
   * at a GGX-pdf-derived LOD (Karis/UE4), killing bright-sun firefly
   * aliasing at high roughness.
   * @default 'parity'
   */
  iblPrefilterQuality?: "parity" | "high";

  /**
   * Item 2.2 (ENV-AERIAL-MS). When true, BOTH the dynamic-environment-map
   * procedural sky fill AND the aerial-perspective post-process source their
   * sky radiance from the sun-relative sky-view + multiple-scattering LUTs
   * (the same tables the visible SkyAtmosphere samples) instead of their own
   * inline single-scatter approximations. Reflected sky (env cube → model IBL)
   * and hazed distance (aerial perspective) then MATCH the visible MS sky —
   * richer, directional (warmer toward the sun), off-meridian-correct. Default
   * `false` keeps both shaders' inline single-scatter ports verbatim
   * (byte-identical to the shipped parity path). Read by
   * `WebGPUDynamicEnvironmentMapManager` (env cube) and
   * `WebGPUPostProcessStageCollection` (aerial perspective).
   * @default false
   */
  envMapMultiScatter?: boolean;

  /**
   * C2-25 ENV-SCENE-CAPTURE (Batch 446). When true, AND a
   * {@link DynamicEnvironmentMapManager} has `enableSceneCapture = true`, the
   * dynamic environment cube is refreshed each update by rendering the opaque
   * globe surface (later: 3D Tiles + glTF) into its 6 faces from 6 ENU
   * cube-face cameras centered on the reflective owner — so terrain shows up in
   * water / PBR reflections rather than only the procedural sky. Default
   * `false` runs ZERO extra GPU passes and leaves the env cube filled solely by
   * the procedural sky (byte-identical to the shipped parity path). Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   * @default false
   */
  sceneCaptureReflections?: boolean;

  /**
   * C2-25 ENV-TEMPORAL (Batch 449). When true, the dynamic environment cube is
   * temporally accumulated: a history cube + an exponential-moving-average
   * blend pass is inserted between the cube capture (procedural sky +
   * optional scene-capture composite) and the IBL mip/prefilter + SH
   * projection. The env map then crossfades smoothly on small sun/camera
   * change (no popping between debounced refreshes) and amortizes the 6-face
   * capture across frames — the temporal SUBSTRATE that later makes
   * clouds-in-reflections (3-C) affordable. On a LARGE sun or camera delta the
   * history is reset (blend α=1 that frame) so the env map can't smear across
   * a big change. A static scene converges to the same look as OFF (the EMA
   * fixed point of the deterministic capture). Default `false` allocates NO
   * history cube and runs NO blend pass — the cube flows straight to the
   * prefilter (byte-identical to the shipped parity path). Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   * @default false
   */
  envMapTemporalAccumulation?: boolean;

  /**
   * C2-25 item 3-C ENV-CLOUDS / CLOUD-IBL-FULL (Batch 450). When true, the
   * dynamic environment cube's procedural sky fill runs a LOW-RES per-face
   * procedural cloud raymarch (reusing the baked cloud shape/detail noise +
   * the same `cloudDensity` model the visible volumetric clouds use) and
   * composites it OVER the sky BEFORE the IBL prefilter + SH projection. An
   * overcast / cloudy sky then produces a genuinely cloudier reflection +
   * diffuse IBL (visible cloud structure carried into model / water
   * reflections), not just the coarse coverage-driven darkening shipped in
   * 4.2 ({@link Globe#cloudContributesIBL}). The march is intentionally coarse
   * (few steps, single simplified deck, cheap beer's-law sun light) because
   * the prefilter + SH blur the high-frequency detail. It is the noisy,
   * expensive consumer {@link WebGPURendererOptions#envMapTemporalAccumulation}
   * is designed to smooth — enabling both accumulates the march cleanly over
   * frames. Default `false` binds 1×1×1 placeholder noise, never takes the
   * march branch (gated on the runtime flag AND a non-zero coverage), and
   * leaves the sky fill byte-identical to the shipped parity path. Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   * @default false
   */
  cloudsInReflections?: boolean;
}

/**
 * A backend-neutral snapshot of a {@link CloudCollection}'s volumetric cloud
 * configuration, published to the context each frame via
 * {@link GraphicsContext#requestVolumetricClouds}. Structurally a
 * `CloudVolumetrics` (the field names mirror the historical `globe.cloud*` set
 * verbatim so the WebGPU cloud packer's read sites are unchanged), so this is
 * intentionally an open shape keyed by `enabled` plus the `cloud*` dials. Kept
 * loose (not a full field enumeration) because the scaffold slice stores it
 * without reading it; the consumer slice will narrow as needed.
 */
export interface VolumetricCloudRequest {
  enabled: boolean;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════
// ABSTRACT GRAPHICS CONTEXT CLASS
// ═══════════════════════════════════════════════════════════

/**
 * Abstract base class for graphics contexts.
 *
 * Both `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) extend this class.
 * Provides shared concrete implementations for:
 * - Context-aware logging with `[CesiumJS:type:id]` prefix
 * - Transactional publication to `ContextRegistry`
 * - Feature Renderer registry for backend-agnostic scene code
 * - Convenience type-checking getters (`isWebGPU`, `isWebGL`)
 * - Shared resource pool access
 */
export abstract class GraphicsContext {
  /** Immutable projection convention owned by this context. */
  protected _clipSpaceConvention: ClipSpaceConventionRecord =
    ClipSpaceConvention.WEBGL;

  /** Immutable limit/format snapshot owned by this context generation. */
  protected _graphicsCapabilities: GraphicsCapabilitiesRecord =
    GraphicsCapabilities.EMPTY;

  // ═══════════════════════════════════════════════════════════
  // STATIC: CONTEXT REGISTRY (singleton)
  // ═══════════════════════════════════════════════════════════

  /**
   * Global registry tracking ALL active GraphicsContext instances.
   * Supports multi-view, split-screen, and mixed-backend scenarios.
   *
   * @example
   * const allContexts = GraphicsContext.registry.all;
   * const webgpuContexts = GraphicsContext.registry.getByType(RendererType.WEBGPU);
   */
  private static _registry: ContextRegistry = new ContextRegistry();

  static get registry(): ContextRegistry {
    return GraphicsContext._registry;
  }

  // ═══════════════════════════════════════════════════════════
  // INSTANCE: Feature Renderer Registry
  // ═══════════════════════════════════════════════════════════

  /**
   * Array of registered feature renderers indexed by {@link FeatureRendererKey}.
   * Uses direct array-index access (O(1)) instead of string-keyed Map lookups.
   * Each backend populates this with its own implementations.
   * @private
   */
  /**
   * Per-key lazy loader: an async function that imports and registers
   * the corresponding feature renderer the first time it's needed.
   * Used for advanced renderers (Voxel, GaussianSplat, PointCloud, etc.)
   * that aren't part of the basic globe view — keeping them out of the
   * eager-imported `WebGPUFeatureRenderers` chunk lets esbuild split
   * them into separate dynamic chunks that only download on demand.
   *
   * Loaders are stored alongside the eager registry. The first readiness
   * lookup starts the loader and returns `loading`; only the selected backend
   * may complete that slot. The renderer-only compatibility adapter still
   * returns undefined until ready, so consumers with a legacy path must use
   * the readiness discriminator before falling through.
   */
  private _featureRendererLoaders: (
    (() => Promise<FeatureRenderer>) | undefined
  )[] = new Array(0);
  /**
   * Per-key public readiness. A registered-but-not-yet-requested loader uses
   * `unsupported` internally; the canonical readiness lookup immediately
   * advances it to `loading`. Keeping the dormant detail private preserves
   * the deliberately small four-state public contract.
   */
  private _featureRendererStatus: (FeatureRendererLoadStatus | undefined)[] =
    new Array(0);

  /** Current async-install generation for each feature slot. */
  private _featureRendererGenerations: number[] = new Array(0);

  /** Monotonic source for feature-slot generations. */
  private _nextFeatureRendererGeneration = 1;

  /** Completion listeners (Scene uses this to wake requestRenderMode). */
  private _featureRendererReadinessListeners =
    new Set<FeatureRendererReadinessListener>();

  private _featureRenderers: (FeatureRenderer | undefined)[] = new Array(
    FeatureRendererKey.COUNT,
  );

  // ═══════════════════════════════════════════════════════════
  // CONSTRUCTOR — Subclasses publish only at their initialization commit point
  // ═══════════════════════════════════════════════════════════

  /**
   * Called by subclass constructors. Subclasses MUST call `super()`, then
   * publish through `_registerWithRegistry()` only after initialization has
   * committed.
   */
  constructor() {
    // Registration is deferred — subclass must call _registerWithRegistry()
    // after its `id`, `rendererType`, and `canvas` are initialized.
    // This is because abstract getters aren't available in the base constructor.
  }

  /**
   * Register this context with the global registry.
   * Subclasses should call this at the END of their constructor,
   * after `id`, `rendererType`, and `canvas` are all initialized.
   *
   * Also verifies that the subclass implements all required abstract methods
   * at runtime (FORK-27 fix). TypeScript enforces this at compile time for .ts
   * files, but Context.js is plain JavaScript — a missing method would fail
   * silently or with an unhelpful error. This catches it early.
   * @protected
   */
  protected _registerWithRegistry(): void {
    this._verifyAbstractMethods();
    GraphicsContext._registry.register(this);
  }

  /**
   * Verify that the subclass implements all required abstract methods/getters.
   * Called during registration to catch missing implementations early,
   * especially for JavaScript subclasses where TypeScript can't enforce this.
   *
   * Only runs in debug builds (stripped in release via includeStart/includeEnd).
   * @private
   */
  private _verifyAbstractMethods(): void {
    //>>includeStart('debug', pragmas.debug);
    const requiredMethods = [
      "beginFrame",
      "endFrame",
      "clear",
      "resize",
      "draw",
      "getRendererString",
      // createPickId and getObjectByPickColor are concrete on GraphicsContext
      "readPixels",
      "createViewportQuadCommand",
      "createSync",
      "destroy",
    ];

    const requiredGetters = [
      "rendererType",
      "id",
      "canvas",
      "drawingBufferWidth",
      "drawingBufferHeight",
      "uniformState",
      "shaderCache",
      "textureCache",
      "cache",
      "defaultTexture",
      "isDestroyed",
    ];

    const proto = Object.getPrototypeOf(this);
    const className = proto?.constructor?.name ?? "Unknown";

    for (const method of requiredMethods) {
      // Reflect.get reads a property by dynamic name without casting.
      if (typeof Reflect.get(this, method) !== "function") {
        throw new Error(
          `${className} must implement abstract method '${method}' from GraphicsContext`,
        );
      }
    }

    for (const getter of requiredGetters) {
      // Check both prototype descriptors and own properties
      const descriptor =
        Object.getOwnPropertyDescriptor(proto, getter) ||
        Object.getOwnPropertyDescriptor(this, getter);
      const hasProperty = getter in this;
      if (!descriptor && !hasProperty) {
        throw new Error(
          `${className} must implement abstract getter '${getter}' from GraphicsContext`,
        );
      }
    }
    //>>includeEnd('debug');
  }

  /**
   * Unregister this context from the global registry.
   * Subclasses should call this in their `destroy()` method,
   * BEFORE destroying resources.
   * @protected
   */
  protected _unregisterFromRegistry(): void {
    GraphicsContext._registry.unregister(this.id);
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: IDENTITY & TYPE (must be implemented by subclass)
  // ═══════════════════════════════════════════════════════════

  /**
   * The renderer type for this context.
   * WebGL returns `RendererType.WEBGL`, WebGPU returns `RendererType.WEBGPU`.
   */
  abstract get rendererType(): RendererType;

  /**
   * Unique identifier for this context instance.
   * Used in logging, registry lookups, and multi-context scenarios.
   */
  abstract get id(): string;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: Convenience Type Getters
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether this is a WebGPU context.
   * Computed from `rendererType` — NOT a stored flag.
   *
   * Note: Scene code should prefer using abstract methods over branching
   * on this property. External/extension code can use it for diagnostics.
   */
  get isWebGPU(): boolean {
    return this.rendererType === RendererType.WEBGPU;
  }

  /**
   * Whether this is a WebGL context.
   * Computed from `rendererType`.
   */
  get isWebGL(): boolean {
    return this.rendererType === RendererType.WEBGL;
  }

  /**
   * AUDIT_2026_05_02 — capability getter for "does this backend keep
   * vertex typed arrays alive after `Buffer.create()` so callers can
   * read them back later via the loader, or does it discard them?"
   *
   * - WebGL: `false` — `Buffer.getBufferData()` exists, so the loader
   *   discards typed arrays after the GPU upload.
   * - WebGPU: `true` — no `getBufferData()` equivalent on `GPUBuffer`,
   *   so consumers (Model renderer, EdgeVisibility stage, b3dm path)
   *   need the typed array preserved at load time.
   *
   * Used by `GltfLoader.js` and `EdgeVisibilityPipelineStage.js` to
   * gate the typed-array-retention path without backend identity
   * branching. Default `false` (WebGL behavior); WebGPU overrides.
   */
  get requiresVertexTypedArrayRetention(): boolean {
    return false;
  }

  /**
   * AUDIT_2026_05_02 — capability getter for legacy `SunPostProcess`.
   * WebGL ships a dedicated `SunPostProcess` class that allocates its
   * own framebuffer + bloom shader chain when `scene.sunBloom = true`.
   * WebGPU has no equivalent class — sun-bloom on WebGPU is handled
   * inside `WebGPUPostProcessPipeline` (Bloom + LensFlare) instead.
   * Default `true` (WebGL allocates `SunPostProcess`); WebGPU overrides
   * to `false` so `FramebufferOrchestrator` skips the allocation.
   */
  get supportsLegacySunBloom(): boolean {
    return true;
  }

  /**
   * AUDIT_2026_05_02 — capability getter for stereo / WebVR rendering.
   * Both backends could in theory support per-eye viewport split, but
   * only WebGL has the matching `executeWebVRCommands` viewport-mutation
   * path wired today; WebGPU's scene renderer hard-codes the full-canvas
   * viewport. Default `true`; WebGPU overrides to `false` so
   * `Scene.useWebVR` setter can throw a clear error rather than
   * silently producing single-eye output.
   */
  get supportsStereoViewport(): boolean {
    return true;
  }

  /**
   * Capability getter for SYNCHRONOUS pixel readback (`readPixels()` returning
   * pixel data on the calling frame). WebGL's `gl.readPixels` is synchronous;
   * WebGPU has no synchronous readback (its `readPixels` is a required-abstract
   * shim that returns `null`, and real readback is async via
   * `readPixelsToPBO` + `mapAsync`).
   *
   * This exists because several call sites used `defined(context.readPixels)`
   * as a proxy for "is this WebGL" — but `readPixels` is a required abstract
   * method BOTH backends must implement, so `defined()` is `true` on WebGPU and
   * silently routed those sites into the synchronous WebGL branch. The visible
   * fallout: `PickDepth` never set its async depth texture, so `pickPosition` /
   * `sampleHeight` / `clampToHeight` returned `undefined` on WebGPU, and
   * `InstancingPipelineStage` dropped the CPU typed array WebGPU instanced
   * models need. Branch on this capability instead of `defined(readPixels)`.
   *
   * Default `true` (WebGL); WebGPU overrides to `false`.
   */
  get supportsSynchronousReadback(): boolean {
    return true;
  }

  /**
   * Capability getter for the encoding of the packed pick-depth texture this
   * context publishes to `PickDepth` (NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION,
   * Batch 252).
   *
   * `true` means ONE packed depth texture is shared by all frustum slices and
   * its values are LOGARITHMIC depth encoded against the FULL camera frustum
   * (`log2(eyeDistFromNear + 1) / log2(far - near + 1)` with the persistent
   * `scene.camera.frustum` near/far — the renderer-wide log-depth convention
   * of Batches 249-251). `Picking.pickPositionWorldCoordinates` uses this to
   * pick the full-frustum reconstruction path instead of the per-frustum-slice
   * loop (per-slice near/far against a full-frustum encode produced the
   * ~85,000 km antipode garbage of Batch 221).
   *
   * Default `false` (WebGL packs per-slice depth into per-slice PickDepth
   * framebuffers, reconstructed per slice); WebGPU overrides to mirror its
   * log-depth master switch.
   */
  get pickDepthFullFrustumLogEncode(): boolean {
    return false;
  }

  /**
   * Cloud-unification epic (WebGPU volumetric clouds via CloudCollection) —
   * backend-neutral publish seam. Scene code (`CloudCollection.update`) calls
   * this UNCONDITIONALLY when a collection's volumetric deck is enabled, so it
   * never has to branch on `isWebGPU` (Principle 2). The base implementation is
   * a NO-OP: the WebGL `Context` inherits it and volumetric requests simply
   * evaporate (WebGL renders no volumetric deck). `WebGPUContext` overrides this
   * to store the request for the env-effects phase to consume via
   * {@link GraphicsContext#consumeVolumetricCloudRequest}.
   *
   * Nothing calls this yet — the publish/consume wiring lands in a later slice
   * of the epic. See migration_doc/CLOUD_UNIFICATION_DESIGN.md §2.4.
   *
   * @param config - A {@link CloudVolumetrics}-shaped config snapshot for the
   *   frame's primary volumetric deck.
   */
  requestVolumetricClouds(config: VolumetricCloudRequest): void {
    // Base no-op. WebGL keeps this; only WebGPUContext consumes the request.
    // Referencing the param keeps the signature honest without a lint error.
    void config;
  }

  /**
   * Whether a collection published a volumetric-cloud request for the current
   * frame. This is a non-consuming scheduling signal: scene renderers may use
   * it to keep an otherwise command-empty environmental frame alive without
   * stealing the request from {@link GraphicsContext#consumeVolumetricCloudRequest}.
   *
   * The base implementation is always `false`; WebGPU overrides it alongside
   * its request storage.
   */
  get hasVolumetricCloudRequest(): boolean {
    return false;
  }

  /**
   * Retrieve (and clear) the volumetric cloud request published this frame via
   * {@link GraphicsContext#requestVolumetricClouds}. The base implementation
   * always returns `undefined` (WebGL never has a request); `WebGPUContext`
   * overrides it to return the stored request for the env-effects consumer.
   *
   * @returns The frame's volumetric cloud request, or `undefined` if none.
   */
  consumeVolumetricCloudRequest(): VolumetricCloudRequest | undefined {
    return undefined;
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: CANVAS & DIMENSIONS
  // ═══════════════════════════════════════════════════════════

  abstract get canvas(): HTMLCanvasElement;
  abstract get drawingBufferWidth(): number;
  abstract get drawingBufferHeight(): number;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: CAPABILITIES — Shared GPU Feature Queries
  // ═══════════════════════════════════════════════════════════

  abstract get depthTexture(): boolean;
  abstract get fragmentDepth(): boolean;
  abstract get stencilBuffer(): boolean;
  abstract get stencilBits(): number;
  abstract get msaa(): boolean;
  abstract get colorBufferFloat(): boolean;
  abstract get antialias(): boolean;
  abstract get standardDerivatives(): boolean;
  abstract get elementIndexUint(): boolean;
  abstract get floatBlend(): boolean;
  abstract get instancedArrays(): boolean;

  /**
   * Whether this context uses a 0-to-1 depth range (WebGPU) vs -1-to-1 (WebGL).
   * Scene code should use this instead of checking `rendererType === "webgpu"`.
   * Default: false (WebGL). WebGPU overrides to return true.
   */
  get depthRangeZeroToOne(): boolean {
    return this._clipSpaceConvention.depthRangeZeroToOne;
  }

  /** Immutable clip-space convention used by this context. */
  get clipSpaceConvention(): ClipSpaceConventionRecord {
    return this._clipSpaceConvention;
  }

  /** Immutable device limits and texture-format support for this context. */
  get graphicsCapabilities(): GraphicsCapabilitiesRecord {
    return this._graphicsCapabilities;
  }

  /** Compatibility alias for consumers migrating from ContextLimits. */
  get limits(): GraphicsCapabilitiesRecord {
    return this._graphicsCapabilities;
  }

  /**
   * Monotonic generation of native resources owned by this context. WebGL's
   * compatibility path retains its established context-loss lifecycle and
   * therefore stays at zero. WebGPU advances the value whenever a recovered
   * device invalidates every old-generation handle.
   */
  get resourceGeneration(): number {
    return 0;
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: COMPUTE SHADER CAPABILITIES
  //
  // These properties advertise the compute capabilities of this context.
  // Scene code should query these before dispatching compute work.
  //
  // Compute tiers:
  //   Tier 0 (GPGPU):  Render-to-texture "compute" via fragment shaders (WebGL 1/2)
  //   Tier 1 (Compute): Real GPU compute shaders (WebGPU, future WebGL 2.0 extension)
  //   Tier 2 (Advanced): Indirect dispatch, shared memory, atomics (WebGPU)
  //
  // WebGL 2.0 is expected to gain compute shader support via a future extension
  // (similar to GL_ARB_compute_shader / GL ES 3.1). These properties provide the
  // scaffolding so that when the extension ships, only Context.js needs updating.
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether this context supports real GPU compute shaders (not GPGPU workarounds).
   *
   * - **WebGL 2.0 (current):** `false` — no compute extension available yet.
   *   When `WEBGL_compute` or equivalent extension ships, `Context.js` will
   *   override this to return `true` after detecting the extension.
   * - **WebGPU:** `true` — native compute shader support.
   *
   * Scene code should check this before dispatching compute work:
   * ```javascript
   * if (context.supportsComputeShaders) {
   *   // Use real GPU compute (WebGPU or future WebGL 2.0 compute)
   * } else if (context.supportsGPGPU) {
   *   // Fall back to render-to-texture GPGPU
   * } else {
   *   // CPU fallback
   * }
   * ```
   */
  get supportsComputeShaders(): boolean {
    return false;
  }

  /**
   * Whether this context supports GPGPU (render-to-texture) compute.
   * This is the legacy compute method using fragment shaders + viewport quads.
   *
   * - **WebGL:** `true` — uses `ComputeEngine` + `ComputeCommand` (fragment shader GPGPU).
   * - **WebGPU:** `true` — can do GPGPU, but prefer real compute shaders.
   *
   * Default: true (all contexts support render-to-texture).
   */
  get supportsGPGPU(): boolean {
    return true;
  }

  /**
   * Whether this context supports indirect compute dispatch.
   * Indirect dispatch reads workgroup counts from a GPU buffer,
   * enabling fully GPU-driven pipelines.
   *
   * - **WebGL:** `false` — no indirect dispatch support.
   * - **WebGPU:** `true` — `dispatchWorkgroupsIndirect()` on `GPUComputePassEncoder`.
   */
  get supportsIndirectCompute(): boolean {
    return false;
  }

  /**
   * Whether this context supports shader storage buffers (SSBOs).
   * Storage buffers allow compute/vertex/fragment shaders to read/write
   * large structured data beyond the size limits of uniform buffers.
   *
   * - **WebGL 2.0 (current):** `false` — no SSBO extension yet.
   *   Future `WEBGL_shader_storage_buffer` extension would enable this.
   * - **WebGPU:** `true` — native storage buffer support via `storage` buffer type.
   */
  get supportsStorageBuffers(): boolean {
    return false;
  }

  /**
   * Maximum number of workgroups per dispatch dimension (X, Y, or Z).
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeWorkgroupsPerDimension` (typically 65535)
   */
  get maxComputeWorkgroupsPerDimension(): number {
    return 0;
  }

  /**
   * Maximum workgroup size (total invocations per workgroup).
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeInvocationsPerWorkgroup` (typically 256)
   */
  get maxComputeInvocationsPerWorkgroup(): number {
    return 0;
  }

  /**
   * Maximum size of shared (workgroup) memory in bytes.
   * Returns 0 if compute shaders are not supported.
   *
   * - **WebGL:** 0 (no compute support yet)
   * - **WebGPU:** Device limit `maxComputeWorkgroupStorageSize` (typically 16384)
   */
  get maxComputeWorkgroupStorageSize(): number {
    return 0;
  }

  // ═══════════════════════════════════════════════════════════
  // BACKEND-AGNOSTIC PREDICATES (for Scene / debug layers)
  //
  // Scene code MUST NOT branch on `isWebGPU`. Any behavioral divergence
  // between backends goes through one of these virtual predicates so a
  // future backend (e.g., a test mock, Vulkan-via-Tauri) can opt in
  // without touching Scene code. Defaults match WebGL; WebGPU overrides.
  // ═══════════════════════════════════════════════════════════

  /**
   * True if this backend requires a `SCENE_RENDERER` feature renderer to
   * be registered for scenes to produce visible output. WebGPU needs one
   * (it owns the canvas blit / post-process pipeline); WebGL does not —
   * the built-in multi-frustum executor handles everything.
   *
   * `Scene` reads this to decide whether to log a critical error when
   * the FR registration is missing.
   */
  get requiresSceneRenderer(): boolean {
    return false;
  }

  /**
   * True if this backend exposes the triangulation-debug helper
   * (`scene.triangulationDebug`). Only WebGPU wires up the primitive
   * index-utilities compute module today; WebGL returns false.
   */
  get supportsTriangulationDebug(): boolean {
    return false;
  }

  /**
   * Returns the render-bundle manager for this context, or `null` when
   * the backend does not have one. Scene uses this to register the
   * bundle cache as a snapshot freezable — the existing WebGL path has
   * no equivalent, so this returns `null` by default.
   *
   * The return type is intentionally structural so the base contract
   * doesn't pull in a WebGPU-specific class. Callers test for presence
   * and then invoke `asFreezable()` / `statistics` via duck-typing.
   */
  get renderBundleManager(): { asFreezable?: () => unknown } | null {
    return null;
  }

  /**
   * Subscribe to device-invalidation events. Fires when the backing GPU
   * device has been lost and its caches + driver-side handles need to
   * be dropped before the next frame so the next render uses the
   * recovered device cleanly.
   *
   * Subscriber callbacks should drop any cached `GPUBuffer`,
   * `GPUTexture`, `GPUBindGroup`, `GPURenderPipeline`, `GPUQuerySet`,
   * etc. they hold. The cache lookups repopulate lazily against the
   * new device on first post-recovery use.
   *
   * Default (WebGL path) returns a no-op disposer — WebGL contexts
   * don't emit a device-loss event with the same semantics; any
   * recovery is handled via `webglcontextrestored` at a different
   * layer.
   *
   * Mirrors the {@link WebGPUContext#onDeviceLost} callback chain but
   * focuses on cache invalidation rather than "stop drawing" semantics.
   * Fix sketch: **C-R12** of the Renderer-Deep principal-engineer review.
   *
   * @param _callback Called once per device-loss event before the
   *   recovery path attempts to resume rendering.
   * @returns A function that unregisters the callback.
   */
  onDeviceInvalidated(_callback: () => void): () => void {
    return () => {};
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: SHARED STATE & CACHES
  // ═══════════════════════════════════════════════════════════

  abstract get uniformState(): CesiumUniformState;
  abstract get shaderCache(): CesiumShaderCache;
  abstract get textureCache(): unknown;
  abstract get cache(): SceneGlobalCache;
  abstract get defaultTexture(): CesiumOpaqueTexture;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: FRAME LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  abstract beginFrame(): void;
  abstract endFrame(): void;
  abstract clear(clearCommand: unknown, passState?: unknown): void;
  abstract resize(): void;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: DRAWING
  // ═══════════════════════════════════════════════════════════

  abstract draw(drawCommand: CesiumDrawCommand, passState?: unknown): void;
  abstract getRendererString(): string;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: BACKEND-AGNOSTIC COMMAND EXECUTION
  // These methods allow Scene.js to dispatch commands without
  // checking isWebGPU. Each backend overrides as needed.
  // Default implementations are the WebGL path (no-ops or pass-through).
  // ═══════════════════════════════════════════════════════════

  /**
   * Execute a single draw command through this context's rendering backend.
   *
   * Scene.js calls this instead of checking `isWebGPU`.
   * - **WebGL (default):** Resolves derived commands (logDepth, HDR, pick,
   *   shadows) and dispatches via `command.execute(context, passState)`.
   * - **WebGPU:** Dispatches WebGPU draw commands through the active
   *   GPURenderPassEncoder. Silently skips non-WebGPU commands.
   *
   * @param command - The draw command to execute
   * @param scene - The scene (for frameState, hdr, debug flags)
   * @param passState - The current render pass state
   * @param debugFramebuffer - Optional debug framebuffer
   */
  executeDrawCommand(
    command: CesiumDrawCommand,
    scene: unknown,
    passState: unknown,
    debugFramebuffer?: unknown,
  ): void {
    // Default (WebGL): simple pass-through dispatch.
    // Context.js inherits this; the full derived-command resolution
    // stays in Scene.js for now (WebGL path unchanged).
    command.execute(this, passState as CesiumPassState);
  }

  /**
   * Execute compute commands for the current frame.
   *
   * - **WebGL (default):** Executes sun compute + queued compute commands
   *   through ComputeEngine.
   * - **WebGPU:** Executes commands with `isWebGPUComputeCommand` flag;
   *   skips sun compute (handled procedurally).
   *
   * @param computeCommandList - Array of compute commands
   * @param sunComputeCommand - The sun compute command (WebGL only)
   * @param computeEngine - The WebGL ComputeEngine
   */
  executeComputeCommands(
    computeCommandList: unknown[],
    sunComputeCommand: unknown,
    computeEngine: unknown,
  ): void {
    // Default (WebGL): execute sun compute + all queued commands
    if (sunComputeCommand !== undefined && sunComputeCommand !== null) {
      (sunComputeCommand as { execute(engine: unknown): void }).execute(
        computeEngine,
      );
    }
    for (let i = 0; i < computeCommandList.length; ++i) {
      (computeCommandList[i] as { execute(engine: unknown): void }).execute(
        computeEngine,
      );
    }
  }

  /**
   * Execute shadow map cast commands for the current frame.
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own cast logic).
   * - **WebGPU:** Dispatches through the SHADOW_MAP feature renderer's
   *   `renderCastPass()` and returns true.
   *
   * @param scene - The scene
   * @returns true if the context handled shadow casting, false to fall back
   */
  executeShadowMapCastCommands(scene: unknown): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  /**
   * Update and clear framebuffers for the current frame.
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own FBO logic).
   * - **WebGPU:** Sets environment state flags, clears via ClearCommand,
   *   returns true.
   *
   * @param scene - The scene
   * @param passState - The current pass state
   * @param clearColor - The background clear color
   * @returns true if the context handled framebuffer setup, false to fall back
   */
  updateAndClearFramebuffers(
    scene: unknown,
    passState: unknown,
    clearColor: CesiumColor | unknown,
  ): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  /**
   * Resolve framebuffers after rendering (OIT composite, post-processing).
   *
   * - **WebGL (default):** Returns false (Scene.js runs its own resolve logic).
   * - **WebGPU:** No-op for now (OIT/post-process not yet wired), returns true.
   *
   * @param scene - The scene
   * @param passState - The current pass state
   * @returns true if the context handled resolution, false to fall back
   */
  /**
   * Creates a backend-appropriate pick framebuffer.
   * WebGL: returns null (View.js falls back to PickFramebuffer).
   * WebGPU: returns a WebGPUPickFramebuffer instance.
   * @returns A pick framebuffer or null if the default (WebGL) should be used.
   */
  createPickFramebuffer(): unknown {
    return null;
  }

  resolveFramebuffers(scene: unknown, passState: unknown): boolean {
    // Default: not handled by context, Scene.js runs WebGL path
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: PICKING — Shared Pick ID Management
  //
  // Pick ID allocation is identical across both backends: a monotonically
  // incrementing uint32 counter maps to RGBA colors via Color.fromRgba().
  // The logic lives here (not in subclasses) to eliminate duplication.
  // Previously duplicated in Context.js, WebGPUContext.ts, AND
  // WebGPUPickManager.ts (three copies of the same code).
  //
  // Both backends inherit these methods. No override needed.
  // ═══════════════════════════════════════════════════════════

  /**
   * Map from 32-bit pick color key → associated object.
   * Shared across both WebGL and WebGPU backends.
   * @protected
   */
  // Pick registry — stores whatever PickTarget the caller passes to
  // createPickId. See {@link PickTarget} for the shape contract.
  protected _pickObjects: Map<number, PickTarget> = new Map();

  /**
   * Parallel map from pick color key → declared {@link PickKind} at
   * registration. Entries added here are always in lockstep with
   * `_pickObjects` — same key, cleared together. Stored as a parallel
   * structure (rather than folding into `_pickObjects`) to preserve the
   * `getObjectByPickColor` return type for existing callers.
   * @protected
   */
  protected _pickKinds: Map<number, PickKind> = new Map();

  /**
   * Monotonically incrementing counter for pick color allocation.
   * Uses Uint32Array for overflow-safe incrementing.
   * @protected
   */
  protected _nextPickColor: Uint32Array = new Uint32Array(1);

  /**
   * Create a unique pick ID for an object.
   *
   * Allocates a unique 32-bit RGBA color and associates it with the given
   * object. During pick rendering, fragments output this color. Reading
   * back the pixel and calling {@link getObjectByPickColor} returns the
   * object, or {@link getPickResult} returns both object and kind.
   *
   * @param object - The object to associate with this pick ID
   * @param kind - Optional discriminator for downstream branching. Defaults
   *   to `"custom"` so external callers don't need to pass anything; internal
   *   Cesium registrars pass their specific kind to enable typed
   *   `switch (result.kind)` consumer code.
   * @returns A {@link PickId} with `key`, `color`, `normalizedRgba`, and `destroy()`
   */
  createPickId(object: PickTarget, kind: PickKind = "custom"): CesiumPickId {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("object", object);
    //>>includeEnd('debug');

    // Increment with overflow wrapping (Uint32Array handles this)
    this._nextPickColor[0]++;
    const key = this._nextPickColor[0];
    const color = Color.fromRgba(key);

    this._pickObjects.set(key, object);
    this._pickKinds.set(key, kind);
    return new PickId(this._pickObjects, key, color, this._pickKinds);
  }

  /**
   * Shared decode from the two pickColor calling conventions to the
   * internal uint32 key. Extracted so `getObjectByPickColor` and
   * `getPickResult` stay in sync.
   * @private
   */
  private _pickColorToKey(pickColor: CesiumColor | number): number {
    if (typeof pickColor === "object" && pickColor !== null) {
      // WebGPU path: reconstruct key from RGB bytes (little-endian)
      return (
        (pickColor.red & 0xff) |
        ((pickColor.green & 0xff) << 8) |
        ((pickColor.blue & 0xff) << 16)
      );
    }
    // WebGL path: pickColor is already the uint32 key
    return pickColor as number;
  }

  /**
   * Get the object associated with a pick color.
   *
   * Accepts two calling conventions:
   * - **uint32** (WebGL path): A 32-bit RGBA value from `Color.byteToRgba(r,g,b,a)`
   * - **object** (WebGPU path): An `{red, green, blue}` object with 0-255 byte values,
   *   which is reconstructed to a key via little-endian RGB encoding.
   *
   * @param pickColor - The pick color key (uint32 or {red,green,blue} object)
   * @returns The object associated with the pick color, or undefined
   */
  getObjectByPickColor(
    pickColor: CesiumColor | number,
  ): PickTarget | undefined {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("pickColor", pickColor);
    //>>includeEnd('debug');
    return this._pickObjects.get(this._pickColorToKey(pickColor));
  }

  /**
   * Get the full pick record (target + declared kind) for a pick color.
   *
   * Prefer this over {@link getObjectByPickColor} when downstream code
   * wants to discriminate on {@link PickKind} instead of walking
   * `instanceof` chains. The pattern is:
   *
   * ```ts
   * const result = context.getPickResult(pickColor);
   * if (!result) return;
   * switch (result.kind) {
   *   case "billboard":   return handleBillboard(result.target);
   *   case "tile-feature": return handleTileFeature(result.target);
   *   case "custom":      return handleUserPick(result.target);
   *   // ... TS exhaustiveness catches missing cases
   * }
   * ```
   *
   * @param pickColor - The pick color key (uint32 or {red,green,blue} object)
   * @returns The {@link PickResult} if a target is registered for this
   *   color, otherwise undefined.
   */
  getPickResult(pickColor: CesiumColor | number): PickResult | undefined {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("pickColor", pickColor);
    //>>includeEnd('debug');
    const key = this._pickColorToKey(pickColor);
    const target = this._pickObjects.get(key);
    if (target === undefined) {
      return undefined;
    }
    // Missing kind should be impossible (set in lockstep with _pickObjects)
    // but default to "custom" if something skipped the shared path.
    const kind = this._pickKinds.get(key) ?? "custom";
    return { target, kind };
  }

  /**
   * Number of currently registered pick objects.
   * Useful for diagnostics and debugging.
   */
  get pickObjectCount(): number {
    return this._pickObjects.size;
  }

  /**
   * Clear all pick registrations and reset the color counter.
   * Useful during device loss recovery or context reset.
   */
  clearPickObjects(): void {
    this._pickObjects.clear();
    this._pickKinds.clear();
    this._nextPickColor[0] = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: PIXEL READBACK
  // ═══════════════════════════════════════════════════════════

  abstract readPixels(readState: unknown): unknown;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: VIEWPORT COMMANDS
  // ═══════════════════════════════════════════════════════════

  /**
   * Build a viewport-quad draw command for screen-space effects. Each
   * backend accepts a superset of {@link ViewportQuadCommandOptionsBase}
   * (WebGPU adds bind-group entries / pipeline config) and returns a
   * handle with `execute` + optional `destroy`. Callers that need
   * backend-specific fields must go through the concrete subclass type.
   *
   * @param fragmentShader - GLSL source (WebGL) or WGSL source / descriptor
   *   object with `_wgslCode` (WebGPU).
   * @param options - Shared options; each backend extends with its own.
   */
  abstract createViewportQuadCommand(
    fragmentShader:
      string | CesiumOpaqueShaderSource | { readonly _wgslCode?: string },
    options?: ViewportQuadCommandOptionsBase,
  ): ViewportQuadCommandHandle;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: GPU-COMPLETION FENCE FACTORY
  // ═══════════════════════════════════════════════════════════

  /**
   * AUDIT_2026_05_02 C.7 — backend-agnostic GPU-completion fence.
   * Mirrors the Babylon / PlayCanvas pattern: subclasses materialize
   * the right concrete object so scene code can call
   * `context.createSync(opts)` without branching on `isWebGPU`.
   *
   * - WebGL: returns a {@link Sync} wrapping `gl.fenceSync` +
   *   `gl.clientWaitSync`.
   * - WebGPU: returns a {@link WebGPUSync} wrapping
   *   `device.queue.onSubmittedWorkDone()`.
   *
   * Both implementations expose the same `waitForSignal(scheduleFn)`
   * promise-returning API so consumers stay backend-agnostic.
   */
  abstract createSync(options?: object): {
    waitForSignal(scheduleFunction: (cb: () => void) => void): Promise<void>;
    isDestroyed(): boolean;
    destroy(): void;
  };

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: DESTROYED STATE
  // ═══════════════════════════════════════════════════════════

  abstract isDestroyed(): boolean;

  // ═══════════════════════════════════════════════════════════
  // ABSTRACT: RESOURCE LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  abstract destroy(): void;

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: RENDER PASS MANAGEMENT
  // Default implementations are no-ops (WebGL doesn't have explicit passes).
  // WebGPU overrides these.
  // ═══════════════════════════════════════════════════════════

  /**
   * The active GPU command encoder, or null on backends without explicit
   * encoders (WebGL). Scene code treats this as an opaque handle — it's
   * only passed through to feature renderers that know the concrete type.
   */
  get currentCommandEncoder(): unknown {
    return null;
  }

  /**
   * A depth-only texture view suitable for sampling in compute shaders,
   * or null on backends without explicit depth textures (WebGL).
   * Scene code treats this as an opaque handle — only feature renderers
   * (Hi-Z occlusion) use the concrete view.
   */
  get depthOnlyTextureView(): unknown {
    return null;
  }

  /**
   * End the currently active render pass.
   * WebGL: no-op (no explicit render passes)
   * WebGPU: ends the current GPURenderPassEncoder
   */
  endCurrentRenderPass(): void {
    // No-op for WebGL. WebGPU overrides.
  }

  /**
   * Begin a new render pass.
   * WebGL: no-op
   * WebGPU: starts a new GPURenderPassEncoder
   */
  beginRenderPass(descriptor?: unknown): unknown {
    // No-op for WebGL. WebGPU overrides.
    return undefined;
  }

  /**
   * Resume the default canvas render pass after a custom pass.
   * WebGL: no-op
   * WebGPU: starts a new render pass targeting the canvas with loadOp: "load"
   */
  resumeDefaultRenderPass(): unknown {
    // No-op for WebGL. WebGPU overrides.
    return undefined;
  }

  /**
   * Whether a render pass is currently active.
   * WebGL: conceptually always true
   * WebGPU: depends on encoder state
   */
  get hasActiveRenderPass(): boolean {
    return true; // WebGL always has one. WebGPU overrides.
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: RESOURCE FACTORY METHODS (optional overrides)
  // Default implementations throw — subclasses implement as needed.
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a texture using the context's native texture type.
   * Each backend narrows `options` and the return type in its override;
   * the base accepts `unknown` since callers always go through the
   * concrete subclass.
   * @param options - Texture creation options
   * @returns A backend-native texture object
   */
  createTexture(options: unknown): unknown {
    throw new Error(
      `${this._logPrefix()} createTexture not implemented for ${this.rendererType}`,
    );
  }

  /**
   * Create a GPU buffer using the context's native buffer type. See
   * {@link createTexture} for the rationale on using `unknown` in the
   * abstract signature.
   * @param options - Buffer creation options
   * @returns A backend-native buffer object
   */
  createBuffer(options: unknown): unknown {
    throw new Error(
      `${this._logPrefix()} createBuffer not implemented for ${this.rendererType}`,
    );
  }

  /**
   * Build a native draw command from an abstract RenderCommand.
   * @param renderCommand - The abstract RenderCommand
   * @returns A backend-native draw command
   */
  buildRenderCommand(renderCommand: unknown): unknown {
    throw new Error(
      `${this._logPrefix()} buildRenderCommand not implemented for ${this.rendererType}`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: DEBUG / DIAGNOSTIC SURFACE
  // Backend-specific introspection routed through the abstract base
  // so Scene code can call this without violating the "no
  // Renderer/WebGPU imports from Scene" rule. Default returns an
  // empty object; backends override to expose what they own.
  // ═══════════════════════════════════════════════════════════

  /**
   * Phase 6 debug surface — returns a snapshot of backend-specific
   * diagnostic state (bundle cache stats, fog froxel state, GPU memory
   * usage, etc.). Default returns an empty object. Backends override
   * to populate the fields they care about. Pure read; safe to call
   * any time, including from `Scene.getDebugSnapshot()`.
   *
   * Stable shape contract: callers should treat any returned field as
   * optional (`stats.bundleManager?.cacheSize`) since the WebGL
   * backend will leave most fields unset.
   */
  getRendererStatistics(): DebugStatsObject {
    return {};
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: CONTEXT-AWARE LOGGING
  // All messages automatically include [CesiumJS:type:shortId]
  // ═══════════════════════════════════════════════════════════

  /**
   * Log a message with context-aware prefix.
   * Automatically includes renderer type and context ID.
   *
   * @param level - Log level: 'info', 'warn', or 'error'
   * @param message - The message to log
   *
   * @example
   * context.log('error', 'Pipeline creation failed for terrain shader');
   * // Output: [CesiumJS:webgpu:ctx-a3f7] Pipeline creation failed for terrain shader
   */
  log(level: "info" | "warn" | "error", message: string): void {
    const prefix = this._logPrefix();
    switch (level) {
      case "info":
        console.log(`${prefix} ${message}`);
        break;
      case "warn":
        console.warn(`${prefix} ${message}`);
        break;
      case "error":
        console.error(`${prefix} ${message}`);
        break;
    }
  }

  /**
   * Generate the log prefix string for this context.
   * @private
   */
  private _logPrefix(): string {
    let shortId: string;
    try {
      shortId = this.id ? this.id.substring(0, 8) : "unknown";
    } catch {
      shortId = "init";
    }

    let type: string;
    try {
      type = this.rendererType ?? "unknown";
    } catch {
      type = "unknown";
    }

    return `[CesiumJS:${type}:${shortId}]`;
  }

  // ═══════════════════════════════════════════════════════════
  // CONCRETE: FEATURE RENDERER REGISTRY (Phase C)
  //
  // Scene code calls context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION)
  // instead of importing WebGPUBillboardRenderer directly.
  // Uses array-indexed lookups with FeatureRendererKey enum for O(1) access.
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a feature renderer for this context.
   * Called by each backend during initialization.
   *
   * Accepts any of the three feature renderer sub-types:
   * - {@link CollectionRenderer} — renderers with `update()` (most common)
   * - {@link PrimitiveCommandRenderer} — the PRIMITIVE command factory
   * - {@link SystemRenderer} — renderers with specialized entry points
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @param renderer - The backend-specific feature renderer implementation
   *
   * @example
   * import FeatureRendererKey from "./FeatureRendererKey.js";
   * // In WebGPUContext initialization:
   * this.registerFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION, renderer);
   */
  registerFeatureRenderer(
    key: number,
    renderer: CollectionRenderer | PrimitiveCommandRenderer | SystemRenderer,
  ): void {
    const generation = this._advanceFeatureRendererGeneration(key);
    this._featureRenderers[key] = renderer;
    this._featureRendererLoaders[key] = undefined;
    const ready: FeatureRendererReadiness = {
      kind: "ready",
      renderer,
      generation,
    };
    this._featureRendererStatus[key] = ready;
    this._notifyFeatureRendererReadiness(key, ready);
  }

  /**
   * Register an async loader that resolves the renderer for `key` on
   * first access. Used for advanced renderers that should not pull their
   * implementation modules into the main bundle. The loader is invoked
   * exactly once and returns the renderer to install. Installation remains
   * owned by this registry so a completion from a stale device/context
   * generation cannot publish itself.
   *
   * @param key A FeatureRendererKey numeric enum value
   * @param loader A function returning the feature renderer to install
   */
  registerFeatureRendererLoader(
    key: number,
    loader: () => Promise<FeatureRenderer>,
  ): void {
    // Don't overwrite an already-resolved entry — the renderer wins.
    if (this._featureRenderers[key] !== undefined) return;
    const generation = this._advanceFeatureRendererGeneration(key);
    this._featureRendererLoaders[key] = loader;
    this._featureRendererStatus[key] = { kind: "unsupported", generation };
  }

  /**
   * Get a feature renderer by key.
   * Returns undefined if no renderer is registered for the given key.
   * Uses direct array-index access — O(1) with no hashing overhead.
   *
   * The returned value is the base {@link FeatureRenderer} type.
   * Callers that need sub-type methods should narrow the type:
   * - `.js` scene files: just call methods directly (no TS checking)
   * - `.ts` files: cast to the appropriate sub-type, e.g.:
   *   `const fr = context.getFeatureRenderer(key) as CollectionRenderer;`
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @returns The registered feature renderer, or undefined
   *
   * @example
   * import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
   * const fr = context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION);
   * if (fr) { (fr as CollectionRenderer).update(collection, frameState); }
   */
  getFeatureRenderer(key: number): FeatureRenderer | undefined {
    const state = this.getFeatureRendererReadiness(key);
    return state.kind === "ready" ? state.renderer : undefined;
  }

  /**
   * Canonical synchronous feature lookup. Unlike the legacy renderer-only
   * adapter, this preserves the distinction between an unsupported backend,
   * an in-flight implementation, a ready renderer, and a stable failure.
   * Consumers that own a legacy implementation must only fall through for
   * `unsupported`; `loading` and `failed` belong to the selected backend.
   */
  getFeatureRendererReadiness(key: number): FeatureRendererReadiness {
    const existing = this._featureRenderers[key];
    if (existing !== undefined) {
      const current = this._featureRendererStatus[key];
      if (current?.kind === "ready" && current.renderer === existing) {
        return current;
      }
      const generation = this._currentFeatureRendererGeneration(key);
      const ready: FeatureRendererReadiness = {
        kind: "ready",
        renderer: existing,
        generation,
      };
      this._featureRendererStatus[key] = ready;
      return ready;
    }

    return this._kickLazyLoader(key);
  }

  /**
   * Async variant of {@link getFeatureRenderer}. Awaits any in-flight
   * loader (or starts the cold loader) and returns the FR once it is ready.
   * Returns undefined for unsupported, failed, or invalidated generations.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   */
  async getFeatureRendererAsync(
    key: number,
  ): Promise<FeatureRenderer | undefined> {
    const status = this.getFeatureRendererReadiness(key);
    if (status.kind === "ready") {
      return status.renderer;
    }
    if (status?.kind === "loading") {
      await status.promise;
    }
    const settled = this._featureRendererStatus[key];
    return settled?.kind === "ready" ? settled.renderer : undefined;
  }

  /**
   * Introspect the load status for a feature-renderer key. Used by debug
   * snapshots and registry-audit tooling. This is non-starting: a dormant
   * loader remains represented by `unsupported` until a readiness lookup
   * requests it, avoiding debug tooling that accidentally downloads chunks.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   */
  getFeatureRendererStatus(key: number): FeatureRendererReadiness {
    const status = this._featureRendererStatus[key];
    if (status !== undefined) {
      return status;
    }
    const unsupported: FeatureRendererReadiness = {
      kind: "unsupported",
      generation: this._currentFeatureRendererGeneration(key),
    };
    this._featureRendererStatus[key] = unsupported;
    return unsupported;
  }

  /**
   * True when a lazy loader is currently in flight for this key.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   */
  isFeatureRendererLoading(key: number): boolean {
    return this._featureRendererStatus[key]?.kind === "loading";
  }

  /**
   * True when the feature loader failed in the current generation. Failures
   * are stable; ordinary lookup never retries them.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   */
  hasFeatureRendererFailed(key: number): boolean {
    return this._featureRendererStatus[key]?.kind === "failed";
  }

  /**
   * Internal: kick the lazy loader for `key` if appropriate. Returns the
   * resulting status so the async wrapper can await the in-flight
   * promise without re-deriving it.
   */
  private _kickLazyLoader(key: number): FeatureRendererReadiness {
    const status = this._featureRendererStatus[key];
    if (
      status?.kind === "loading" ||
      status?.kind === "ready" ||
      status?.kind === "failed"
    ) {
      return status;
    }
    const loader = this._featureRendererLoaders[key];
    const generation = this._currentFeatureRendererGeneration(key);
    if (!loader) {
      const unsupported: FeatureRendererReadiness = {
        kind: "unsupported",
        generation,
      };
      this._featureRendererStatus[key] = unsupported;
      return unsupported;
    }

    // Deferring the call into a microtask converts synchronous loader throws
    // into the same stable failed state as dynamic-import rejection.
    const promise = Promise.resolve()
      .then(loader)
      .then((renderer) => {
        // Context destruction uses destroyObject(), which replaces class
        // methods with throwOnDestroyed. The generation array remains plain
        // data and is advanced before teardown, so pending imports must guard
        // against that data directly rather than calling a replaced helper.
        if (
          this.isDestroyed() ||
          this._featureRendererGenerations[key] !== generation
        ) {
          return undefined;
        }
        if (renderer === undefined || renderer === null) {
          throw new Error(
            `Feature renderer loader for key ${key} resolved without a renderer`,
          );
        }
        this._featureRenderers[key] = renderer;
        this._featureRendererLoaders[key] = undefined;
        const ready: FeatureRendererReadiness = {
          kind: "ready",
          renderer,
          generation,
        };
        this._featureRendererStatus[key] = ready;
        this._notifyFeatureRendererReadiness(key, ready);
        return renderer;
      })
      .catch((err): FeatureRenderer | undefined => {
        if (
          this.isDestroyed() ||
          this._featureRendererGenerations[key] !== generation
        ) {
          return undefined;
        }
        const failed: FeatureRendererReadiness = {
          kind: "failed",
          error: err,
          generation,
        };
        this._featureRendererStatus[key] = failed;
        this.log(
          "warn",
          `Lazy feature renderer load failed for key ${key}: ${err?.message ?? err}`,
        );
        this._notifyFeatureRendererReadiness(key, failed);
        return undefined;
      });

    const next: FeatureRendererReadiness = {
      kind: "loading",
      promise,
      generation,
    };
    this._featureRendererStatus[key] = next;
    return next;
  }

  /**
   * Subscribe to async feature completion. A Scene should request a frame
   * when it receives a `ready` state so requestRenderMode cannot hibernate
   * across a dynamic import. Returns a per-listener unsubscribe function.
   */
  subscribeFeatureRendererReadiness(
    listener: FeatureRendererReadinessListener,
  ): () => void {
    this._featureRendererReadinessListeners.add(listener);
    return () => {
      this._featureRendererReadinessListeners.delete(listener);
    };
  }

  /** Advance every lazy slot so pending completions can no longer install. */
  protected _invalidatePendingFeatureRenderers(): void {
    const count = Math.max(
      this._featureRendererLoaders.length,
      this._featureRenderers.length,
      this._featureRendererStatus.length,
    );
    for (let key = 0; key < count; key++) {
      const generation = this._advanceFeatureRendererGeneration(key);
      const renderer = this._featureRenderers[key];
      this._featureRendererStatus[key] = renderer
        ? { kind: "ready", renderer, generation }
        : { kind: "unsupported", generation };
    }
  }

  private _advanceFeatureRendererGeneration(key: number): number {
    const generation = this._nextFeatureRendererGeneration++;
    this._featureRendererGenerations[key] = generation;
    return generation;
  }

  private _currentFeatureRendererGeneration(key: number): number {
    return (
      this._featureRendererGenerations[key] ??
      this._advanceFeatureRendererGeneration(key)
    );
  }

  private _notifyFeatureRendererReadiness(
    key: number,
    state: FeatureRendererReadiness,
  ): void {
    for (const listener of this._featureRendererReadinessListeners) {
      try {
        listener(key, state);
      } catch (error) {
        this.log(
          "warn",
          `Feature renderer readiness listener failed for key ${key}: ${String(
            (error as Error)?.message ?? error,
          )}`,
        );
      }
    }
  }

  /**
   * Check if a feature renderer is registered.
   *
   * @param key - A {@link FeatureRendererKey} numeric enum value
   * @returns True if a renderer is registered for this feature
   */
  hasFeatureRenderer(key: number): boolean {
    return this._featureRenderers[key] !== undefined;
  }

  /**
   * Get count of registered feature renderers.
   * Useful for diagnostics and debugging.
   */
  get registeredFeatureCount(): number {
    let count = 0;
    for (let i = 0; i < this._featureRenderers.length; i++) {
      if (this._featureRenderers[i] !== undefined) {
        count++;
      }
    }
    return count;
  }

  /**
   * Destroy all registered feature renderers.
   * Called during context destruction.
   * @protected
   */
  protected _destroyFeatureRenderers(): void {
    // Invalidate before clearing so every pending loader observes a stale
    // generation when its microtask eventually settles.
    this._invalidatePendingFeatureRenderers();
    // Feature renderer destroy() functions are designed for scene-side cleanup
    // and expect their owning scene object as the first argument (e.g.,
    // destroyBillboardResources(collection)). During context destruction the
    // GPU device is being torn down, which releases all GPU resources
    // automatically. We just null out references here.
    const renderers = this._featureRenderers;
    for (let i = 0; i < renderers.length; i++) {
      renderers[i] = undefined;
      this._featureRendererLoaders[i] = undefined;
      const generation = this._advanceFeatureRendererGeneration(i);
      this._featureRendererStatus[i] = { kind: "unsupported", generation };
    }
    this._featureRendererReadinessListeners.clear();
  }
}

// ═══════════════════════════════════════════════════════════
// TYPE GUARDS
// ═══════════════════════════════════════════════════════════

/**
 * Type guard to check if a feature renderer is a {@link CollectionRenderer}.
 * Returns true if the renderer has a callable `update` method.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer has an `update()` method
 *
 * @example
 * const fr = context.getFeatureRenderer(key);
 * if (isCollectionRenderer(fr)) {
 *   fr.update(collection, frameState); // TypeScript knows `update` exists
 * }
 */
export function isCollectionRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is CollectionRenderer {
  return (
    renderer !== undefined &&
    typeof (renderer as CollectionRenderer).update === "function"
  );
}

/**
 * Type guard to check if a feature renderer is a {@link PrimitiveCommandRenderer}.
 * Returns true if the renderer has `createCommands` and `updateCommandUniforms`.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer has command factory methods
 */
export function isPrimitiveCommandRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is PrimitiveCommandRenderer {
  return (
    renderer !== undefined &&
    typeof (renderer as PrimitiveCommandRenderer).createCommands ===
      "function" &&
    typeof (renderer as PrimitiveCommandRenderer).updateCommandUniforms ===
      "function"
  );
}

/**
 * Type guard to check if a feature renderer is a {@link SystemRenderer}.
 * Returns true for any renderer that is NOT a CollectionRenderer or
 * PrimitiveCommandRenderer — i.e., it has specialized entry points.
 *
 * @param renderer - The feature renderer to check
 * @returns True if the renderer is a system renderer
 */
export function isSystemRenderer(
  renderer: FeatureRenderer | undefined,
): renderer is SystemRenderer {
  return (
    renderer !== undefined &&
    !isCollectionRenderer(renderer) &&
    !isPrimitiveCommandRenderer(renderer)
  );
}

/**
 * Type guard to check if an object is a GraphicsContext.
 * Works with both instanceof checks and duck-typing for JS interop.
 *
 * @param obj - Object to check
 * @returns True if the object is or behaves like a GraphicsContext
 */
export function isGraphicsContext(obj: unknown): obj is GraphicsContext {
  if (obj instanceof GraphicsContext) {
    return true;
  }
  // Duck-type fallback for JS interop
  return (
    obj &&
    typeof obj === "object" &&
    "rendererType" in obj &&
    "canvas" in obj &&
    "isWebGPU" in obj &&
    "uniformState" in obj &&
    "beginFrame" in obj &&
    typeof obj.beginFrame === "function" &&
    "endFrame" in obj &&
    typeof obj.endFrame === "function" &&
    "destroy" in obj &&
    typeof obj.destroy === "function"
  );
}

export default GraphicsContext;
