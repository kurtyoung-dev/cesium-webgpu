/**
 * Ambient type declarations for CesiumJS JavaScript modules consumed by
 * WebGPU TypeScript files. These declarations allow WebGPU TS code to
 * reference FrameState, UniformState, DrawCommand, etc. with proper
 * types instead of `any`.
 *
 * NOTE: These are MINIMAL interfaces — they expose only what the WebGPU
 * renderer actually reads. The full JS classes have many more properties.
 * Add fields here as the WebGPU code touches new parts of the JS API.
 *
 * To update: grep for `as any` in the WebGPU directory, check what
 * property is being accessed, and add it to the appropriate interface.
 */

// ─── Opaque branded types ────────────────────────────────────────────────
// For CesiumJS objects that WebGPU code passes through without accessing
// internals. Branded unknowns prevent accidental property access while
// remaining assignable from the real JS classes.

// Pass-through types: WebGPU code receives these from JS but doesn't
// access their internals. We use `object` (not `Record<string, unknown>`)
// because `Record` requires an explicit index signature that JS classes
// don't have. `object` is assignable from any class instance while still
// preventing primitive assignment. Property access requires explicit
// narrowing via `as` casts, which is the correct behavior for opaque
// cross-language boundaries.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type CesiumOpaqueObject = object;
type CesiumOpaqueTexture = CesiumOpaqueObject;
// Framebuffer is one of: WebGPU render-target wrapper (method-based),
// legacy WebGL Framebuffer.js (field-based), WebGPU pick FBO (direct GPU
// texture refs), or a raw GPUTexture. Every member is optional so the
// type still accepts any pass-through JS object, but narrowing via
// `typeof fb.getColorTexture === "function"`, `fb._colorTextures`, or
// `fb._isWebGPUPickFBO` works directly without `as unknown as` casts.
// When adding a fifth framebuffer shape, extend this intersection rather
// than casting around it at the call site.
type CesiumOpaqueFramebuffer = Partial<WebGPURenderTargetLike> & {
  _colorTextures?: CesiumTextureWithSource[];
  destroy?(): void;
  // WebGPU pick FBO marker + fields (see WebGPUPickFramebuffer.ts)
  _isWebGPUPickFBO?: boolean;
  colorTexture?: GPUTexture | null;
  depthTexture?: GPUTexture | null;
  colorView?: GPUTextureView;
  depthView?: GPUTextureView;
  width?: number;
  height?: number;
};
type CesiumOpaqueVertexArray = CesiumOpaqueObject;
type CesiumOpaqueShaderProgram = CesiumOpaqueObject;
type CesiumOpaqueShaderSource = CesiumOpaqueObject;
type CesiumOpaqueRenderState = CesiumOpaqueObject;
// Frustum culling volume with the six world-space planes Cesium's
// `CullingVolume` exposes. Previously typed as `CesiumOpaqueObject`
// which made `.planes` a type error even though it's a well-known
// public property. Typing it explicitly unblocks point-cloud + occlusion
// culling paths without pulling in the full Core type.
interface CesiumOpaqueCullingVolume {
  // Six Cartesian4 planes: (n.xyz = outward-facing unit normal,
  // w = -distance from world origin along the normal). Order is
  // near, far, left, right, top, bottom per `CullingVolume.planes`.
  planes: ReadonlyArray<CesiumCartesian4>;
}
type CesiumOpaqueJulianDate = CesiumOpaqueObject;
type CesiumOpaqueMapProjection = CesiumOpaqueObject;
type CesiumOpaqueTerrainProvider = CesiumOpaqueObject;
type CesiumOpaqueSampler = CesiumOpaqueObject;

// ─── Math types (minimal) ────────────────────────────────────────────────

interface CesiumCartesian2 {
  x: number;
  y: number;
  clone(result?: CesiumCartesian2): CesiumCartesian2;
  equals(right?: CesiumCartesian2): boolean;
  equalsEpsilon(
    right?: CesiumCartesian2,
    relativeEpsilon?: number,
    absoluteEpsilon?: number,
  ): boolean;
}

interface CesiumCartesian3 {
  x: number;
  y: number;
  z: number;
  clone(result?: CesiumCartesian3): CesiumCartesian3;
  equals(right?: CesiumCartesian3): boolean;
  equalsEpsilon(
    right?: CesiumCartesian3,
    relativeEpsilon?: number,
    absoluteEpsilon?: number,
  ): boolean;
}

interface CesiumCartesian4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface CesiumColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  // Cartesian4-compatible aliases (Color is used as vec4 in some paths)
  x?: number;
  y?: number;
  z?: number;
  w?: number;
  clone(result?: CesiumColor): CesiumColor;
  equals(right?: CesiumColor): boolean;
  equalsEpsilon(right?: CesiumColor, epsilon?: number): boolean;
  toCssColorString(): string;
  toCssHexString(): string;
  toRgba(): number;
  toBytes(result?: number[]): number[];
  withAlpha(alpha: number, result?: CesiumColor): CesiumColor;
  brighten(magnitude: number, result: CesiumColor): CesiumColor;
  darken(magnitude: number, result: CesiumColor): CesiumColor;
}

// ─── Ellipsoid ──────────────────────────────────────────────────────────

interface CesiumEllipsoid {
  radii: CesiumCartesian3;
  radiiSquared: CesiumCartesian3;
  radiiToTheFourth: CesiumCartesian3;
  oneOverRadii: CesiumCartesian3;
  oneOverRadiiSquared: CesiumCartesian3;
  minimumRadius: number;
  maximumRadius: number;
  geocentricSurfaceNormal(
    cartesian: CesiumCartesian3,
    result?: CesiumCartesian3,
  ): CesiumCartesian3;
  geodeticSurfaceNormal(
    cartesian: CesiumCartesian3,
    result?: CesiumCartesian3,
  ): CesiumCartesian3;
  cartographicToCartesian(
    cartographic: { longitude: number; latitude: number; height: number },
    result?: CesiumCartesian3,
  ): CesiumCartesian3;
  scaleToGeodeticSurface(
    cartesian: CesiumCartesian3,
    result?: CesiumCartesian3,
  ): CesiumCartesian3 | undefined;
}

