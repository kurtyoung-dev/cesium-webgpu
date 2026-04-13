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
// access their internals. Using Record<string, unknown> makes them
// assignable from any JS class while preventing unchecked property access.
// Individual properties can be added if the WebGPU code starts reading them.
type CesiumOpaqueObject = Record<string, unknown>;
type CesiumOpaqueTexture = CesiumOpaqueObject;
type CesiumOpaqueFramebuffer = CesiumOpaqueObject;
type CesiumOpaqueVertexArray = CesiumOpaqueObject;
type CesiumOpaqueShaderProgram = CesiumOpaqueObject;
type CesiumOpaqueShaderSource = CesiumOpaqueObject;
type CesiumOpaqueRenderState = CesiumOpaqueObject;
type CesiumOpaqueCullingVolume = CesiumOpaqueObject;
type CesiumOpaqueJulianDate = CesiumOpaqueObject;
type CesiumOpaqueMapProjection = CesiumOpaqueObject;
type CesiumOpaqueTerrainProvider = CesiumOpaqueObject;

// ─── Math types (minimal) ────────────────────────────────────────────────

interface CesiumCartesian2 {
  x: number;
  y: number;
  clone(result?: CesiumCartesian2): CesiumCartesian2;
  equals(right?: CesiumCartesian2): boolean;
  equalsEpsilon(right?: CesiumCartesian2, relativeEpsilon?: number, absoluteEpsilon?: number): boolean;
}

interface CesiumCartesian3 {
  x: number;
  y: number;
  z: number;
  clone(result?: CesiumCartesian3): CesiumCartesian3;
  equals(right?: CesiumCartesian3): boolean;
  equalsEpsilon(right?: CesiumCartesian3, relativeEpsilon?: number, absoluteEpsilon?: number): boolean;
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

/** Column-major 16-element matrix — structurally compatible with Matrix4. */
type CesiumMatrix4 = Float64Array & {
  length: 16;
  0: number; 1: number; 2: number; 3: number;
  4: number; 5: number; 6: number; 7: number;
  8: number; 9: number; 10: number; 11: number;
  12: number; 13: number; 14: number; 15: number;
  clone(result?: CesiumMatrix4): CesiumMatrix4;
  equals(right?: CesiumMatrix4): boolean;
  equalsEpsilon(right?: CesiumMatrix4, epsilon?: number): boolean;
};

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
  get(index: number): CesiumPostProcessStage;
}

// ─── Weather ────────────────────────────────────────────────────────────

interface CesiumWeatherConfig {
  enabled: boolean;
  type: number;
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
  afterRender: Array<() => boolean | undefined>;
  scene3DOnly: boolean;
  fog: CesiumFrameStateFog;
  atmosphere: { hueShift: number; saturationShift: number; brightnessShift: number } | undefined;
  atmosphericConditions: {
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
    varyingAtmosphereDensity?: number | { enabled?: boolean; noiseScale?: number; noiseStrength?: number };
    weather?: CesiumWeatherConfig;
  } | undefined;
  verticalExaggeration: number;
  verticalExaggerationRelativeHeight: number;
  shadowState: {
    shadowsEnabled: boolean;
    shadowMaps: CesiumShadowMap[];
    lightShadowMaps: CesiumShadowMap[];
    nearPlane: number;
    farPlane: number;
  };
  splitPosition: number;
  backgroundColor: CesiumColor | undefined;
  light: { direction?: CesiumCartesian3; color?: CesiumColor; intensity?: number } | undefined;
  lights: Array<{ direction?: CesiumCartesian3; color?: CesiumColor; intensity?: number }> | undefined;
  useLogDepth: boolean;
  minimumTerrainHeight: number;
  invertClassification: boolean;
  invertClassificationColor: CesiumColor | undefined;
  sunDirectionWC: CesiumCartesian3;
  moonDirectionWC: CesiumCartesian3;
  moonPhaseFraction: number;
  deltaTime: number;
  brdfLutGenerator: { update(frameState: CesiumFrameState): void } | undefined;
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
  frustum: { near: number; far: number; fov?: number; aspectRatio?: number; projectionMatrix?: CesiumMatrix4 };
  viewMatrix: CesiumMatrix4;
  inverseViewMatrix: CesiumMatrix4;
  inverseViewProjection: CesiumMatrix4;
  setView(options: { destination?: CesiumCartesian3; orientation?: unknown }): void;
}

// ─── UniformState ────────────────────────────────────────────────────────

interface CesiumUniformState {
  readonly frameState: CesiumFrameState | undefined;
  readonly view: CesiumMatrix4;
  readonly projection: CesiumMatrix4;
  readonly viewProjection: CesiumMatrix4;
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
  readonly uniformState: CesiumUniformState;
  readonly cache: Record<string, unknown>;
  readonly defaultTexture: CesiumOpaqueTexture;
  readonly stencilBuffer: boolean;
  readonly msaa: boolean;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly device?: GPUDevice | null;
  readonly canvas: { width: number; height: number };
  readonly _canvas?: { width: number; height: number } | null;
  readonly _device?: GPUDevice | null;
  readonly shaderCache?: {
    preprocessOnly?: (source: string, options?: { label?: string }) => string;
  };
  useHardwareClipDistances?: boolean;
  getFeatureRenderer(key: number): CesiumFeatureRenderer | undefined;
  registerFeatureRenderer(key: number, renderer: CesiumFeatureRenderer): void;
  createPickId(object: unknown): CesiumPickId;
  getObjectByPickColor(color: CesiumColor | number): unknown;
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
}

// ─── PickId ─────────────────────────────────────────────────────────────

interface CesiumPickId {
  object: unknown;
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
  owner: unknown;
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
  execute(context: CesiumGraphicsContext, passState?: CesiumPassState): void;
}

