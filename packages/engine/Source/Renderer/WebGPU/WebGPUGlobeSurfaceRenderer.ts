/// <reference types="@webgpu/types" />
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
/**
 * WebGPU Globe Surface Renderer
 *
 * Converts terrain tile data (from GlobeSurfaceTileProvider) into WebGPU
 * draw commands. Manages pipeline creation, vertex/index buffer upload,
 * imagery texture creation, and per-tile uniform buffer management.
 *
 * Supports:
 *   - Uncompressed terrain (TerrainQuantization.NONE)
 *   - Quantized terrain (TerrainQuantization.BITS12)
 *   - Up to 4 imagery layers per draw call (multi-pass for >4)
 *   - Water mask textures for ocean rendering
 *   - Day/night alpha blending per imagery layer
 *   - Cartographic limit rectangle clipping
 *   - Fog, atmosphere, and Lambert diffuse lighting
 *   - Multi-pass rendering for tiles with >4 imagery layers
 *   - Globe translucency blend pipeline variants
 *
 * @private
 */

// ─── Uniform buffer sizes (must match GlobeTerrain.wgsl CameraUniforms) ───
// CameraUniforms: mvpRTE(16) + modifiedMV(16) + modifiedMVP(16) +
//   camHigh(3+1) + camLow(3+1) + center3D(3+1) +
//   sunDirEC(3)+enableLighting(1) + scaleAndBias(16) +
//   minMaxHeight(2) + pad(2) = 84 floats (3D core)
//   + tileRectangle(4) + southAndNorthLatitude(2) + southMercY(2) +
//   sceneMode(1) + morphTime(1) + useWebMercator(1) + pad(1) = 12 floats (2D/Columbus)
//   = 96 floats total
const CAMERA_UNIFORM_FLOATS = 96;
const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

// TileUniforms: layers(4×12=48) + layerCount(1) + fog(3) +
//   waterMaskTS(4) + cartLimitRect(4) + nightFade(2) +
//   dayNightAlpha0-3(4×2=8) + flags(4) + exaggeration(2) + time(1) + pad(1)
//   + oceanParams(4) + nightOceanParams(4) + useWebMercatorTLayer(4)
//   + debugFields(4) = 96 floats
//
// debugFields layout (offsets 92-95):
//   .x = tileLevel (LOD depth integer, read by fragmentDebugLod)
//   .y = isolateImageryLayer (-1 or 0..3, read by fragmentMain)
//   .z, .w = reserved
const TILE_UNIFORM_FLOATS = 96;
const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Max imagery layers per tile in single draw call
const MAX_IMAGERY_LAYERS = 4;

// Column-major 4×4 matrix multiply: result = a × b. All inputs and result
// are stored as Float64Array of length 16 in column-major order (Cesium's
// Matrix4 convention). Used by the camera UB to build modifiedMVP from
// projection × modifiedModelView for 2D / Columbus View paths.
function multiplyMat4ColumnMajor(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  result: Float64Array,
): void {
  const a00 = a[0],
    a01 = a[4],
    a02 = a[8],
    a03 = a[12];
  const a10 = a[1],
    a11 = a[5],
    a12 = a[9],
    a13 = a[13];
  const a20 = a[2],
    a21 = a[6],
    a22 = a[10],
    a23 = a[14];
  const a30 = a[3],
    a31 = a[7],
    a32 = a[11],
    a33 = a[15];
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4 + 0];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    result[col * 4 + 0] = a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3;
    result[col * 4 + 1] = a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3;
    result[col * 4 + 2] = a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3;
    result[col * 4 + 3] = a30 * b0 + a31 * b1 + a32 * b2 + a33 * b3;
  }
}

/** Pipeline variant key: encodes quantization + normals state */
const enum PipelineKey {
  UNCOMPRESSED_NORMALS = 0,
  UNCOMPRESSED_NO_NORMALS = 1,
  QUANTIZED_NORMALS = 2,
  QUANTIZED_NO_NORMALS = 3,
  // Blend variants for multi-pass (subsequent imagery passes)
  UNCOMPRESSED_NORMALS_BLEND = 4,
  UNCOMPRESSED_NO_NORMALS_BLEND = 5,
  QUANTIZED_NORMALS_BLEND = 6,
  QUANTIZED_NO_NORMALS_BLEND = 7,
}

/** Cached per-tile WebGPU resources */
interface TileGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  strideFloats: number;
  strideBytes: number;
  hasNormals: boolean;
  hasWebMercatorT: boolean;
  isQuantized: boolean;
  meshGeneration: number;
}

/** Cached imagery texture */
interface ImageryGPUTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  sourceWidth: number;
  sourceHeight: number;
}

/** Descriptor for a single tile draw pass */
export interface TileDrawDescriptor {
  pipeline: GPURenderPipeline;
  bindGroups: GPUBindGroup[];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  boundingVolume: any;
  isSubsequentPass: boolean;
}

/**
 * Mutually-exclusive debug fragment variants for the globe surface.
 * Bumped through `frameState.debugTerrainFragmentMode` (set by Scene from
 * the individual `debugShow*` flags). NONE = production fragment.
 *
 * The values are stable; do not renumber without updating Scene.js.
 */
export const enum DebugFragmentMode {
  NONE = 0,
  TRIANGULATION = 1, // per-triangle face color via @builtin(primitive_index)
  LOD = 2, // tile depth-level color overlay
  NORMAL = 3, // eye-space normal as RGB
}

export class WebGPUGlobeSurfaceRenderer {
  private _device: GPUDevice | null = null;
  private _diagTileCount = 0;
  // BUG-11 imagery probe — last observed value of `frameState.debugShowImageryProbe`,
  // used to detect the rising edge so the probe latch resets when the
  // operator toggles the flag back on for a second sample.
  private _lastProbeFlag = false;
  private _pipelineCache: Map<string, GPURenderPipeline> = new Map();
  private _shaderModule: GPUShaderModule | null = null;
  // Source preserved so we can lazily augment it with debug fragment
  // entry points (triangulation / LOD overlay / normal-as-color).
  private _shaderCode: string = "";
  // Single augmented shader module hosting all debug fragment entry
  // points. Built once on first request, cached forever. Single-source
  // module + multiple entry points avoids the duplication cost of
  // separate modules per debug variant.
  private _debugFragmentShaderModule: GPUShaderModule | null = null;
  private _debugFragmentPipelineCache: Map<string, GPURenderPipeline> =
    new Map();
  private _debugFragmentSupportProbed: boolean = false;
  private _debugFragmentSupported: boolean = false;
  private _sampler: GPUSampler | null = null;
  private _waterMaskSampler: GPUSampler | null = null;
  private _bindGroupLayout0: GPUBindGroupLayout | null = null;
  private _bindGroupLayout1: GPUBindGroupLayout | null = null;
  private _bindGroupLayout2: GPUBindGroupLayout | null = null;
  // Group 3 is now the effects bind group (merged water+ocean into group 2)
  private _effectsBGL: GPUBindGroupLayout | null = null;
  private _placeholderEffectsBG: GPUBindGroup | null = null;
  private _oceanNormalSampler: GPUSampler | null = null;
  private _oceanNormalMapCache: Map<string, ImageryGPUTexture> = new Map();
  private _pipelineLayout: GPUPipelineLayout | null = null;
  private _placeholderTexture: GPUTexture | null = null;
  private _placeholderView: GPUTextureView | null = null;
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";

  // Wireframe pipelines — keyed by the same shape string used by
  // _selectPipeline so they share variant granularity (Q/U, N/X, M/G, stride).
  // Lazily built on first wireframe request; production cache is untouched.
  private _wireframePipelineCache: Map<string, GPURenderPipeline> = new Map();
  private _wireframeIndexCache: Map<
    string,
    { buffer: GPUBuffer; count: number; format: GPUIndexFormat }
  > = new Map();

  // Per-tile GPU resource caches
  private _tileBufferCache: Map<string, TileGPUResources> = new Map();
  private _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();
  private _waterMaskTextureCache: Map<string, ImageryGPUTexture> = new Map();

  // Reusable typed arrays for uniform data
  private _cameraUniformData: Float32Array = new Float32Array(
    CAMERA_UNIFORM_FLOATS,
  );
  // Scratch for projection × modifiedModelView (column-major Float64).
  // 2D/CV/Morphing paths in the vertex shader use this matrix instead of
  // mvpRelativeToEye, since their positions are planar (not RTE).
  private _cameraMvpScratch: Float64Array = new Float64Array(16);
  private _tileUniformData: Float32Array = new Float32Array(
    TILE_UNIFORM_FLOATS,
  );
  private _tileUniformU32View: Uint32Array;

  private _isDestroyed: boolean = false;
  private _isInitialized: boolean = false;

  constructor() {
    this._tileUniformU32View = new Uint32Array(this._tileUniformData.buffer);
  }