/**
 * Column-major 16-element matrix — structurally compatible with the real
 * `Matrix4` class (plain ES6 class with numeric-indexed 0..15 slots).
 * NOTE: Matrix4 is NOT a Float64Array subclass; using an interface (not
 * a Float64Array intersection) so assignments from real `Matrix4`
 * instances type-check without casts.
 */
interface CesiumMatrix4 {
  readonly length: 16;
  [index: number]: number;
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
  7: number;
  8: number;
  9: number;
  10: number;
  11: number;
  12: number;
  13: number;
  14: number;
  15: number;
  clone(result?: CesiumMatrix4): CesiumMatrix4;
  equals(right?: CesiumMatrix4): boolean;
  equalsEpsilon(right?: CesiumMatrix4, epsilon?: number): boolean;
}

interface CesiumBoundingRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CesiumBoundingSphere {
  center: CesiumCartesian3;
  radius: number;
  boundingSphere?: CesiumBoundingSphere;
}

interface CesiumRectangle {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
}

// ─── Post-process stage types ───────────────────────────────────────────

interface CesiumPostProcessStage {
  enabled: boolean;
  type?: number;
  uniforms?: Record<string, number>;
}

interface CesiumPostProcessStageCollection {
  bloom: CesiumPostProcessStage;
  ambientOcclusion: CesiumPostProcessStage;
  fxaa: CesiumPostProcessStage;
  _tonemapping: CesiumPostProcessStage;
  _tonemappingType: number;
  _depthOfField: CesiumPostProcessStage;
  _activeStagesChanged: boolean;
  length: number;
  /** Sidecar WebGPU cache attached by WebGPUPostProcessStageCollection —
   *  tracks which stages are enabled / initialized on the WebGPU pipeline. */
  _webgpuCache?: import("./WebGPUPostProcessStageCollection.js").PostProcessCache;
  get(index: number): CesiumPostProcessStage;
}

// ─── Weather ────────────────────────────────────────────────────────────

interface CesiumWeatherConfig {
  enabled: boolean;
  type: string | number;
  intensity: number;
  windSpeed: number;
  windDirection: CesiumCartesian3;
  maxParticles: number;
  particleLifetime: number;
  particleSize: number;
  turbulence: number;
  spawnRadius: number;
  groundAltitude: number;
  humidity: number;
}

// ─── Environment state ──────────────────────────────────────────────────

interface CesiumEnvironmentState {
  originalFramebuffer: CesiumOpaqueFramebuffer | undefined;
  clearGlobeDepth: boolean;
  useDepthPlane: boolean;
  useGlobeDepthFramebuffer: boolean;
  useOIT: boolean;
  usePostProcess: boolean;
  usePostProcessSelected: boolean;
  useInvertClassification: boolean;
  renderTranslucentDepthForPick: boolean;
  useWebVR: boolean;
}

// ─── Globe translucency state ───────────────────────────────────────────

interface CesiumGlobeTranslucencyState {
  useDepthPlane: boolean;
}

// ─── FrameState ──────────────────────────────────────────────────────────

interface CesiumFrameStatePasses {
  render: boolean;
  pick: boolean;
  pickVoxel: boolean;
  depth: boolean;
  postProcess: boolean;
  offscreen: boolean;
}

interface CesiumFrameStateFog {
  enabled: boolean;
  renderable: boolean;
  density: number | undefined;
  visualDensityScalar: number | undefined;
  sse: number | undefined;
  minimumBrightness: number | undefined;
  offset: number | undefined;
}

interface CesiumFrameState {
  context: CesiumGraphicsContext;
  graphicsContext: CesiumGraphicsContext;
  commandList: CesiumAnyDrawCommand[];
  panoramaCommandList: CesiumAnyDrawCommand[];
  shadowMaps: CesiumShadowMap[];
  mode: number;
  morphTime: number;
  frameNumber: number;
  newFrame: boolean;
  time: CesiumOpaqueJulianDate;
  mapProjection: CesiumOpaqueMapProjection;
  camera: CesiumCamera | undefined;
  cameraUnderground: boolean;
  cullingVolume: CesiumOpaqueCullingVolume;
  maximumScreenSpaceError: number | undefined;
  pixelRatio: number;
  passes: CesiumFrameStatePasses;
  /** True when a pick pass is collecting metadata rather than object IDs.
   *  Set by Picking.js for metadata-picking render cycles. */
  pickingMetadata: boolean;
  afterRender: Array<() => boolean | undefined>;
  scene3DOnly: boolean;
  fog: CesiumFrameStateFog;
  atmosphere:
    | { hueShift: number; saturationShift: number; brightnessShift: number }
    | undefined;
  atmosphericConditions:
    | {
        fogDensity?: number;
        volumetricFog?: {
          enabled: boolean;
          density?: number;
          scatteringCoefficient?: number;
          maxDistance?: number;
          heightFalloff?: number;
          falloff?: number;
          quality?: string;
          fogAlbedo?: { r: number; g: number; b: number };
          fogAnisotropy?: number;
          ambientStrength?: number;
          enableScatteringOcclusion?: boolean;
        };
        lighting?: { enabled?: boolean; moonIntensity?: number };
        varyingAtmosphereDensity?:
          | number
          | { enabled?: boolean; noiseScale?: number; noiseStrength?: number };
        weather?: CesiumWeatherConfig;
      }
    | undefined;
  verticalExaggeration: number;
  verticalExaggerationRelativeHeight: number;
  shadowState: {
    shadowsEnabled: boolean;
    // True when at least one shadow-casting LIGHT source is present
    // (as opposed to analytical shadow passes). Gating receive-side
    // logic on this flag matches Scene.js:4344 / OIT.js. Declared
    // separately from `shadowsEnabled` because analytical shadows
    // (e.g. debug picking) can be active without a light source.
    lightShadowsEnabled: boolean;
    shadowMaps: CesiumShadowMap[];
    lightShadowMaps: CesiumShadowMap[];
    nearPlane: number;
    farPlane: number;
  };
  splitPosition: number;
  backgroundColor: CesiumColor | undefined;
  light:
    | { direction?: CesiumCartesian3; color?: CesiumColor; intensity?: number }
    | undefined;
  lights:
    | Array<{
        direction?: CesiumCartesian3;
        color?: CesiumColor;
        intensity?: number;
      }>
    | undefined;
  useLogDepth: boolean;
  minimumTerrainHeight: number;
  invertClassification: boolean;
  invertClassificationColor: CesiumColor | undefined;
  sunDirectionWC: CesiumCartesian3;
  moonDirectionWC: CesiumCartesian3;
  moonPhaseFraction: number;
  deltaTime: number;
  brdfLutGenerator: import("../GraphicsContext.js").Renderable | undefined;
  // Debug flags
  debugShowFrustums: boolean;
  debugShowDepthAsColor: boolean;
  debugShowCommands: boolean;
  debugShowImageryProbe: boolean;
  debugShowImageryLayer: boolean;
  debugShowGlobeWireframe: boolean;
  debugShowTriangulation: boolean;
  debugShowTerrainLOD: boolean;
  debugShowTerrainNormals: boolean;
  debugDepthAsColorMode: number;
}