// ─── PassState ───────────────────────────────────────────────────────────

interface CesiumPassState {
  context: CesiumGraphicsContext;
  framebuffer: CesiumOpaqueFramebuffer | undefined;
  blendingEnabled: boolean | undefined;
  scissorTest: { enabled: boolean; rectangle: CesiumBoundingRectangle } | undefined;
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
  quantization: number;
  stride: number;
}

interface CesiumGlobeSurfaceTile {
  imagery: CesiumTileImagery[];
  boundingSphere3D: CesiumBoundingSphere;
  waterMaskTexture: CesiumOpaqueTexture | undefined;
  waterMaskTranslationAndScale: CesiumCartesian4;
  terrainData: unknown;
  vertexArray: CesiumOpaqueVertexArray | undefined;
  tileBoundingRegion: { boundingSphere?: CesiumBoundingSphere; boundingVolume?: CesiumBoundingSphere } | undefined;
  mesh: CesiumTerrainMesh | undefined;
  fill: { mesh: CesiumTerrainMesh | undefined } | undefined;
  center: CesiumCartesian3 | undefined;
  renderedMesh: CesiumTerrainMesh | undefined;
  surfaceShader: CesiumOpaqueShaderProgram | undefined;
  isClipped: boolean;
  clippedByBoundaries: boolean;
  data: unknown;
}

interface CesiumGlobeTileProvider {
  clippingPlanes?: { length: number; unionClippingRegions?: boolean };
  enableLighting?: boolean;
  cartographicLimitRectangle?: { west: number; south: number; east: number; north: number; width: number };
  nightFadeOutDistance?: number;
  nightFadeInDistance?: number;
  hasWaterMask?: boolean;
  showWaterEffect?: boolean;
  oceanNormalMap?: unknown;
  oceanDeepColor?: { red: number; green: number; blue: number };
  oceanFresnelPower?: number;
  nightIntensity?: number;
  oceanReflectivity?: number;
  [key: string]: unknown;
}

interface CesiumTileImagery {
  readyImagery: {
    imageryLayer: {
      alpha: number;
      brightness: number;
      contrast: number;
      saturation: number;
      split: number;
      nightAlpha: number;
      dayAlpha: number;
      show: boolean;
    } | undefined;
    texture: CesiumOpaqueTexture | undefined;
    textureWebGL: CesiumOpaqueTexture | undefined;
    image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
    rectangle: CesiumRectangle | undefined;
    state: number;
    _webgpuReprojectedTexture: GPUTexture | undefined;
  } | undefined;
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
  _shadowMapMatrix: CesiumMatrix4 | undefined;
  _textureSize: CesiumCartesian2 | undefined;
  _primitiveBias: { depthBias: number; normalShadingSmooth: number } | undefined;
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
  readonly weather: CesiumWeatherConfig | undefined;
  readonly snapshotMode: { enabled: boolean; isFrozen: boolean; registerFreezable(name: string, freezable: { freeze(): void; thaw(): void }): void } | undefined;
  readonly debugCommandFilter: ((cmd: CesiumDrawCommand | CesiumAnyDrawCommand) => boolean) | undefined;
  _frameState: CesiumFrameState;
  _view: { frustumCommandsList?: CesiumFrustumCommands[] };
  _picking: { pick?(scene: CesiumScene, windowPosition: CesiumCartesian2): unknown; getPickDepth?(scene: CesiumScene, index: number): { getDepth?(x: number, y: number): number; update?(context: CesiumGraphicsContext, texture: unknown): void } };
  _context: CesiumGraphicsContext;
  _globe: CesiumGlobe | undefined;
  _alternateSceneRenderer: CesiumFeatureRenderer | undefined;
  _clearColorCommand: { color: CesiumColor; execute(context: CesiumGraphicsContext, passState: CesiumPassState): void };
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
  _surface: { _tileProvider?: CesiumGlobeTileProvider; _tilesToRender?: unknown[] };
  _ellipsoid: { maximumRadius: number; oneOverRadii: CesiumCartesian3; radii: CesiumCartesian3 };
  ellipsoid?: { maximumRadius: number; oneOverRadii: CesiumCartesian3; radii: CesiumCartesian3 };
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
  _webgpuAtmosphereCache?: { uniformBuffer: GPUBuffer | null; data: Float32Array; enabled: boolean; dirty: boolean };
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
  clippingPlanes: { enabled: boolean; length: number } | undefined;
  clippingPolygons: { enabled: boolean; length: number } | undefined;
  showWaterEffect: boolean;
  oceanNormalMap: CesiumOpaqueTexture | undefined;
  oceanDeepColor: CesiumColor;
  nightFadeOutDistance: number;
  nightFadeInDistance: number;
  hasWaterMask: boolean;
  enableLighting: boolean;
  translucencyEnabled: boolean;
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
  _webgpuCache?: unknown;
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
  _pointCloud?: { _parsedContent?: { positions?: Float32Array; colors?: Float32Array } | null } | null;
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
  boundingVolume?: CesiumBoundingSphere;
  pass?: number;
  castShadows?: boolean;
  receiveShadows?: boolean;
  cull?: boolean;
  occlude?: boolean;
  owner?: unknown;
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
  _pipelineConfig?: Record<string, unknown>;
  // Globe translucency derived command fields
  _webgpuTranslucencyDerived?: Array<{ blendEnabled?: boolean; depthWriteEnabled?: boolean; cullMode?: GPUCullMode; type?: number; depthTestEnabled?: boolean; cullFront?: boolean; cullBack?: boolean; colorWriteEnabled?: boolean }>;
  _webgpuTranslucencyDerivedCount?: number;
  _webgpuDerivedTranslucent?: boolean;
}

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