  /**
   * Initialize the renderer with the GPU device and shader code.
   */
  initialize(
    device: GPUDevice,
    shaderCode: string,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (this._isInitialized) return;
    this._device = device;
    this._canvasFormat = canvasFormat;

    this._createShaderModule(shaderCode);
    this._createBindGroupLayouts();
    this._createPipelineLayout();
    this._createSamplers();
    this._createPlaceholderTexture();
    // Pipelines are created lazily in _selectPipeline based on actual tile stride
    this._isInitialized = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  // ─── Shader Module ───
  private _createShaderModule(code: string): void {
    this._shaderCode = code;
    this._shaderModule = this._device!.createShaderModule({
      label: "GlobeTerrain shader",
      code,
    });
  }

  /**
   * Lazily builds the augmented shader module that hosts every debug
   * fragment entry point. The vertex stages are reused unchanged from the
   * production module, so the augmented version can pair with any of the
   * existing `vertexMain*` variants — only the fragment binding differs.
   *
   * Hosted entry points:
   *   - `fragmentDebugTri`     — per-triangle face color via @builtin(primitive_index)
   *   - `fragmentDebugLod`     — tile depth-level color overlay (reads tile.tileLevel)
   *   - `fragmentDebugNormal`  — eye-space normal mapped into RGB
   *
   * Wrapped in `pushErrorScope("validation")` so a driver that rejects
   * `@builtin(primitive_index)` (older Mali/Intel paths) disables the
   * entire debug path silently instead of crashing the frame.
   *
   * Returns null if the device fails to compile the augmented module.
   * Result is cached forever.
   */
  private _getDebugFragmentShaderModule(): GPUShaderModule | null {
    if (this._debugFragmentSupportProbed) {
      return this._debugFragmentShaderModule;
    }
    this._debugFragmentSupportProbed = true;
    const device = this._device;
    if (!device || !this._shaderCode) {
      return null;
    }

    // The three debug fragment entry points share the same vertex outputs
    // as the production fragment, so they can be appended to the existing
    // shader source without touching VertexOutput / TileUniforms.
    //
    // - fragmentDebugTri: uses @builtin(primitive_index) for face coloring.
    // - fragmentDebugLod: reads `tile.tileLevel` (added to TileUniforms in
    //   this session) and maps it to a deterministic color.
    // - fragmentDebugNormal: emits the interpolated eye-space normal as
    //   RGB after a [-1,1]→[0,1] remap. Useful for verifying the
    //   normal-map shaders we modernized in WGF-5.
    const augmented = `${this._shaderCode}

@fragment
fn fragmentDebugTri(@builtin(primitive_index) primIndex: u32)
    -> @location(0) vec4<f32> {
  let r = f32((primIndex * 73u) & 255u) / 255.0;
  let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;
  let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}

@fragment
fn fragmentDebugLod(input: VertexOutput) -> @location(0) vec4<f32> {
  // Deterministic per-level palette: 12 hues cycle through the spectrum
  // so adjacent levels are visually distinct. Levels above 11 wrap.
  let level = u32(tile.debugFields.x + 0.5) % 12u;
  var color: vec3<f32>;
  switch (level) {
    case 0u:  { color = vec3<f32>(1.00, 0.00, 0.00); }
    case 1u:  { color = vec3<f32>(1.00, 0.50, 0.00); }
    case 2u:  { color = vec3<f32>(1.00, 1.00, 0.00); }
    case 3u:  { color = vec3<f32>(0.50, 1.00, 0.00); }
    case 4u:  { color = vec3<f32>(0.00, 1.00, 0.00); }
    case 5u:  { color = vec3<f32>(0.00, 1.00, 0.50); }
    case 6u:  { color = vec3<f32>(0.00, 1.00, 1.00); }
    case 7u:  { color = vec3<f32>(0.00, 0.50, 1.00); }
    case 8u:  { color = vec3<f32>(0.00, 0.00, 1.00); }
    case 9u:  { color = vec3<f32>(0.50, 0.00, 1.00); }
    case 10u: { color = vec3<f32>(1.00, 0.00, 1.00); }
    default:  { color = vec3<f32>(1.00, 0.00, 0.50); }
  }
  return vec4<f32>(color, 1.0);
}

@fragment
fn fragmentDebugNormal(input: VertexOutput) -> @location(0) vec4<f32> {
  // Eye-space normal as RGB. Remap from [-1,1] to [0,1] so all components
  // are visible. Useful for verifying that vertex normals are correctly
  // interpolated and that the normal-map shaders (WGF-5) produce
  // sensible orientations. Flat-shaded tiles will show single colors
  // per primitive; smooth-shaded tiles will show gradients.
  let n = normalize(input.v_normalEC);
  return vec4<f32>(n * 0.5 + 0.5, 1.0);
}
`;

    try {
      device.pushErrorScope("validation");
      const mod = device.createShaderModule({
        label: "GlobeTerrain shader (debug variants)",
        code: augmented,
      });
      // Drain the validation scope. If the driver rejected the builtin we
      // still hold the module reference, but the next pipeline build will
      // fail noisily — flip _debugFragmentSupported off so we never try.
      device.popErrorScope().then((err) => {
        if (err) {
          this._debugFragmentSupported = false;
          this._debugFragmentShaderModule = null;
          console.warn(
            `[WebGPUGlobeSurfaceRenderer] debug fragment variants disabled: ${err.message}`,
          );
        }
      });
      this._debugFragmentShaderModule = mod;
      this._debugFragmentSupported = true;
    } catch (e) {
      this._debugFragmentShaderModule = null;
      this._debugFragmentSupported = false;
    }
    return this._debugFragmentShaderModule;
  }

  // ─── Bind Group Layouts ───
  private _createBindGroupLayouts(): void {
    const device = this._device!;

    // Group 0: Camera + Tile uniform buffers
    this._bindGroupLayout0 = device.createBindGroupLayout({
      label: "Globe terrain uniforms layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Group 1: Day imagery textures (4) + sampler
    this._bindGroupLayout1 = device.createBindGroupLayout({
      label: "Globe terrain textures layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    // Group 2: Water mask + Ocean normal map (merged to stay within 4 bind groups)
    this._bindGroupLayout2 = device.createBindGroupLayout({
      label: "Globe water mask + ocean normal layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    // Group 3: Effects (shadow receive + clipping planes) — shared layout
    this._effectsBGL = getEffectsBindGroupLayout(device);
    const placeholder = getPlaceholderEffects(device);
    this._placeholderEffectsBG = placeholder.bindGroup;
  }

  // ─── Pipeline Layout ───
  private _createPipelineLayout(): void {
    this._pipelineLayout = this._device!.createPipelineLayout({
      label: "Globe terrain pipeline layout",
      bindGroupLayouts: [
        this._bindGroupLayout0!,
        this._bindGroupLayout1!,
        this._bindGroupLayout2!,
        this._effectsBGL!,
      ],
    });
  }

  // ─── Samplers ───
  private _createSamplers(): void {
    this._sampler = this._device!.createSampler({
      label: "Globe terrain sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Water mask uses nearest filtering (binary mask, no interpolation)
    this._waterMaskSampler = this._device!.createSampler({
      label: "Globe water mask sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Ocean normal map uses repeating linear filtering for tiled wave patterns
    this._oceanNormalSampler = this._device!.createSampler({
      label: "Globe ocean normal sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
  }

  // ─── Placeholder 1×1 white texture ───
  private _createPlaceholderTexture(): void {
    const device = this._device!;
    this._placeholderTexture = device.createTexture({
      label: "Globe placeholder texture",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._placeholderTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this._placeholderView = this._placeholderTexture.createView();
  }

  // ─── Render Pipelines (lazily created per actual vertex stride) ───
  private _createPipelineVariant(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
    debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE,
  ): GPURenderPipeline {
    const device = this._device!;

    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;

    if (isQuantized) {
      // BITS12 quantized: compressed0 layout depends on encoding flags.
      // When hasWebMercatorT=true: compressed0.w = compressed webMercatorT
      //   (not encodedNormal), so we need float32x4 to read it.
      // When hasWebMercatorT=false: compressed0.w = encodedNormal (if normals)
      //   or not present (float32x3 with .w defaulting to 1.0).
      let format: GPUVertexFormat;
      if (hasWebMercatorT) {
        // webMercatorT is in compressed0.w — always need vec4
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMerc";
      } else if (hasNormals) {
        // encodedNormal in compressed0.w
        format = "float32x4";
        entryPoint = "vertexMainQuantized";
      } else {
        format = "float32x3";
        entryPoint = "vertexMainQuantized";
      }
      const minStride = hasWebMercatorT || hasNormals ? 16 : 12;
      const actualStride = Math.max(strideBytes, minStride);
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format }],
        },
      ];
    } else {
      // Uncompressed vertex data layout (per TerrainEncoding):
      //   [0-3]: posX, posY, posZ, height  (float32x4 @ location 0)
      //   [4-5]: u, v                      (always present)
      //   [6]:   webMercatorT              (if hasWebMercatorT)
      //   [6/7]: encodedNormal             (if hasVertexNormals, after webMercatorT if both)
      //
      // We read all data after position as a single attribute at location 1:
      //   - No extras:           float32x2 (u, v)         → vertexMain
      //   - webMercT only:       float32x3 (u, v, mercT)  → vertexMainWebMerc
      //   - normals only:        float32x3 (u, v, normal)  → vertexMain
      //   - webMercT + normals:  float32x4 (u, v, mercT, normal) → vertexMainWebMercNormals
      let texCoordFormat: GPUVertexFormat;
      if (hasWebMercatorT && hasNormals) {
        texCoordFormat = "float32x4";
        entryPoint = "vertexMainWebMercNormals";
      } else if (hasWebMercatorT) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMainWebMerc";
      } else if (hasNormals) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMain";
      } else {
        texCoordFormat = "float32x2";
        entryPoint = "vertexMain";
      }
      const actualStride = Math.max(strideBytes, 24);
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: texCoordFormat },
          ],
        },
      ];
    }

    const quantLabel = isQuantized ? "quantized" : "uncompressed";
    const normLabel = hasNormals ? "normals" : "noNormals";
    const blendLabel = isBlend ? "blend" : "opaque";

    // Blend state for subsequent imagery passes (additive alpha blending)
    const blendState: GPUBlendState | undefined = isBlend
      ? {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        }
      : undefined;

    // When a debug fragment mode is selected the fragment stage uses the
    // augmented shader module which hosts every debug entry point. Vertex
    // stage stays on the standard module — both modules share identical
    // vertex outputs because the debug module is the original source plus
    // appended entry points.
    let fragmentModule: GPUShaderModule = this._shaderModule!;
    let fragmentEntry: string = "fragmentMain";
    let debugLabel: string = "";
    if (
      debugFragmentMode !== DebugFragmentMode.NONE &&
      this._debugFragmentShaderModule
    ) {
      fragmentModule = this._debugFragmentShaderModule;
      switch (debugFragmentMode) {
        case DebugFragmentMode.TRIANGULATION:
          fragmentEntry = "fragmentDebugTri";
          debugLabel = ", debugTri";
          break;
        case DebugFragmentMode.LOD:
          fragmentEntry = "fragmentDebugLod";
          debugLabel = ", debugLod";
          break;
        case DebugFragmentMode.NORMAL:
          fragmentEntry = "fragmentDebugNormal";
          debugLabel = ", debugNormal";
          break;
      }
    }

    return device.createRenderPipeline({
      label: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel}${debugLabel})`,
      layout: this._pipelineLayout!,
      vertex: {
        module: this._shaderModule!,
        entryPoint,
        buffers: vertexBuffers,
      },
      fragment: {
        module: fragmentModule,
        entryPoint: fragmentEntry,
        targets: [
          {
            format: this._canvasFormat,
            blend: blendState,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: !isBlend,
        depthCompare: isBlend ? "less-equal" : "less",
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Selection (lazy creation, keyed by actual vertex stride)
  // ═══════════════════════════════════════════════════════════════════════

  private _selectPipeline(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
  ): GPURenderPipeline {
    const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}`;
    let pipeline = this._pipelineCache.get(cacheKey);
    if (!pipeline) {
      pipeline = this._createPipelineVariant(
        isQuantized,
        hasNormals,
        hasWebMercatorT,
        isBlend,
        strideBytes,
      );
      this._pipelineCache.set(cacheKey, pipeline);
    }
    return pipeline;
  }

  /**
   * Cold path used when any of the per-fragment debug modes
   * (TRIANGULATION / LOD / NORMAL) is active for this frame. Kept off
   * `_selectPipeline` so the production hot path stays branch-free.
   *
   * Returns null when:
   *   - the requested mode is NONE (caller should use the production path)
   *   - the device fails the augmented-module compile probe (driver
   *     missing primitive_index support, etc.) — caller should fall back
   *     to the production pipeline transparently
   *
   * Cache key includes the mode integer so the four debug variants share
   * a single map without collision. Production cache is untouched.
   */
  private _selectDebugFragmentPipeline(
    mode: DebugFragmentMode,
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    isBlend: boolean,
    strideBytes: number,
  ): GPURenderPipeline | null {
    if (mode === DebugFragmentMode.NONE) {
      return null;
    }
    if (!this._getDebugFragmentShaderModule()) {
      return null;
    }
    const cacheKey = `${mode}_${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}${isBlend ? "B" : "O"}_${strideBytes}`;
    let pipeline = this._debugFragmentPipelineCache.get(cacheKey);
    if (!pipeline) {
      pipeline = this._createPipelineVariant(
        isQuantized,
        hasNormals,
        hasWebMercatorT,
        isBlend,
        strideBytes,
        mode,
      );
      this._debugFragmentPipelineCache.set(cacheKey, pipeline);
    }
    return pipeline;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tile Command Creation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create WebGPU draw command(s) for a terrain tile.
   * Returns an array of descriptors — one per pass.
   * Tiles with >4 imagery layers produce multiple passes.
   */
  createTileCommands(
    tile: any,
    surfaceTile: any,
    tileProvider: any,
    frameState: any,
    uniformState: any,
  ): TileDrawDescriptor[] | null {
    if (!this._isInitialized || !this._device) return null;

    // Eagerly touch the uniform ring buffer allocator on first use. The
    // context's lazy getter only constructs the allocator on first access,
    // and `context.beginFrame()` only calls `beginFrame()` on the allocator
    // when it already exists. Without this touch the allocator would never
    // initialize and BUG-9's per-frame buffer leak would re-emerge.
    void (frameState as any)?.context?.uniformAllocator;

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    const tileKey = this._getTileKey(tile);
    const gpuResources = this._getOrCreateTileBuffers(tileKey, mesh);
    if (!gpuResources) return null;

    // Count total ready imagery layers
    const imageryCollection = surfaceTile.imagery;
    const readyLayers: any[] = [];
    if (imageryCollection) {
      for (let i = 0; i < imageryCollection.length; i++) {
        const tileImagery = imageryCollection[i];
        if (
          tileImagery &&
          tileImagery.readyImagery &&
          tileImagery.readyImagery.imageryLayer
        ) {
          readyLayers.push(tileImagery);
        }
      }
    }

    // Determine number of passes needed (4 imagery layers per pass)
    const totalLayers = readyLayers.length;
    const passCount = Math.max(1, Math.ceil(totalLayers / MAX_IMAGERY_LAYERS));
    const commands: TileDrawDescriptor[] = [];

    // BUG-11 imagery probe diagnostic. Off by default — opt in via
    // `scene.debugShowImageryProbe = true` when investigating an
    // imagery render bug. Logs the first 4 tiles after the flag is set,
    // then quiets so the console doesn't drown. Toggling the flag from
    // false → true resets the latch so a second sample can be captured.
    const probeOn = frameState.debugShowImageryProbe === true;
    if (probeOn && !this._lastProbeFlag) {
      // Rising edge — reset the latch so the next 4 tiles dump again.
      this._diagTileCount = 0;
    }
    this._lastProbeFlag = probeOn;
    if (probeOn) {
      this._diagTileCount++;
    }
    if (probeOn && this._diagTileCount <= 4) {
      const imgLen = imageryCollection ? imageryCollection.length : 0;
      const rect = tile.rectangle;
      const latInfo = rect
        ? `lat=[${((rect.south * 180) / Math.PI).toFixed(1)},${((rect.north * 180) / Math.PI).toFixed(1)}]`
        : "lat=?";
      console.log(
        `[WebGPU:GlobeTile] tile=${tileKey} lvl=${tile.level} ${latInfo} imagery=${imgLen} ready=${totalLayers} ` +
          `stride=${gpuResources.strideFloats} webMercT=${gpuResources.hasWebMercatorT} ` +
          `hasNormals=${gpuResources.hasNormals} quant=${gpuResources.isQuantized} idxCount=${gpuResources.indexCount}`,
      );
      if (totalLayers > 0) {
        const sample = readyLayers[0];
        const ri = sample?.readyImagery;
        const ts = sample?.textureTranslationAndScale;
        const tcr = sample?.textureCoordinateRectangle;
        console.log(
          `[WebGPU:GlobeTile]   imagery: hasImage=${!!ri?.image} hasWebGPUTex=${!!ri?._webgpuReprojectedTexture} ` +
            `useWebMercT=${sample?.useWebMercatorT} state=${ri?.state}`,
        );
        console.log(
          `[WebGPU:GlobeTile]   transScale: (${ts?.x?.toFixed(4)}, ${ts?.y?.toFixed(4)}, ${ts?.z?.toFixed(4)}, ${ts?.w?.toFixed(4)})` +
            ` texCoordsRect: (${tcr?.x?.toFixed(4)}, ${tcr?.y?.toFixed(4)}, ${tcr?.z?.toFixed(4)}, ${tcr?.w?.toFixed(4)})`,
        );
        // Log texture dimensions
        const gpuTex = ri?._webgpuReprojectedTexture;
        if (gpuTex) {
          console.log(
            `[WebGPU:GlobeTile]   texture: ${gpuTex.width}x${gpuTex.height} fmt=${gpuTex.format}`,
          );
        }
        // Log a few vertex UV values from the mesh for cross-check
        const verts = mesh.vertices;
        const stride = gpuResources.strideFloats;
        if (verts && stride >= 6 && !gpuResources.isQuantized) {
          const v0u = verts[4],
            v0v = verts[5];
          const midIdx = Math.floor(verts.length / stride / 2) * stride;
          const vMu = verts[midIdx + 4],
            vMv = verts[midIdx + 5];
          const lastIdx = (Math.floor(verts.length / stride) - 1) * stride;
          const vLu = verts[lastIdx + 4],
            vLv = verts[lastIdx + 5];
          console.log(
            `[WebGPU:GlobeTile]   vertUV: first=(${v0u?.toFixed(4)}, ${v0v?.toFixed(4)}) ` +
              `mid=(${vMu?.toFixed(4)}, ${vMv?.toFixed(4)}) last=(${vLu?.toFixed(4)}, ${vLv?.toFixed(4)})`,
          );
        }
      } else {
        console.warn(
          `[WebGPU:GlobeTile]   NO READY IMAGERY for tile ${tileKey} ${latInfo}`,
        );
      }
    }

    // Hot-path discipline: read all per-frame debug flags once *outside*
    // the per-pass loop. The four fragment debug modes are mutually
    // exclusive (you can only show one fragment overlay at a time);
    // collapse them into a single integer mode so the per-pass branch
    // is one comparison against NONE rather than a chain of if-elses.
    //
    // Wireframe is *not* a fragment mode — it's a topology + IB swap —
    // so it stays as its own boolean and wins over fragment modes
    // (more structural diagnostic value).
    const debugWireframe = frameState.debugShowGlobeWireframe === true;
    let debugFragmentMode: DebugFragmentMode = DebugFragmentMode.NONE;
    if (frameState.debugShowTriangulation === true) {
      debugFragmentMode = DebugFragmentMode.TRIANGULATION;
    } else if (frameState.debugShowTerrainLOD === true) {
      debugFragmentMode = DebugFragmentMode.LOD;
    } else if (frameState.debugShowTerrainNormals === true) {
      debugFragmentMode = DebugFragmentMode.NORMAL;
    }

    for (let pass = 0; pass < passCount; pass++) {
      const isSubsequentPass = pass > 0;
      const layerStart = pass * MAX_IMAGERY_LAYERS;
      const layerEnd = Math.min(layerStart + MAX_IMAGERY_LAYERS, totalLayers);
      const passLayers = readyLayers.slice(layerStart, layerEnd);

      let pipeline: GPURenderPipeline;
      // Wireframe is a structural overlay — only the first pass renders it,
      // subsequent passes are the multi-imagery overdraw which would just
      // double-rasterize the same edges.
      if (debugWireframe && !isSubsequentPass) {
        pipeline = this._selectWireframePipeline(
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          gpuResources.strideBytes,
        );
      } else if (debugFragmentMode !== DebugFragmentMode.NONE) {
        // Cold path: try the debug fragment variant; gracefully fall back
        // to the production pipeline if the device can't compile the
        // augmented module (driver missing primitive_index, etc.).
        pipeline =
          this._selectDebugFragmentPipeline(
            debugFragmentMode,
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
          ) ??
          this._selectPipeline(
            gpuResources.isQuantized,
            gpuResources.hasNormals,
            gpuResources.hasWebMercatorT,
            isSubsequentPass,
            gpuResources.strideBytes,
          );
      } else {
        pipeline = this._selectPipeline(
          gpuResources.isQuantized,
          gpuResources.hasNormals,
          gpuResources.hasWebMercatorT,
          isSubsequentPass,
          gpuResources.strideBytes,
        );
      }

      const cameraUB = this._createCameraUniformBuffer(
        device,
        uniformState,
        surfaceTile,
        tileProvider,
        mesh,
        frameState,
        tile,
      );
      const tileUB = this._createTileUniformBuffer(
        device,
        surfaceTile,
        tileProvider,
        frameState,
        tile,
        passLayers,
        isSubsequentPass,
      );

      const bindGroup0 = device.createBindGroup({
        layout: this._bindGroupLayout0!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: cameraUB.buffer,
              offset: cameraUB.offset,
              size: cameraUB.size,
            },
          },
          {
            binding: 1,
            resource: {
              buffer: tileUB.buffer,
              offset: tileUB.offset,
              size: tileUB.size,
            },
          },
        ],
      });

      const bindGroup1 = this._createTextureBindGroup(device, passLayers);
      // Group 2: Merged water mask + ocean normal map
      const bindGroup2 = this._createWaterOceanBindGroup(
        device,
        isSubsequentPass ? null : surfaceTile,
        tileProvider,
      );

      // Group 3: Effects (shadow receive + clipping planes) — placeholder
      // until real shadow/clipping resources are provided per-frame
      const bindGroup3 = this._placeholderEffectsBG!;

      // Wireframe overlay: swap the index buffer to the line-list version.
      // The wireframe IB is only used on the first pass (matches the pipeline
      // selection above) — subsequent passes still use the standard tri IB
      // because they're not running the wireframe pipeline.
      let drawIndexBuffer = gpuResources.indexBuffer;
      let drawIndexCount = gpuResources.indexCount;
      let drawIndexFormat = gpuResources.indexFormat;
      if (debugWireframe && !isSubsequentPass) {
        const wire = this._getOrCreateWireframeIndices(tileKey, mesh);
        if (wire) {
          drawIndexBuffer = wire.buffer;
          drawIndexCount = wire.count;
          drawIndexFormat = wire.format;
        }
      }

      commands.push({
        pipeline,
        bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: drawIndexBuffer,
        indexCount: drawIndexCount,
        indexFormat: drawIndexFormat,
        boundingVolume: tile.boundingVolume || surfaceTile.boundingSphere3D,
        isSubsequentPass,
      });
    }

    return commands.length > 0 ? commands : null;
  }

  /**
   * Legacy single-command interface for backward compatibility.
   * @deprecated Use createTileCommands for multi-pass support.
   */
  createTileCommand(
    tile: any,
    surfaceTile: any,
    tileProvider: any,
    frameState: any,
    uniformState: any,
  ): any | null {
    const commands = this.createTileCommands(
      tile,
      surfaceTile,
      tileProvider,
      frameState,
      uniformState,
    );
    if (!commands || commands.length === 0) return null;

    // Return the first pass descriptor in the old format
    const cmd = commands[0];
    return {
      pipeline: cmd.pipeline,
      bindGroups: cmd.bindGroups,
      vertexBuffer: cmd.vertexBuffer,
      indexBuffer: cmd.indexBuffer,
      indexCount: cmd.indexCount,
      indexFormat: cmd.indexFormat,
      boundingVolume: cmd.boundingVolume,
    };
  }

  private _getTileKey(tile: any): string {
    return `${tile.level}_${tile.x}_${tile.y}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Vertex / Index Buffer Management
  // ═══════════════════════════════════════════════════════════════════════

  private _getOrCreateTileBuffers(
    tileKey: string,
    mesh: any,
  ): TileGPUResources | null {
    const device = this._device!;
    const generation = mesh._webgpuGeneration || 0;

    const cached = this._tileBufferCache.get(tileKey);
    if (cached && cached.meshGeneration === generation) {
      return cached;
    }

    if (cached) {
      cached.vertexBuffer.destroy();
      cached.indexBuffer.destroy();
    }

    const vertices: Float32Array = mesh.vertices;
    const indices: Uint16Array | Uint32Array = mesh.indices;
    if (
      !vertices ||
      !indices ||
      vertices.length === 0 ||
      indices.length === 0
    ) {
      return null;
    }

    const encoding = mesh.encoding;
    let stride = encoding.stride;
    let hasNormals = encoding.hasVertexNormals === true;
    let hasWebMercatorT = encoding.hasWebMercatorT === true;
    // TerrainQuantization.BITS12 = 1; NONE = 0
    const isQuantized =
      encoding.quantization !== undefined && encoding.quantization === 1;

    // Validate stride against actual vertex data. Fill tiles (TerrainFillMesh)
    // may have vertex data with a different stride than their encoding reports,
    // because the encoding is inherited from the parent tile. The encoding may
    // say stride=8 (pos+h+uv+webMercT+normal) but the fill mesh only wrote
    // stride=6 (pos+h+uv). Detect this by finding the smallest valid stride
    // that accommodates all indices.
    if (indices.length > 0 && vertices.length > 0) {
      let maxIdx = 0;
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] > maxIdx) maxIdx = indices[k];
      }
      const neededVerts = maxIdx + 1;
      const vertCountAtStride = Math.floor(vertices.length / stride);
      if (neededVerts > vertCountAtStride) {
        // Current stride doesn't fit — find smallest valid stride.
        // Fill tiles may use stride as low as 4 (pos+height only).
        let correctedStride = 0;
        const minStride = isQuantized ? 3 : 4;
        for (let s = minStride; s <= stride; s++) {
          if (Math.floor(vertices.length / s) >= neededVerts) {
            correctedStride = s;
            break;
          }
        }
        // If corrected stride < 6 (uncompressed) or no stride found,
        // the vertex data lacks UV coordinates — skip this fill tile
        // rather than rendering with garbage UVs that produce black lines.
        if (correctedStride === 0 || (!isQuantized && correctedStride < 6)) {
          return null;
        }
        stride = correctedStride;
        // Recompute flags based on corrected stride
        if (!isQuantized) {
          hasWebMercatorT = stride >= 7 && encoding.hasWebMercatorT === true;
          hasNormals = stride >= 8 || (stride >= 7 && !hasWebMercatorT);
        }
      }
    }

    // WebGPU requires buffer sizes to be multiples of 4
    const vbSize = Math.ceil(vertices.byteLength / 4) * 4;
    const vertexBuffer = device.createBuffer({
      label: `Terrain VB ${tileKey}`,
      size: vbSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

    // Index buffers with Uint16Array may have non-4-byte-aligned byteLength;
    // pad to 4-byte alignment for writeBuffer compatibility
    const ibByteLength = indices.byteLength;
    const ibAlignedSize = Math.ceil(ibByteLength / 4) * 4;
    const indexBuffer = device.createBuffer({
      label: `Terrain IB ${tileKey}`,
      size: ibAlignedSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (ibAlignedSize !== ibByteLength) {
      // Pad to 4-byte alignment
      const padded = new Uint8Array(ibAlignedSize);
      padded.set(
        new Uint8Array(indices.buffer, indices.byteOffset, ibByteLength),
      );
      device.queue.writeBuffer(indexBuffer, 0, padded);
    } else {
      device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));
    }

    const indexFormat: GPUIndexFormat =
      indices.BYTES_PER_ELEMENT === 4 ? "uint32" : "uint16";

    const strideBytes = stride * 4;

    // Final validation: vertex count must accommodate all indices.
    // This is a safety net — the upfront stride correction above should
    // handle most fill tile mismatches, but edge cases can still occur.
    const vertexCount = Math.floor(vbSize / strideBytes);
    let validIndexCount = indices.length;
    if (vertexCount > 0 && indices.length > 0) {
      let maxIdx = 0;
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] > maxIdx) maxIdx = indices[k];
      }
      if (maxIdx >= vertexCount) {
        // Stride mismatch — encoding stride doesn't match actual vertex data.
        // Try to infer the correct stride from data length and max index.
        const actualVertCount = maxIdx + 1;
        const inferredStride = Math.floor(vertices.length / actualVertCount);

        // If we can infer a valid stride, use it instead
        if (
          inferredStride >= 3 &&
          inferredStride <= 8 &&
          vertices.length >= actualVertCount * inferredStride
        ) {
          const correctedStrideBytes = inferredStride * 4;
          const correctedVertCount = Math.floor(vbSize / correctedStrideBytes);
          if (maxIdx < correctedVertCount) {
            const resources: TileGPUResources = {
              vertexBuffer,
              indexBuffer,
              indexCount: indices.length,
              indexFormat,
              strideFloats: inferredStride,
              strideBytes: correctedStrideBytes,
              hasNormals:
                inferredStride >= 7 || (isQuantized && inferredStride >= 4),
              hasWebMercatorT,
              isQuantized,
              meshGeneration: generation,
            };
            this._tileBufferCache.set(tileKey, resources);
            return resources;
          }
        }

        // Fallback: clamp to safe indices
        let safeCount = 0;
        for (let k = 0; k < indices.length; k += 3) {
          if (
            k + 2 < indices.length &&
            indices[k] < vertexCount &&
            indices[k + 1] < vertexCount &&
            indices[k + 2] < vertexCount
          ) {
            safeCount = k + 3;
          } else {
            break;
          }
        }
        validIndexCount = safeCount;
        if (validIndexCount === 0) {
          vertexBuffer.destroy();
          indexBuffer.destroy();
          return null;
        }
      }
    }

    const resources: TileGPUResources = {
      vertexBuffer,
      indexBuffer,
      indexCount: validIndexCount,
      indexFormat,
      strideFloats: stride,
      strideBytes,
      hasNormals,
      hasWebMercatorT,
      isQuantized,
      meshGeneration: generation,
    };

    this._tileBufferCache.set(tileKey, resources);
    return resources;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Uniform Buffer Creation
  // ═══════════════════════════════════════════════════════════════════════

  private _createCameraUniformBuffer(
    device: GPUDevice,
    uniformState: any,
    surfaceTile: any,
    tileProvider: any,
    mesh: any,
    frameState?: any,
    tile?: any,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const data = this._cameraUniformData;
    let offset = 0;

    // mvpRelativeToEye (mat4x4, 16 floats)
    const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
    for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

    // modifiedModelView (mat4x4, 16 floats)
    const modifiedView = this._computeModifiedModelView(
      uniformState,
      surfaceTile,
    );
    const mv = m4Values(modifiedView);
    for (let i = 0; i < 16; i++) data[offset++] = mv[i];

    // modifiedModelViewProjection (mat4x4, 16 floats) — used by 2D/CV/Morphing
    // paths in the WGSL vertex shader. Equals projection × modifiedModelView.
    // Matches WebGL u_modifiedModelViewProjection (see
    // GlobeSurfaceTileProviderRendering.js).
    const mvp = this._cameraMvpScratch;
    multiplyMat4ColumnMajor(uniformState.projection, modifiedView, mvp);
    for (let i = 0; i < 16; i++) data[offset++] = mvp[i];

    // encodedCameraHigh (vec3 + pad)
    const camHigh = uniformState.encodedCameraPositionMCHigh;
    data[offset++] = camHigh.x;
    data[offset++] = camHigh.y;
    data[offset++] = camHigh.z;
    data[offset++] = 0;

    // encodedCameraLow (vec3 + pad)
    const camLow = uniformState.encodedCameraPositionMCLow;
    data[offset++] = camLow.x;
    data[offset++] = camLow.y;
    data[offset++] = camLow.z;
    data[offset++] = 0;

    // center3D (vec3 + pad) — must match the encoding center that vertex
    // positions are relative to (mesh.encoding.center or mesh.center)
    const center = mesh.center || mesh.encoding?.center || { x: 0, y: 0, z: 0 };
    if (this._diagTileCount <= 5) {
      const hasMC = !!mesh.center;
      const hasEC = !!mesh.encoding?.center;
      console.log(
        `[WebGPU:GlobeTile] center3D: mesh.center=${hasMC} encoding.center=${hasEC} ` +
          `value=(${center.x?.toFixed(1)}, ${center.y?.toFixed(1)}, ${center.z?.toFixed(1)})`,
      );
    }
    data[offset++] = center.x;
    data[offset++] = center.y;
    data[offset++] = center.z;
    data[offset++] = 0;

    // sunDirectionEC (vec3) + enableLighting (f32)
    const sunDir = uniformState.sunDirectionEC;
    data[offset++] = sunDir.x;
    data[offset++] = sunDir.y;
    data[offset++] = sunDir.z;
    data[offset++] = tileProvider.enableLighting ? 1.0 : 0.0;

    // scaleAndBias (mat4x4, 16 floats) — for quantized mesh decompression
    const encoding = mesh.encoding;
    if (encoding && encoding.matrix) {
      const sbm = m4Values(encoding.matrix);
      for (let i = 0; i < 16; i++) data[offset++] = sbm[i];
    } else {
      // Identity fallback (uncompressed terrain doesn't use this)
      for (let i = 0; i < 16; i++) data[offset++] = i % 5 === 0 ? 1.0 : 0.0;
    }

    // minMaxHeight (vec2 + pad2)
    data[offset++] = encoding?.minimumHeight ?? 0.0;
    data[offset++] = encoding?.maximumHeight ?? 0.0;
    data[offset++] = 0; // pad
    data[offset++] = 0; // pad

    // ─── 2D / Columbus View support ───
    // tileRectangle (vec4): west, south, east, north (radians)
    const rectangle = tile?.rectangle;
    if (rectangle) {
      data[offset++] = rectangle.west;
      data[offset++] = rectangle.south;
      data[offset++] = rectangle.east;
      data[offset++] = rectangle.north;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // southAndNorthLatitude (vec2)
    if (rectangle) {
      data[offset++] = rectangle.south;
      data[offset++] = rectangle.north;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // southMercatorYAndOneOverHeight (vec2)
    // Computed from tile rectangle: southMercY = log((1+sin(south))/(1-sin(south))) * 0.5
    // mercatorHeight = northMercY - southMercY
    if (rectangle) {
      const south = Math.max(rectangle.south, -1.4844222297453324);
      const north = Math.min(rectangle.north, 1.4844222297453324);
      const sinS = Math.sin(south);
      const sinN = Math.sin(north);
      const southMercY = 0.5 * Math.log((1 + sinS) / (1 - sinS));
      const northMercY = 0.5 * Math.log((1 + sinN) / (1 - sinN));
      const height = northMercY - southMercY;
      data[offset++] = southMercY;
      data[offset++] = height > 1e-9 ? 1.0 / height : 0.0;
    } else {
      data[offset++] = 0;
      data[offset++] = 0;
    }

    // sceneMode (f32): 0=MORPH, 1=COLUMBUS, 2=2D, 3=3D
    data[offset++] = frameState?.mode ?? 3;
    // morphTime (f32): 0..1, used for morphing transitions
    data[offset++] = frameState?.morphTime ?? 1.0;
    // useWebMercator (f32): 1 if Web Mercator projection, 0 if Geographic
    const projection = frameState?.mapProjection;
    const isWebMercator =
      projection &&
      projection.constructor &&
      projection.constructor.name === "WebMercatorProjection";
    data[offset++] = isWebMercator ? 1.0 : 0.0;
    data[offset++] = 0; // pad

    const bufferSize = Math.max(CAMERA_UNIFORM_BYTES, 256);
    return this._writeUniformSlice(
      device,
      frameState,
      data,
      bufferSize,
      "Terrain camera UB",
    );
  }

  /**
   * Sub-allocate a uniform buffer slice from the context's ring buffer
   * (when available) and write `data` into it. Falls back to a fresh
   * `device.createBuffer` for the rare path where the ring allocator is
   * unavailable (early init / non-WebGPU context). Caller binds the slice
   * via `{ buffer, offset, size }` in the bind group entry.
   *
   * BUG-9 fix: previously every call here allocated a fresh `GPUBuffer`
   * with no destruction. With ~30 tiles × 2 buffers per frame × 60fps the
   * device ran out of memory in seconds and reported "Device lost (OOM)".
   * The ring allocator suballocates from triple-buffered 4MB pages,
   * eliminating the per-frame churn entirely.
   */
  private _writeUniformSlice(
    device: GPUDevice,
    frameState: any,
    data: Float32Array,
    bufferSize: number,
    label: string,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const ctx: any = frameState?.context;
    const allocator = ctx?.uniformAllocator;
    const writeBytes = Math.min(data.byteLength, bufferSize);

    if (allocator) {
      const alloc = allocator.allocate(bufferSize);
      device.queue.writeBuffer(
        alloc.buffer,
        alloc.offset,
        data.buffer,
        data.byteOffset,
        writeBytes,
      );
      // Bind exactly the requested struct size, not the allocator's
      // 256-aligned slice size. The shader struct is `bufferSize` bytes;
      // padding bytes [bufferSize, alloc.size) belong to the allocator's
      // alignment slack and may overlap into the next allocation's data
      // on the next frame. Reporting the exact struct size keeps the
      // binding view tight against the WGSL struct definition.
      return { buffer: alloc.buffer, offset: alloc.offset, size: bufferSize };
    }

    // Fallback path — only reached when the ring allocator hasn't been
    // initialized yet (e.g., very first frame on a fresh context).
    const buffer = device.createBuffer({
      label,
      size: bufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      writeBytes,
    );
    return { buffer, offset: 0, size: bufferSize };
  }

  private _computeModifiedModelView(
    uniformState: any,
    surfaceTile: any,
  ): Float64Array {
    const view = uniformState.view;
    const center = surfaceTile.center;
    if (!center) return new Float64Array(view);

    const result = new Float64Array(16);
    for (let i = 0; i < 16; i++) result[i] = view[i];

    result[12] += view[0] * center.x + view[4] * center.y + view[8] * center.z;
    result[13] += view[1] * center.x + view[5] * center.y + view[9] * center.z;
    result[14] += view[2] * center.x + view[6] * center.y + view[10] * center.z;

    return result;
  }

  /**
   * Create tile uniform buffer with imagery, fog, water mask, clipping,
   * and day/night params. Supports per-pass imagery layer subsets.
   */
  private _createTileUniformBuffer(
    device: GPUDevice,
    surfaceTile: any,
    tileProvider: any,
    frameState: any,
    tile: any,
    passLayers: any[],
    isSubsequentPass: boolean,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const data = this._tileUniformData;
    const u32 = this._tileUniformU32View;
    data.fill(0);

    // ─── Imagery layers (offsets 0-47) ───
    let layerCount = 0;

    for (
      let i = 0;
      i < passLayers.length && layerCount < MAX_IMAGERY_LAYERS;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      if (!imagery.imageryLayer) continue;

      const baseOffset = layerCount * 12;

      // translationAndScale (vec4) — uses the cached value directly.
      // When useWebMercatorT=true, the cached values are in Mercator-native
      // space and the shader samples with webMercatorT (matching WebGL behavior).
      const ts = tileImagery.textureTranslationAndScale;
      if (ts) {
        data[baseOffset + 0] = ts.x;
        data[baseOffset + 1] = ts.y;
        data[baseOffset + 2] = ts.z;
        data[baseOffset + 3] = ts.w;
      } else {
        data[baseOffset + 2] = 1;
        data[baseOffset + 3] = 1;
      }

      // useWebMercatorT per layer (offsets 88-91)
      data[88 + layerCount] = tileImagery.useWebMercatorT ? 1.0 : 0.0;

      // texCoordsRectangle (vec4)
      const rect = tileImagery.textureCoordinateRectangle;
      if (rect) {
        data[baseOffset + 4] = rect.x;
        data[baseOffset + 5] = rect.y;
        data[baseOffset + 6] = rect.z;
        data[baseOffset + 7] = rect.w;
      } else {
        data[baseOffset + 6] = 1;
        data[baseOffset + 7] = 1;
      }

      const layer = imagery.imageryLayer;
      data[baseOffset + 8] = layer.alpha ?? 1.0;
      data[baseOffset + 9] = layer.brightness ?? 1.0;
      data[baseOffset + 10] = layer.contrast ?? 1.0;
      data[baseOffset + 11] = layer.saturation ?? 1.0;

      // Day/night alpha at offsets 62+ (packed per layer)
      const dnOffset = 62 + layerCount * 2;
      data[dnOffset] = layer.dayAlpha ?? 1.0;
      data[dnOffset + 1] = layer.nightAlpha ?? 1.0;

      layerCount++;
    }

    // ─── layerCount (f32 at float offset 48) ───
    // Changed from u32 to f32 to diagnose uniform buffer data transfer issue.
    // If the globe turns yellow with this change, the data IS reaching the
    // shader but the u32 interpretation was wrong.
    data[48] = layerCount;

    // Diagnostic: verify layerCount is set correctly
    if (this._diagTileCount <= 10 && layerCount > 0) {
      console.log(
        `[WebGPU:GlobeTile] UNIFORM: layerCount=${layerCount} u32[48]=${u32[48]} ` +
          `bufSize=${Math.max(TILE_UNIFORM_BYTES, 256)} dataBytes=${data.byteLength} ` +
          `byte192=0x${new DataView(data.buffer).getUint32(192, true).toString(16)}`,
      );
    }

    // ─── Fog parameters (offsets 49-51) ───
    // Phase 1.4 — `frameState.atmosphericConditions.weather.humidity`
    // (default 0.5 = no change) modulates fog density on a (0.5+humidity)
    // multiplier: 0.0 humidity → 0.5× density (very dry desert), 0.5 →
    // 1.0× (default, no change), 1.0 → 1.5× (tropical jungle haze).
    // Linear and bounded so the existing fog tuning stays predictable.
    if (frameState && frameState.fog) {
      let density = frameState.fog.density ?? 0.0;
      const ac = frameState.atmosphericConditions;
      const weather = ac && ac.weather ? ac.weather : undefined;
      if (weather && typeof weather.humidity === "number") {
        density = density * (0.5 + weather.humidity);
      }
      data[49] = density;
      data[50] = frameState.fog.offset ?? 0.0;
      data[51] = frameState.fog.minimumBrightness ?? 0.03;
    } else {
      data[51] = 0.03;
    }

    // ─── Water mask translation and scale (offsets 52-55, vec4) ───
    if (!isSubsequentPass) {
      const wmTS = surfaceTile.waterMaskTranslationAndScale;
      if (wmTS) {
        data[52] = wmTS.x;
        data[53] = wmTS.y;
        data[54] = wmTS.z;
        data[55] = wmTS.w;
      }
    }

    // ─── Cartographic limit rectangle (offsets 56-59, vec4) ───
    if (tileProvider && tileProvider.cartographicLimitRectangle) {
      const limitRect = tileProvider.cartographicLimitRectangle;
      const tileRect = tile.rectangle;
      if (tileRect) {
        const invW = 1.0 / tileRect.width;
        const invH = 1.0 / tileRect.height;
        data[56] = (limitRect.west - tileRect.west) * invW;
        data[57] = (limitRect.south - tileRect.south) * invH;
        data[58] = (limitRect.east - tileRect.west) * invW;
        data[59] = (limitRect.north - tileRect.south) * invH;
      }
    } else {
      // No clipping — full tile visible
      data[58] = 1.0;
      data[59] = 1.0;
    }

    // ─── Night fade distance (offsets 60-61, vec2) ───
    if (tileProvider) {
      data[60] = tileProvider.nightFadeOutDistance ?? 10000000.0;
      data[61] = tileProvider.nightFadeInDistance ?? 50000000.0;
    } else {
      data[60] = 10000000.0;
      data[61] = 50000000.0;
    }

    // dayNightAlpha0-3 already set above during layer iteration (offsets 62-69)

    // ─── Padding (offsets 70-71) ───
    // Required for vec4 alignment of flags

    // ─── Flags (offsets 72-75, vec4) ───
    const hasWaterMask =
      !isSubsequentPass &&
      tileProvider &&
      tileProvider.hasWaterMask &&
      surfaceTile.waterMaskTexture !== undefined;
    const enableClipping =
      tileProvider &&
      tileProvider.cartographicLimitRectangle &&
      tileProvider.cartographicLimitRectangle.width < Math.PI * 2 - 0.001;
    const showOceanWaves =
      hasWaterMask &&
      tileProvider.showWaterEffect &&
      tileProvider.oceanNormalMap !== undefined;

    data[72] = hasWaterMask ? 1.0 : 0.0;
    data[73] = enableClipping ? 1.0 : 0.0;
    data[74] = showOceanWaves ? 1.0 : 0.0;
    data[75] = isSubsequentPass ? 1.0 : 0.0;

    // ─── Vertical exaggeration (offsets 76-77, vec2) ───
    data[76] = frameState?.verticalExaggeration ?? 1.0;
    data[77] = frameState?.verticalExaggerationRelativeHeight ?? 0.0;

    // ─── Time for ocean wave animation (offset 78) ───
    data[78] = frameState?.time ? performance.now() / 1000.0 : 0.0;
    // offset 79 is padding (_pad4)

    // ─── Ocean enhancement params (offsets 80-83, vec4) ───
    // oceanParams: x=deepR, y=deepG, z=deepB, w=fresnelPower
    // Defaults applied in shader when all zero (no tileProvider config needed)
    if (tileProvider?.oceanDeepColor) {
      const c = tileProvider.oceanDeepColor;
      data[80] = c.red ?? c.x ?? 0.008;
      data[81] = c.green ?? c.y ?? 0.045;
      data[82] = c.blue ?? c.z ?? 0.12;
    }
    data[83] = tileProvider?.oceanFresnelPower ?? 0.0; // 0 = use shader default

    // ─── Night & ocean secondary params (offsets 84-87, vec4) ───
    // nightOceanParams: x=nightIntensity, y=oceanReflectivity, z=foamThreshold, w=oceanDarkening
    data[84] = tileProvider?.nightIntensity ?? 0.0; // 0 = use shader default (2.5)
    data[85] = tileProvider?.oceanReflectivity ?? 0.0; // 0 = use shader default (0.04)
    data[86] = tileProvider?.oceanFoamThreshold ?? 0.0; // 0 = use shader default (0.35)
    data[87] = tileProvider?.oceanDarkening ?? 0.0; // 0 = use shader default (0.6)

    // ─── Per-tile debug fields (offsets 92-95, vec4) ───
    // Tier 2 debug: tile depth-level + imagery layer isolation. Both
    // sourced from frameState so a single Scene property toggle flips
    // them on for every tile uniformly. Production cost is two property
    // reads + two array writes per tile, sub-noise-floor.
    //   .x = tileLevel — read by fragmentDebugLod for the LOD overlay
    //   .y = isolateImageryLayer — when >= 0, fragmentMain renders only
    //        that layer index (0..3 within the current pass) and skips
    //        the rest of the imagery composite. -1 = production behavior.
    //   .z, .w = reserved for future per-tile debug toggles
    data[92] = tile?.level ?? 0;
    const isolate = frameState.debugShowImageryLayer;
    data[93] = typeof isolate === "number" && isolate >= 0 ? isolate : -1;
    data[94] = 0;
    data[95] = 0;

    return this._writeUniformSlice(
      device,
      frameState,
      data,
      Math.max(TILE_UNIFORM_BYTES, 256),
      "Terrain tile UB",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Texture Management
  // ═══════════════════════════════════════════════════════════════════════

  private _createTextureBindGroup(
    device: GPUDevice,
    passLayers: any[],
  ): GPUBindGroup {
    const textureViews: GPUTextureView[] = [];

    for (
      let i = 0;
      i < passLayers.length && textureViews.length < MAX_IMAGERY_LAYERS;
      i++
    ) {
      const tileImagery = passLayers[i];
      if (!tileImagery || !tileImagery.readyImagery) continue;

      const imagery = tileImagery.readyImagery;
      const view = this._getOrCreateImageryTexture(imagery);
      if (view) {
        textureViews.push(view);
      } else if (this._diagTileCount <= 30) {
        console.warn(
          `[WebGPU:GlobeTile] _getOrCreateImageryTexture returned null for imagery`,
          {
            hasImage: !!imagery?.image,
            hasTexture: !!imagery?.texture,
            hasWebGPUTex: !!imagery?._webgpuReprojectedTexture,
            texSource: !!imagery?.texture?._source,
          },
        );
      }
    }

    while (textureViews.length < MAX_IMAGERY_LAYERS) {
      textureViews.push(this._placeholderView!);
    }

    return device.createBindGroup({
      layout: this._bindGroupLayout1!,
      entries: [
        { binding: 0, resource: textureViews[0] },
        { binding: 1, resource: textureViews[1] },
        { binding: 2, resource: textureViews[2] },
        { binding: 3, resource: textureViews[3] },
        { binding: 4, resource: this._sampler! },
      ],
    });
  }

  /**
   * Create merged water mask + ocean normal bind group (Group 2).
   * Bindings 0-1: water mask texture + sampler
   * Bindings 2-3: ocean normal texture + sampler
   * Uses placeholder textures when resources are unavailable.
   */
  private _createWaterOceanBindGroup(
    device: GPUDevice,
    surfaceTile: any | null,
    tileProvider: any,
  ): GPUBindGroup {
    let waterMaskView = this._placeholderView!;
    let normalMapView = this._placeholderView!;

    if (surfaceTile) {
      const waterMaskTex = surfaceTile.waterMaskTexture;
      if (waterMaskTex) {
        const wmView = this._getOrCreateWaterMaskTexture(waterMaskTex);
        if (wmView) {
          waterMaskView = wmView;
        }
      }
    }

    const oceanNormalMap = tileProvider?.oceanNormalMap;
    if (oceanNormalMap) {
      const source =
        oceanNormalMap._source ?? oceanNormalMap.image ?? oceanNormalMap;
      if (
        source instanceof HTMLImageElement ||
        source instanceof ImageBitmap ||
        source instanceof HTMLCanvasElement
      ) {
        const view = this._uploadImageSource(
          source,
          "oceanNormal",
          this._oceanNormalMapCache,
        );
        if (view) {
          normalMapView = view;
        }
      }
    }

    return device.createBindGroup({
      layout: this._bindGroupLayout2!,
      entries: [
        { binding: 0, resource: waterMaskView },
        { binding: 1, resource: this._waterMaskSampler! },
        { binding: 2, resource: normalMapView },
        { binding: 3, resource: this._oceanNormalSampler! },
      ],
    });
  }

  private _getOrCreateImageryTexture(imagery: any): GPUTextureView | null {
    if (!imagery) return null;

    const cacheKey =
      imagery.key || `${imagery.x}_${imagery.y}_${imagery.level}`;
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) return cached.view;

    // If imagery was reprojected by WebGPUImageryReprojection, use
    // the pre-reprojected GPUTexture directly instead of re-uploading.
    if (imagery._webgpuReprojectedTexture) {
      const gpuTex = imagery._webgpuReprojectedTexture as GPUTexture;
      const view = gpuTex.createView({ label: `imagery_reproj_${cacheKey}` });
      this._imageryTextureCache.set(cacheKey, {
        texture: gpuTex,
        view,
        sourceWidth: gpuTex.width,
        sourceHeight: gpuTex.height,
      });
      return view;
    }

    const source = imagery.image || imagery.texture?._source;
    if (!source) {
      if (this._diagTileCount <= 10) {
        console.warn(`[WebGPU:GlobeTile] No image source for ${cacheKey}`, {
          hasImage: !!imagery.image,
          hasTexture: !!imagery.texture,
          texSource: !!imagery.texture?._source,
        });
      }
      return null;
    }

    if (this._diagTileCount <= 10) {
      console.log(
        `[WebGPU:GlobeTile] Uploading image for ${cacheKey} type=${source.constructor?.name}`,
      );
    }
    return this._uploadImageSource(source, cacheKey, this._imageryTextureCache);
  }

  private _getOrCreateWaterMaskTexture(
    waterMaskTex: any,
  ): GPUTextureView | null {
    // Water mask textures are WebGL Texture objects; extract the source image
    const source = waterMaskTex._source || waterMaskTex.image;
    if (!source) return null;

    const cacheKey = `wm_${waterMaskTex._id || "default"}`;
    const cached = this._waterMaskTextureCache.get(cacheKey);
    if (cached) return cached.view;

    return this._uploadImageSource(
      source,
      cacheKey,
      this._waterMaskTextureCache,
    );
  }

  /**
   * Upload an image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement)
   * to a GPU texture.
   */
  private _uploadImageSource(
    source: any,
    cacheKey: string,
    cache: Map<string, ImageryGPUTexture>,
  ): GPUTextureView | null {
    const device = this._device!;

    try {
      let width: number, height: number;
      if (source instanceof ImageBitmap) {
        width = source.width;
        height = source.height;
      } else if (source instanceof HTMLImageElement) {
        width = source.naturalWidth || source.width;
        height = source.naturalHeight || source.height;
      } else if (source instanceof HTMLCanvasElement) {
        width = source.width;
        height = source.height;
      } else {
        return null;
      }

      if (width === 0 || height === 0) return null;

      const texture = device.createTexture({
        label: `Globe ${cacheKey}`,
        size: [width, height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      device.queue.copyExternalImageToTexture(
        { source: source as any },
        { texture },
        [width, height],
      );

      const view = texture.createView();
      cache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
      });

      return view;
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Wireframe Debug Mode
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get or lazily create a wireframe (line-list) pipeline for the given
   * quantization/normals combination. Wireframe pipelines reuse the same
   * shaders but use line-list topology with no back-face culling.
   */
  /**
   * Cold-path wireframe pipeline selector. Mirrors `_selectPipeline` exactly
   * in shape (Q/U, N/X, M/G, stride) so the wireframe variant uses the same
   * vertex layout as the production pipeline for the tile being drawn —
   * crucial because mismatched strides crash the GPU. Only differs in
   * topology (line-list vs triangle-list) and cull mode.
   *
   * Kept entirely off the hot path; only invoked when
   * `frameState.debugShowGlobeWireframe` is true.
   */
  private _selectWireframePipeline(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    strideBytes: number,
  ): GPURenderPipeline {
    const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${hasWebMercatorT ? "M" : "G"}_${strideBytes}`;
    let pipeline = this._wireframePipelineCache.get(cacheKey);
    if (pipeline) {
      return pipeline;
    }
    pipeline = this._createWireframePipelineVariant(
      isQuantized,
      hasNormals,
      hasWebMercatorT,
      strideBytes,
    );
    this._wireframePipelineCache.set(cacheKey, pipeline);
    return pipeline;
  }

  /**
   * Builds a wireframe variant of the terrain pipeline. Vertex stage is the
   * full production layout (matching `_createPipelineVariant`); only the
   * primitive topology and depth/cull state differ. Reuses the production
   * shader module — no special wireframe entry point needed because line-list
   * topology applied to triangle indices produces edges automatically when
   * the IB is converted (see `_getOrCreateWireframeIndices`).
   */
  private _createWireframePipelineVariant(
    isQuantized: boolean,
    hasNormals: boolean,
    hasWebMercatorT: boolean,
    strideBytes: number,
  ): GPURenderPipeline {
    const device = this._device!;

    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;

    if (isQuantized) {
      let format: GPUVertexFormat;
      if (hasWebMercatorT) {
        format = "float32x4";
        entryPoint = "vertexMainQuantizedWebMerc";
      } else if (hasNormals) {
        format = "float32x4";
        entryPoint = "vertexMainQuantized";
      } else {
        format = "float32x3";
        entryPoint = "vertexMainQuantized";
      }
      const minStride = hasWebMercatorT || hasNormals ? 16 : 12;
      const actualStride = Math.max(strideBytes, minStride);
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format }],
        },
      ];
    } else {
      let texCoordFormat: GPUVertexFormat;
      if (hasWebMercatorT && hasNormals) {
        texCoordFormat = "float32x4";
        entryPoint = "vertexMainWebMercNormals";
      } else if (hasWebMercatorT) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMainWebMerc";
      } else if (hasNormals) {
        texCoordFormat = "float32x3";
        entryPoint = "vertexMain";
      } else {
        texCoordFormat = "float32x2";
        entryPoint = "vertexMain";
      }
      const actualStride = Math.max(strideBytes, 24);
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: texCoordFormat },
          ],
        },
      ];
    }

    const quantLabel = isQuantized ? "quantized" : "uncompressed";
    const normLabel = hasNormals ? "normals" : "noNormals";
    const mercLabel = hasWebMercatorT ? "webMerc" : "geo";

    return device.createRenderPipeline({
      label: `Globe wireframe (${quantLabel}, ${normLabel}, ${mercLabel}, ${strideBytes}b)`,
      layout: this._pipelineLayout!,
      vertex: {
        module: this._shaderModule!,
        entryPoint,
        buffers: vertexBuffers,
      },
      fragment: {
        module: this._shaderModule!,
        entryPoint: "fragmentMain",
        targets: [{ format: this._canvasFormat }],
      },
      primitive: {
        topology: "line-list",
        cullMode: "none",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        // Slight depth bias would be ideal here, but WebGPU's depthBias
        // applies only to triangle topology — for line-list we accept the
        // co-planar z-fight and rely on the wireframe being a debug overlay.
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }

  /**
   * Convert triangle indices to line indices. Each triangle (i0, i1, i2)
   * produces 3 line segments: (i0,i1), (i1,i2), (i2,i0). Creates and
   * caches a GPU index buffer for the wireframe.
   */
  private _getOrCreateWireframeIndices(
    tileKey: string,
    mesh: any,
  ): { buffer: GPUBuffer; count: number; format: GPUIndexFormat } | null {
    const cached = this._wireframeIndexCache.get(tileKey);
    if (cached) return cached;

    const device = this._device!;
    const triIndices = mesh.indices;
    if (!triIndices || triIndices.length < 3) return null;

    const triCount = Math.floor(triIndices.length / 3);
    const lineCount = triCount * 3; // 3 edges per triangle
    const lineIndexCount = lineCount * 2; // 2 indices per line

    // Use same index type as the source
    const use32 = triIndices.BYTES_PER_ELEMENT === 4;
    const wireIndices = use32
      ? new Uint32Array(lineIndexCount)
      : new Uint16Array(lineIndexCount);

    let out = 0;
    for (let t = 0; t < triCount; t++) {
      const base = t * 3;
      const i0 = triIndices[base];
      const i1 = triIndices[base + 1];
      const i2 = triIndices[base + 2];
      wireIndices[out++] = i0;
      wireIndices[out++] = i1;
      wireIndices[out++] = i1;
      wireIndices[out++] = i2;
      wireIndices[out++] = i2;
      wireIndices[out++] = i0;
    }

    const buffer = device.createBuffer({
      label: `Terrain wireframe IB ${tileKey}`,
      size: wireIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, gpuData(wireIndices));

    const result = {
      buffer,
      count: lineIndexCount,
      format: (use32 ? "uint32" : "uint16") as GPUIndexFormat,
    };
    this._wireframeIndexCache.set(tileKey, result);
    return result;
  }

  /**
   * Create wireframe draw commands for a tile. Uses line-list topology
   * pipeline and triangle-to-line converted index buffer.
   */
  createWireframeTileCommands(
    tile: any,
    surfaceTile: any,
    tileProvider: any,
    frameState: any,
    uniformState: any,
  ): TileDrawDescriptor[] | null {
    if (!this._isInitialized || !this._device) return null;

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    const tileKey = this._getTileKey(tile);
    const gpuResources = this._getOrCreateTileBuffers(tileKey, mesh);
    if (!gpuResources) return null;

    const wireIB = this._getOrCreateWireframeIndices(tileKey, mesh);
    if (!wireIB) return null;

    const pipeline = this._selectWireframePipeline(
      gpuResources.isQuantized,
      gpuResources.hasNormals,
      gpuResources.hasWebMercatorT,
      gpuResources.strideBytes,
    );

    // Single pass for wireframe — no multi-pass imagery needed
    const cameraUB = this._createCameraUniformBuffer(
      device,
      uniformState,
      surfaceTile,
      tileProvider,
      mesh,
      frameState,
      tile,
    );
    const tileUB = this._createTileUniformBuffer(
      device,
      surfaceTile,
      tileProvider,
      frameState,
      tile,
      [],
      false,
    );

    const bindGroup0 = device.createBindGroup({
      layout: this._bindGroupLayout0!,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: cameraUB.buffer,
            offset: cameraUB.offset,
            size: cameraUB.size,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: tileUB.buffer,
            offset: tileUB.offset,
            size: tileUB.size,
          },
        },
      ],
    });

    // Use placeholder textures for wireframe — imagery not needed
    const bindGroup1 = this._createTextureBindGroup(device, []);
    const bindGroup2 = this._createWaterOceanBindGroup(
      device,
      null,
      tileProvider,
    );

    return [
      {
        pipeline,
        bindGroups: [
          bindGroup0,
          bindGroup1,
          bindGroup2,
          this._placeholderEffectsBG!,
        ],
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: wireIB.buffer,
        indexCount: wireIB.count,
        indexFormat: wireIB.format,
        boundingVolume: tile.boundingVolume || surfaceTile.boundingSphere3D,
        isSubsequentPass: false,
      },
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cache Eviction
  // ═══════════════════════════════════════════════════════════════════════

  evictStaleResources(activeTileKeys: Set<string>): void {
    for (const [key, resources] of this._tileBufferCache) {
      if (!activeTileKeys.has(key)) {
        resources.vertexBuffer.destroy();
        resources.indexBuffer.destroy();
        this._tileBufferCache.delete(key);
      }
    }
  }

  removeImageryTexture(cacheKey: string): void {
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) {
      cached.texture.destroy();
      this._imageryTextureCache.delete(cacheKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Access
  // ═══════════════════════════════════════════════════════════════════════

  get pipeline(): GPURenderPipeline | null {
    return this._pipelineCache.get("UNO_28") ?? null;
  }

  get pipelineNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("UXO_24") ?? null;
  }

  get pipelineQuantized(): GPURenderPipeline | null {
    return this._pipelineCache.get("QNO_16") ?? null;
  }

  get pipelineQuantizedNoNormals(): GPURenderPipeline | null {
    return this._pipelineCache.get("QXO_12") ?? null;
  }

  get bindGroupLayout0(): GPUBindGroupLayout | null {
    return this._bindGroupLayout0;
  }

  get bindGroupLayout1(): GPUBindGroupLayout | null {
    return this._bindGroupLayout1;
  }

  get bindGroupLayout2(): GPUBindGroupLayout | null {
    return this._bindGroupLayout2;
  }

  get sampler(): GPUSampler | null {
    return this._sampler;
  }

  get placeholderTextureView(): GPUTextureView | null {
    return this._placeholderView;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  destroy(): void {
    if (this._isDestroyed) return;

    for (const [, resources] of this._tileBufferCache) {
      resources.vertexBuffer.destroy();
      resources.indexBuffer.destroy();
    }
    this._tileBufferCache.clear();

    for (const [, cached] of this._imageryTextureCache) {
      cached.texture.destroy();
    }
    this._imageryTextureCache.clear();

    for (const [, cached] of this._waterMaskTextureCache) {
      cached.texture.destroy();
    }
    this._waterMaskTextureCache.clear();

    for (const [, cached] of this._oceanNormalMapCache) {
      cached.texture.destroy();
    }
    this._oceanNormalMapCache.clear();

    for (const [, wf] of this._wireframeIndexCache) {
      wf.buffer.destroy();
    }
    this._wireframeIndexCache.clear();

    if (this._placeholderTexture) {
      this._placeholderTexture.destroy();
    }

    this._pipelineCache.clear();
    this._wireframePipelineCache.clear();
    this._debugFragmentPipelineCache.clear();
    this._shaderModule = null;
    this._sampler = null;
    this._waterMaskSampler = null;
    this._oceanNormalSampler = null;
    this._bindGroupLayout0 = null;
    this._bindGroupLayout1 = null;
    this._bindGroupLayout2 = null;
    this._effectsBGL = null;
    this._placeholderEffectsBG = null;
    this._pipelineLayout = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