// ─── Camera (minimal) ────────────────────────────────────────────────────

interface CesiumCamera {
  positionWC: CesiumCartesian3;
  positionCartographic: { longitude: number; latitude: number; height: number };
  directionWC: CesiumCartesian3;
  upWC: CesiumCartesian3;
  rightWC: CesiumCartesian3;
  frustum: {
    near: number;
    far: number;
    fov?: number;
    aspectRatio?: number;
    projectionMatrix?: CesiumMatrix4;
  };
  viewMatrix: CesiumMatrix4;
  inverseViewMatrix: CesiumMatrix4;
  inverseViewProjection: CesiumMatrix4;
  setView(options: {
    destination?: CesiumCartesian3;
    // HeadingPitchRoll or Quaternion — pass-through to the JS side.
    orientation?: CesiumOpaqueObject;
  }): void;
}

// ─── UniformState ────────────────────────────────────────────────────────

interface CesiumUniformState {
  readonly frameState: CesiumFrameState | undefined;
  readonly view: CesiumMatrix4;
  readonly projection: CesiumMatrix4;
  readonly inverseProjection: CesiumMatrix4;
  readonly inverseView: CesiumMatrix4;
  /**
   * Inverse-transpose of the view matrix, used to transform plane
   * equations from world to eye space (plane `n_eye = view^-T · n_world`).
   * Computed lazily by `UniformState` — may be undefined until first
   * `update()`. Marked optional because upstream `UniformState.js` does
   * not declare the property at construction time; consumers handle the
   * undefined case via the `view`-only fallback path in
   * `WebGPUClippingPlaneCollection`.
   */
  readonly inverseViewTranspose?: CesiumMatrix4 | undefined;
  readonly viewProjection: CesiumMatrix4;
  /**
   * Last frame's `viewProjection`, cloned before current-frame state is
   * written. Consumed by the TAA / motion-vector path (DP-H41, Batch 27).
   */
  readonly previousViewProjection: CesiumMatrix4;
  readonly normal: CesiumMatrix4;
  readonly modelView: CesiumMatrix4;
  readonly modelViewProjection: CesiumMatrix4;
  readonly modelViewProjectionRelativeToEye: CesiumMatrix4;
  readonly modelViewRelativeToEye: CesiumMatrix4;
  readonly inverseModelView: CesiumMatrix4;
  readonly encodedCameraPositionMCHigh: CesiumCartesian3;
  readonly encodedCameraPositionMCLow: CesiumCartesian3;
  readonly sunDirectionEC: CesiumCartesian3;
  readonly sunDirectionWC: CesiumCartesian3;
  readonly sunPositionWC: CesiumCartesian3;
  readonly moonDirectionEC: CesiumCartesian3;
  readonly lightDirectionEC: CesiumCartesian3;
  readonly lightDirectionWC: CesiumCartesian3;
  readonly lightColor: CesiumCartesian3;
  readonly lightColorHdr: CesiumCartesian3;
  readonly eyeHeight: number;
  readonly fogDensity: number | undefined;
  readonly fogVisualDensityScalar: number | undefined;
  readonly fogMinimumBrightness: number | undefined;
  readonly currentFrustum: CesiumCartesian2;
  readonly entireFrustum: CesiumCartesian2;
  readonly pixelRatio: number;
  readonly pass: number | undefined;
  readonly backgroundColor: CesiumColor;
  readonly splitPosition: number;
  readonly cameraPosition: CesiumCartesian3;
  readonly orthographicIn3D: boolean;
  readonly _context: CesiumGraphicsContext;
  viewport: CesiumBoundingRectangle;
  model: CesiumMatrix4;
  globeDepthTexture: CesiumOpaqueTexture | undefined;
  update(frameState: CesiumFrameState): void;
  updateCamera(camera: CesiumCamera): void;
  updateFrustum(frustum: { near: number; far: number }): void;
  updatePass(pass: number): void;
}

// ─── GraphicsContext (base) ──────────────────────────────────────────────

interface CesiumGraphicsContext {
  readonly id: string;
  readonly rendererType: string;
  readonly isWebGPU: boolean;
  // Backend-agnostic predicates that Scene uses instead of `isWebGPU`.
  // Defaults (WebGL) live on `GraphicsContext`; WebGPU overrides both.
  readonly requiresSceneRenderer: boolean;
  readonly supportsTriangulationDebug: boolean;
  readonly renderBundleManager: { asFreezable?: () => unknown } | null;
  readonly uniformState: CesiumUniformState;
  readonly cache: SceneGlobalCache;
  readonly defaultTexture: CesiumOpaqueTexture;
  readonly stencilBuffer: boolean;
  readonly msaa: boolean;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly device?: GPUDevice | null;
  readonly canvas: { width: number; height: number };
  readonly _canvas?: { width: number; height: number } | null;
  readonly _device?: GPUDevice | null;
  readonly shaderCache?: CesiumShaderCache & {
    preprocessOnly?: (source: string, options?: { label?: string }) => string;
  };
  readonly _canvasFormat?: GPUTextureFormat;
  readonly presentationFormat?: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
  useHardwareClipDistances?: boolean;
  /** WebGPU-only: lazy-initialized ring buffer for per-frame uniform
   *  uploads. Present as `object | null` on WebGPUContext; absent on
   *  WebGL Context. Touched eagerly by GlobeSurfaceRenderer to force
   *  construction (BUG-9 guard). */
  readonly uniformAllocator?: object | null;
  /** WebGPU-only: lazy-initialized GPU compute LOD processor for point
   *  clouds. `null` until first point cloud dispatches; absent on
   *  WebGL Context. Typed as `object | null` here (not
   *  `WebGPUPointCloudLODProcessorInstance`) to keep this file free of
   *  WebGPU-renderer imports — consumers cast to the real interface at
   *  the call site via an explicit `import type`. */
  readonly pointCloudLOD?: object | null;
  /** WebGPU-only: lazy-initialized cascaded shadow map renderer.
   *  `null` until `scene.useCascadedShadowMaps` activates it; absent
   *  on WebGL Context. Same typing-boundary pattern as
   *  `pointCloudLOD` — consumers cast to the real interface at the
   *  call site. */
  readonly csmRenderer?: object | null;
  /** WebGPU-only: class constructor for compute command objects.
   *  Registered by WebGPUContext after PerformanceManager wires up
   *  compute dispatchers. Optional because WebGL has no analogue. */
  _computeCommandClass?: new (...args: unknown[]) => object;
  // Dynamic sidecar caches attached by effect renderers. Each effect
  // module defines and exports its own cache shape, and only its own
  // module reads or writes its slot — the cache owner stays the source
  // of truth. We reference the exported types via `import()` rather than
  // a top-level import so this ambient declaration file stays a script
  // (no `export` at top level) and its types remain globally visible.
  _ssrCache?: import("./WebGPUSSREffect.js").SSRCache;
  _cloudCache?: import("./WebGPUProceduralCloudRenderer.js").CloudCache;
  _weatherCache?: import("./WebGPUWeatherRenderer.js").WeatherCache;
  getOrCreateSampler?(descriptor: GPUSamplerDescriptor): GPUSampler;
  createRenderTarget?(options: {
    width: number;
    height: number;
    colorFormats?: GPUTextureFormat[];
    depthStencilFormat?: GPUTextureFormat;
    sampleCount?: number;
    label?: string;
  }): WebGPURenderTargetLike | null;
  /** WebGPU-only: lazy-instantiated central render-pipeline cache. Feature
   *  renderers should route their `device.createRenderPipeline()` calls
   *  through this cache (`getPipeline(descriptor)`) so identical
   *  descriptors dedupe across renderer instances. `null` on WebGL and
   *  before the WebGPU device exists. See `WebGPUContext.ts:3924`. */
  readonly webgpuPipelineCache?:
    | import("./WebGPURenderPipelineCache.js").WebGPURenderPipelineCache
    | null;
  /** WebGPU-only: lazy-instantiated central compute-pipeline cache.
   *  Compute-pipeline consumers (Weather, VolumetricFog, AutoExposure,
   *  GPUCuller, PointCloudLODProcessor) route their
   *  `device.createComputePipeline()` calls through this cache so
   *  identical (name, layout, entryPoint) tuples dedupe across renderer
   *  instances. `null` on WebGL and before the WebGPU device exists.
   *  Added Batch 76. */
  readonly webgpuComputePipelineCache?:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null;
  getFeatureRenderer(key: number): CesiumFeatureRenderer | undefined;
  registerFeatureRenderer(key: number, renderer: CesiumFeatureRenderer): void;
  createPickId(
    object: import("../GraphicsContext.js").PickTarget,
    kind?: import("../GraphicsContext.js").PickKind,
  ): CesiumPickId;
  getObjectByPickColor(
    color: CesiumColor | number,
  ): import("../GraphicsContext.js").PickTarget | undefined;
  getPickResult(
    color: CesiumColor | number,
  ): import("../GraphicsContext.js").PickResult | undefined;
  log(level: string, message: string): void;
}

// ─── FeatureRenderer ────────────────────────────────────────────────────

interface CesiumFeatureRenderer {
  update?(...args: unknown[]): void;
  execute?(...args: unknown[]): void;
  render?(...args: unknown[]): void;
  composite?(...args: unknown[]): void;
  destroy?(): void;
  isDestroyed?(): boolean;
  /** Lazy-construction pattern: some feature renderers register a
   *  `RendererClass` constructor that gets instantiated on first touch
   *  (or via `_warmUpPipelines`) and cached on `_instance`. */
  RendererClass?: new (ctx: CesiumGraphicsContext) => CesiumOpaqueObject;
  _instance?: CesiumOpaqueObject;
}

// ─── PickId ─────────────────────────────────────────────────────────────

interface CesiumPickId {
  object: import("../GraphicsContext.js").PickTarget;
  key: number;
  color: CesiumColor;
  destroy(): void;
}

// ─── DrawCommand ─────────────────────────────────────────────────────────

interface CesiumDrawCommand {
  boundingVolume: CesiumBoundingSphere | undefined;
  orientedBoundingBox: CesiumBoundingSphere | undefined;
  modelMatrix: CesiumMatrix4 | undefined;
  primitiveType: number;
  vertexArray: CesiumOpaqueVertexArray | undefined;
  count: number | undefined;
  offset: number;
  instanceCount: number;
  shaderProgram: CesiumOpaqueShaderProgram | undefined;
  uniformMap: Record<string, () => unknown> | undefined;
  renderState: CesiumOpaqueRenderState | undefined;
  framebuffer: CesiumOpaqueFramebuffer | undefined;
  pass: number | undefined;
  owner: import("./WebGPUDrawCommand.js").WebGPUCommandOwner | undefined;
  castShadows: boolean;
  receiveShadows: boolean;
  cull: boolean;
  occlude: boolean;
  sortKey: number;
  sortPriority: number;
  materialSortId: number;
  dirty: boolean;
  derivedCommands: Record<string, CesiumDrawCommand>;
  pickId: string | undefined;
  indexCount?: number;
  vertexCount?: number;
  // WebGL path: (context, passState). WebGPU path: (passEncoder). The
  // overload set covers both so WebGPUSceneRenderer / WebGPUContext can
  // forward the current `GPURenderPassEncoder` without a cast.
  execute(context: CesiumGraphicsContext, passState?: CesiumPassState): void;
  execute(passEncoder: GPURenderPassEncoder): void;
}

// ─── PassState ───────────────────────────────────────────────────────────

interface CesiumPassState {
  context: CesiumGraphicsContext;
  framebuffer: CesiumOpaqueFramebuffer | undefined;
  blendingEnabled: boolean | undefined;
  scissorTest:
    | { enabled: boolean; rectangle: CesiumBoundingRectangle }
    | undefined;
  viewport: CesiumBoundingRectangle | undefined;
}

// ─── GlobeSurfaceTile ────────────────────────────────────────────────────

interface CesiumTerrainMesh {
  center: CesiumCartesian3;
  vertices: Float32Array | undefined;
  indices: Uint8Array | Uint16Array | Uint32Array | undefined;
  encoding: CesiumTerrainEncoding | undefined;
  indexCountWithoutSkirts: number | undefined;
  _webgpuGeneration?: number;
}

interface CesiumTerrainEncoding {
  center: CesiumCartesian3;
  matrix: CesiumMatrix4 | undefined;
  minimumHeight: number;
  maximumHeight: number;
  hasVertexNormals: boolean;
  hasWebMercatorT: boolean;
  // DP-H25 — true when the terrain tile carries the true WGS84 geodetic
  // surface normal as an extra per-vertex attribute. When set, the
  // WebGPU pipeline adds the attribute at shaderLocation 2 with 12B
  // trailing stride, and the vertex shader consumes it via the
  // `GEODETIC_NORMAL` define. Source: `TerrainEncoding` in upstream
  // Cesium + `createVerticesFromQuantizedTerrainMesh.js:512`.
  hasGeodeticSurfaceNormals: boolean;
  quantization: number;
  stride: number;
}

interface CesiumGlobeSurfaceTile {
  imagery: CesiumTileImagery[];
  boundingSphere3D: CesiumBoundingSphere;
  waterMaskTexture: CesiumOpaqueTexture | undefined;
  waterMaskTranslationAndScale: CesiumCartesian4;
  terrainData: CesiumOpaqueObject;
  vertexArray: CesiumOpaqueVertexArray | undefined;
  tileBoundingRegion:
    | {
        boundingSphere?: CesiumBoundingSphere;
        boundingVolume?: CesiumBoundingSphere;
      }
    | undefined;
  mesh: CesiumTerrainMesh | undefined;
  fill: { mesh: CesiumTerrainMesh | undefined } | undefined;
  center: CesiumCartesian3 | undefined;
  renderedMesh: CesiumTerrainMesh | undefined;
  surfaceShader: CesiumOpaqueShaderProgram | undefined;
  isClipped: boolean;
  clippedByBoundaries: boolean;
  data: CesiumOpaqueObject;
}

interface CesiumTileImagery {
  readyImagery:
    | {
        imageryLayer:
          | {
              alpha: number;
              brightness: number;
              contrast: number;
              saturation: number;
              split: number;
              nightAlpha: number;
              dayAlpha: number;
              show: boolean;
            }
          | undefined;
        texture: CesiumOpaqueTexture | undefined;
        textureWebGL: CesiumOpaqueTexture | undefined;
        image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
        rectangle: CesiumRectangle | undefined;
        state: number;
        _webgpuReprojectedTexture: GPUTexture | undefined;
      }
    | undefined;
  textureTranslationAndScale: CesiumCartesian4 | undefined;
  textureCoordinateRectangle: CesiumCartesian4 | undefined;
  texCoordsRectangle: CesiumCartesian4 | undefined;
  useWebMercatorT: boolean;
}

// ─── ShadowMap ───────────────────────────────────────────────────────────

interface CesiumShadowMap {
  enabled: boolean;
  softShadows: boolean;
  darkness: number;
  size: number;
  readonly isPointLight: boolean;
  readonly outOfView: boolean;
  /** Shadow map matrix — CesiumMatrix4 in the single-map case, Float32Array
   *  for CSM cascade swapping (which stores cascade VPs as Float32Array). */
  _shadowMapMatrix: CesiumMatrix4 | Float32Array | undefined;
  _textureSize: CesiumCartesian2 | undefined;
  _primitiveBias:
    | { depthBias: number; normalShadingSmooth: number }
    | undefined;
  _terrainBias: { depthBias: number; normalShadingSmooth: number } | undefined;
  _isPointLight: boolean;
  _lightDirectionEC: CesiumCartesian3;
  passes: CesiumShadowPass[];
  _webgpuCache: CesiumShadowMapWebGPUCache | undefined;
}

/** Minimal shape of a ShadowPass inside ShadowMap. */
interface CesiumShadowPass {
  commandList: CesiumAnyDrawCommand[];
}

/** Shape of the WebGPU sidecar cache on a ShadowMap. */
interface CesiumShadowMapWebGPUCache {
  depthTextureView?: GPUTextureView;
  [key: string]: unknown;
}

// ─── ImageBasedLighting ─────────────────────────────────────────────────

interface CesiumImageBasedLighting {
  imageBasedLightingFactor: CesiumCartesian2;
  sphericalHarmonicCoefficients: CesiumCartesian3[] | undefined;
  _specularEnvironmentCubeMap:
    | {
        ready: boolean;
        texture: CesiumOpaqueTexture | undefined;
        maximumMipmapLevel: number;
        _texture?: { _webgpuTexture?: { view?: GPUTextureView } };
        _version?: number;
      }
    | undefined;
  _previousFrameNumber: number;
  _previousFrameContext: CesiumGraphicsContext | undefined;
  // WebGPU sidecar fields (set by WebGPUImageBasedLighting)
  _webgpuCache?: CesiumOpaqueObject;
  _webgpuSpecularView?: GPUTextureView;
  _webgpuDiffuseView?: GPUTextureView;
  _webgpuSampler?: GPUSampler;
  _webgpuSHBuffer?: GPUBuffer;
  _webgpuHasSH?: boolean;
  _webgpuMaxMipLevel?: number;
  _webgpuIBLFactor?: Float32Array | number;
}

// ─── Imagery (readyImagery sub-object) ──────────────────────────────────

interface CesiumReadyImagery {
  imageryLayer:
    | {
        alpha: number;
        brightness: number;
        contrast: number;
        saturation: number;
        split: number;
        nightAlpha: number;
        dayAlpha: number;
        show: boolean;
      }
    | undefined;
  texture: CesiumOpaqueTexture | undefined;
  textureWebGL: CesiumOpaqueTexture | undefined;
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  rectangle: CesiumRectangle | undefined;
  state: number;
  key?: string;
  x?: number;
  y?: number;
  level?: number;
  _webgpuReprojectedTexture?: GPUTexture;
  _source?: CesiumOpaqueObject;
}

// ─── BrdfLutGenerator / DynamicEnvironmentMapManager ────────────────────

interface CesiumObjectWithWebGPUCache {
  _webgpuCache?: CesiumOpaqueObject;
  [key: string]: unknown;
}

// ─── Scene ───────────────────────────────────────────────────────────────

interface CesiumScene {
  readonly frameState: CesiumFrameState;
  readonly context: CesiumGraphicsContext;
  readonly camera: CesiumCamera;
  readonly globe: CesiumGlobe | undefined;
  readonly mode: number;
  readonly postProcessStages: CesiumPostProcessStageCollection;
  readonly highDynamicRange: boolean;
  readonly taaEnabled: boolean;
  readonly useCascadedShadowMaps: boolean;
  /**
   * Optional user-tunable resolution (per side) for the cascaded shadow
   * atlas. Read lazily at CSM init time; changes after init require a
   * dispose + reinit to take effect.
   */
  readonly cascadedShadowMapResolution?: number;
  readonly weather: CesiumWeatherConfig | undefined;
  readonly snapshotMode:
    | {
        enabled: boolean;
        isFrozen: boolean;
        registerFreezable(
          name: string,
          freezable: { freeze(): void; thaw(): void },
        ): void;
        unregisterFreezable(name: string): void;
      }
    | undefined;
  readonly debugCommandFilter:
    | ((cmd: CesiumDrawCommand | CesiumAnyDrawCommand) => boolean)
    | undefined;
  _frameState: CesiumFrameState;
  _view: { frustumCommandsList?: CesiumFrustumCommands[] };
  _picking: {
    pick?(
      scene: CesiumScene,
      windowPosition: CesiumCartesian2,
    ): CesiumOpaqueObject | undefined;
    getPickDepth?(
      scene: CesiumScene,
      index: number,
    ): {
      getDepth?(x: number, y: number): number;
      update?(
        context: CesiumGraphicsContext,
        texture: CesiumOpaqueTexture,
      ): void;
    };
  };
  _context: CesiumGraphicsContext;
  _globe: CesiumGlobe | undefined;
  _alternateSceneRenderer: CesiumFeatureRenderer | undefined;
  _clearColorCommand: {
    color: CesiumColor;
    execute(context: CesiumGraphicsContext, passState: CesiumPassState): void;
  };
  _useOIT: boolean;
  _useWebVR: boolean;
  _globeTranslucencyState: CesiumGlobeTranslucencyState;
  _environmentState: CesiumEnvironmentState;
  _enableWeather: boolean;
  _enableSSR: boolean;
  invertClassification: boolean;
  opaqueFrustumNearOffset: number;
  mapProjection: CesiumOpaqueMapProjection;
  ssrMaxDistance: number;
  ssrThickness: number;
  ssrMaxSteps: number;
  ssrStride: number;
  ssrReflectionStrength: number;
}

// ─── Globe ───────────────────────────────────────────────────────────────

interface CesiumGlobe {
  show: boolean;
  depthTestAgainstTerrain: boolean;
  tileCacheSize: number;
  maximumScreenSpaceError: number;
  enableLighting: boolean;
  showWaterEffect: boolean;
  showProceduralClouds: boolean;
  oceanNormalMapUrl: string;
  terrainProvider: CesiumOpaqueTerrainProvider;
  _surface: {
    _tileProvider?: CesiumGlobeTileProvider;
    _tilesToRender?: unknown[];
  };
  _ellipsoid: {
    maximumRadius: number;
    oneOverRadii: CesiumCartesian3;
    radii: CesiumCartesian3;
  };
  ellipsoid?: {
    maximumRadius: number;
    oneOverRadii: CesiumCartesian3;
    radii: CesiumCartesian3;
  };
  showGroundAtmosphere?: boolean;
  atmosphereRayleighScaleHeight?: number;
  atmosphereMieScaleHeight?: number;
  atmosphereRayleighCoefficient?: CesiumCartesian3;
  atmosphereMieCoefficient?: CesiumCartesian3;
  atmosphereMieAnisotropy?: number;
  atmosphereLightIntensity?: number;
  dynamicAtmosphereLighting?: boolean;
  cloudLayerBottom?: number;
  cloudLayerTop?: number;
  cloudCoverage?: number;
  cloudQuality?: number;
  cloudDensity?: number;
  cloudWindSpeed?: number;
  cloudWindDirection?: CesiumCartesian2;
  _webgpuAtmosphereCache?: {
    uniformBuffer: GPUBuffer | null;
    data: Float32Array;
    enabled: boolean;
    dirty: boolean;
  };
  _webgpuAtmosphereBuffer?: GPUBuffer | null;
  _webgpuAtmosphereEnabled?: boolean;
}

// ─── FrustumCommands ─────────────────────────────────────────────────────

interface CesiumFrustumCommands {
  commands: CesiumAnyDrawCommand[][];
  indices: number[];
  near: number;
  far: number;
}

// ─── GlobeSurfaceTileProvider ────────────────────────────────────────────

interface CesiumGlobeTileProvider {
  cartographicLimitRectangle: CesiumRectangle;
  clippingPlanes:
    | { enabled: boolean; length: number; unionClippingRegions?: boolean }
    | undefined;
  clippingPolygons: { enabled: boolean; length: number } | undefined;
  showWaterEffect: boolean;
  oceanNormalMap: CesiumOpaqueTexture | undefined;
  oceanDeepColor: CesiumColor;
  oceanFresnelPower?: number;
  nightIntensity?: number;
  oceanReflectivity?: number;
  nightFadeOutDistance: number;
  nightFadeInDistance: number;
  hasWaterMask: boolean;
  enableLighting: boolean;
  translucencyEnabled: boolean;
  /**
   * HSB shift fields mirrored from `Globe.atmosphere{Hue,Saturation,
   * Brightness}Shift`. `Globe.update()` copies these onto the tile
   * provider each frame. Read by the terrain tile UB writer.
   */
  hueShift?: number;
  saturationShift?: number;
  brightnessShift?: number;
  [key: string]: unknown;
}

// ─── ReadState (pick readback) ───────────────────────────────────────────

interface CesiumReadState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  framebuffer?: CesiumOpaqueFramebuffer;
}

// ─── Sidecar pattern ─────────────────────────────────────────────────────

interface CesiumObjectWithWebGPUCache {
  _webgpuCache?: CesiumOpaqueObject;
  show?: boolean;
  length?: number;
  modelMatrix?: CesiumMatrix4;
  // InvertClassification-specific fields
  _highlightColor?: CesiumColor;
  _enabled?: boolean;
  // GlobeTranslucencyState-specific fields
  _derivedCommandTypesToUpdate?: number[];
  _derivedCommandTypesToUpdateLength?: number;
  // PointCloud-specific fields
  _parsedContent?: { positions?: Float32Array; colors?: Float32Array } | null;
  _pointCloud?: {
    _parsedContent?: { positions?: Float32Array; colors?: Float32Array } | null;
  } | null;
  _pointsLength?: number;
  // GaussianSplat-specific fields
  _splatData?: ArrayBufferView | null;
  _renderResources?: { splatBuffer?: ArrayBufferView | null } | null;
  _splatCount?: number;
  // Cloud collection-specific fields
  _clouds?: Array<{
    position?: CesiumCartesian3;
    scale?: CesiumCartesian2;
    brightness?: number;
    slice?: number;
    color?: CesiumColor;
  }>;
  get?(index: number): CesiumObjectWithWebGPUCache | null;
  // Post-process stage collection fields
  bloom?: CesiumPostProcessStage;
  ambientOcclusion?: CesiumPostProcessStage;
  fxaa?: CesiumPostProcessStage;
  _tonemapping?: CesiumPostProcessStage;
  _tonemappingType?: number;
  _depthOfField?: CesiumPostProcessStage;
  _activeStagesChanged?: boolean;
  // Ellipsoid primitive-specific fields
  radii?: CesiumCartesian3;
  _oneOverEllipsoidRadiiSquared?: CesiumCartesian3;
  material?: { uniforms?: { color?: CesiumColor } };
}

// ─── Duck-typed command dispatch ─────────────────────────────────────────

interface CesiumAnyDrawCommand {
  /** Bounding sphere — typed loosely because JS-sourced DrawCommand
   *  instances have their `boundingVolume` inferred as `{}` from the
   *  untyped `options.boundingVolume` field. All sphere fields are
   *  optional here so both well-typed CesiumBoundingSphere values and
   *  loosely-typed JS values assign without casts; WebGPU readers check
   *  `bv.center` before dereferencing (see WebGPUSceneRenderer GPU
   *  culling path).
   *
   *  `distanceSquaredTo` is a method on Cesium's real `BoundingSphere`
   *  class — declaring it here as optional lets the WebGPU sort path
   *  call `bv.distanceSquaredTo(eye)` (with a null-guard first) without
   *  needing a cast. JS-sourced values that happen not to carry the
   *  method land in the null-guard branch. */
  boundingVolume?: {
    center?: CesiumCartesian3;
    radius?: number;
    boundingSphere?: { radius?: number };
    distanceSquaredTo?: (cartesian: {
      x: number;
      y: number;
      z: number;
    }) => number;
  };
  pass?: number;
  castShadows?: boolean;
  receiveShadows?: boolean;
  cull?: boolean;
  occlude?: boolean;
  owner?: import("./WebGPUDrawCommand.js").WebGPUCommandOwner;
  execute?(...args: unknown[]): void;
  // WebGPU-specific rendering fields
  pipeline?: GPURenderPipeline;
  _pipeline?: GPURenderPipeline;
  _webgpuShaderType?: string;
  isWebGPUDrawCommand?: boolean;
  bindGroups?: GPUBindGroup[];
  vertexBuffers?: Array<GPUBuffer | { buffer: GPUBuffer; size: number }>;
  indexBuffer?: GPUBuffer | { buffer: GPUBuffer; size: number };
  indexCount?: number;
  indexFormat?: GPUIndexFormat;
  vertexCount?: number;
  instanceCount?: number;
  _blendEnabled?: boolean;
  _oitPipeline?: GPURenderPipeline;
  clone?(): CesiumAnyDrawCommand;
  // Derived command override flags
  _depthOnly?: boolean;
  _colorWriteMask?: number;
  _depthWriteEnabled?: boolean;
  _logDepth?: boolean;
  _pickMode?: boolean;
  _pickColor?: number[];
  _hdrMode?: boolean;
  _colorTargetFormat?: GPUTextureFormat;
  _shadowMode?: boolean;
  _cullMode?: GPUCullMode;
  _depthBias?: number;
  _depthBiasSlopeScale?: number;
  _shaderCode?: string;
  _pipelineConfig?: import("./WebGPUDrawCommand.js").WebGPUPipelineConfig;
  // Globe translucency derived command fields
  _webgpuTranslucencyDerived?: Array<{
    blendEnabled?: boolean;
    depthWriteEnabled?: boolean;
    cullMode?: GPUCullMode;
    type?: number;
    depthTestEnabled?: boolean;
    cullFront?: boolean;
    cullBack?: boolean;
    colorWriteEnabled?: boolean;
  }>;
  _webgpuTranslucencyDerivedCount?: number;
  _webgpuDerivedTranslucent?: boolean;
  /**
   * C-R1 (Batch 30) — optional WebGL-style `renderState` forwarded to
   * `WebGPUDrawCommand.execute()` so `applyPerEncoderState()` runs
   * stencilRef / blendConstant / viewport / scissor before the draw.
   * Typed loose (opaque object) at the ambient boundary because
   * CesiumJS's real `RenderState` is a JS class populated from many
   * sources; `RenderStateToPipelineVariant.ts` defines the structural
   * `CesiumRenderStateLike` shape that readers actually use.
   */
  renderState?: CesiumOpaqueRenderState;
  /**
   * Backend-agnostic command variants — mirrors WebGL's DerivedCommand
   * shape so the WebGPU dispatcher can use the same selection logic as
   * {@link Scene/SceneRenderer.js#executeCommand}. Populated by feature
   * renderers that precompute variants (Model/Globe/Ground primitives,
   * glTF two-pass materials). Empty for feature renderers that emit
   * single commands per frame (Billboard, Label, Cloud, Point) — those
   * either don't need variants or handle them through an internal path.
   */
  derivedCommands?: {
    logDepth?: { command?: CesiumAnyDrawCommand };
    hdr?: { command?: CesiumAnyDrawCommand };
    picking?: { pickCommand?: CesiumAnyDrawCommand };
    pickingMetadata?: { pickMetadataCommand?: CesiumAnyDrawCommand };
    shadows?: { receiveCommand?: CesiumAnyDrawCommand };
    depth?: { depthOnlyCommand?: CesiumAnyDrawCommand };
  };
}

// ─── SceneGlobalCache ─────────────────────────────────────────────────

/**
 * Entry stored by {@link ImageryLayerHelpers} under
 * `cache.imageryLayer_reproject`. Pass-through from TS, the individual
 * fields come from the JS-side legacy renderer.
 */
interface ImageryLayerReprojectCache {
  framebuffer?: CesiumOpaqueFramebuffer;
  vertexArray?: CesiumOpaqueVertexArray;
  shaderProgram?: CesiumOpaqueShaderProgram;
  sampler?: CesiumOpaqueSampler;
  renderState?: CesiumOpaqueRenderState;
  indicesBuffer?: CesiumOpaqueObject;
}

/**
 * The cross-subsystem cache hung off every {@link CesiumGraphicsContext}.
 * Keys are namespaced by Scene subsystem (e.g., `billboardCollection_*`,
 * `cloudCollection_*`, `imageryLayer*`). Values are the derived GPU
 * resource of that subsystem. Stable known keys are enumerated so callers
 * get real types; the index-signature fallback keeps the bag extensible
 * without touching this declaration whenever a subsystem adds a new key.
 *
 * Adoption rule: when a Scene file adds a new persistent cache entry,
 * register it here with a precise value type. The fallback is for
 * genuinely-dynamic keys (rare in practice).
 */
interface SceneGlobalCache {
  // BillboardCollection
  billboardCollection_indexBufferInstanced?: CesiumOpaqueObject;
  billboardCollection_vertexBufferInstanced?: CesiumOpaqueObject;

  // CloudCollection
  cloudCollection_indexBufferBatched?: CesiumOpaqueObject;
  cloudCollection_indexBufferInstanced?: CesiumOpaqueObject;
  cloudCollection_vertexBufferInstanced?: CesiumOpaqueObject;

  // EllipsoidPrimitive
  ellipsoidPrimitive_vertexArray?: CesiumOpaqueVertexArray;

  // GlobeSurfaceTile water mask
  tile_waterMaskData?: CesiumOpaqueObject;

  // ImageryLayer
  imageryLayerMipmapSamplers?: CesiumOpaqueSampler[];
  imageryLayerNonMipmapSamplers?: CesiumOpaqueSampler[];
  imageryLayer_reproject?: ImageryLayerReprojectCache;

  // Model outline generator (internal lookup map)
  modelOutliningCache?: { [key: string]: CesiumOpaqueObject };

  // Extensibility fallback — values are CesiumOpaqueObjects so callers get
  // a non-primitive cache slot without using `unknown` / `any`. Narrowing
  // to a specific subsystem type is done at the call site.
  [key: string]: CesiumOpaqueObject | undefined;
}

// ─── WebGPURenderTarget (minimal) ────────────────────────────────────

/** Minimal interface for WebGPURenderTarget used across render passes. */
interface WebGPURenderTargetLike {
  getColorTexture?(index: number): GPUTexture | undefined;
  getColorTextureView?(index: number): GPUTextureView | undefined;
  getDepthTexture?(): GPUTexture | undefined;
  getDepthTextureView?(): GPUTextureView | undefined;
  getDepthStencilTextureView?(): GPUTextureView | undefined;
  resize?(width: number, height: number): void;
  destroy?(): void;
}

// ─── WebGPU Compute Command ─────────────────────────────────────────

/** Minimal interface for compute commands dispatched by WebGPUContext. */
interface CesiumComputeCommand {
  isWebGPUComputeCommand?: boolean;
  execute(ctx: object): void;
  [key: string]: unknown;
}

// ─── GPU cull results ───────────────────────────────────────────────

/** Shape of the cull results returned by GPUCuller.readResults(). */
interface GPUCullResults {
  visibilityFlags: Uint32Array;
  visibleCount: number;
  objectCount: number;
}

// ─── CesiumJS Texture with source ───────────────────────────────────

/** CesiumJS Texture accessed to extract the underlying image source. */
interface CesiumTextureWithSource extends CesiumOpaqueObject {
  _source?: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  image?: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  _id?: string | number;
  texture?: GPUTexture;
  _texture?: GPUTexture;
}

// ─── Compressed texture extension stubs ─────────────────────────────

/** Compressed texture extension type — WebGL: extension object or null;
 *  WebGPU: boolean (true = supported via device features). */
type CesiumCompressedTextureExtension = object | boolean | null;

// ─── ShaderCache ─────────────────────────────────────────────────────────

interface CesiumShaderCache {
  readonly numberOfShaders: number;
  getShaderProgram(options: {
    vertexShaderSource: string | CesiumOpaqueShaderSource;
    fragmentShaderSource: string | CesiumOpaqueShaderSource;
    attributeLocations?: Record<string, number> | object;
  }): CesiumOpaqueShaderProgram;
  replaceShaderProgram(options: {
    shaderProgram?: CesiumOpaqueShaderProgram;
    vertexShaderSource: string | CesiumOpaqueShaderSource;
    fragmentShaderSource: string | CesiumOpaqueShaderSource;
    attributeLocations?: Record<string, number> | object;
  }): CesiumOpaqueShaderProgram;
  destroyReleasedShaderPrograms(): void;
  releaseShaderProgram(program: CesiumOpaqueShaderProgram): void;
  isDestroyed(): boolean;
  destroy(): void;
}
