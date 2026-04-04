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
// CameraUniforms: mvpRTE(16) + modifiedMV(16) + camHigh(3+1) + camLow(3+1) +
//   center3D(3+1) + sunDirEC(3)+enableLighting(1) + scaleAndBias(16) +
//   minMaxHeight(2) + pad(2) = 68 floats
const CAMERA_UNIFORM_FLOATS = 68;
const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

// TileUniforms: layers(4×12=48) + layerCount(1) + fog(3) +
//   waterMaskTS(4) + cartLimitRect(4) + nightFade(2) +
//   dayNightAlpha0-3(4×2=8) + flags(4) + exaggeration(2) + time(1) + pad(1)
//   + oceanParams(4) + nightOceanParams(4) = 88 floats
const TILE_UNIFORM_FLOATS = 88;
const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Max imagery layers per tile in single draw call
const MAX_IMAGERY_LAYERS = 4;

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

export class WebGPUGlobeSurfaceRenderer {
  private _device: GPUDevice | null = null;
  private _diagTileCount = 0;
  private _pipelineCache: Map<string, GPURenderPipeline> = new Map();
  private _shaderModule: GPUShaderModule | null = null;
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

  // Wireframe pipelines (lazily created on first wireframe request)
  private _wireframePipelines: (GPURenderPipeline | null)[] = new Array(4).fill(
    null,
  );
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
    this._shaderModule = this._device!.createShaderModule({
      label: "GlobeTerrain shader",
      code,
    });
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
    isBlend: boolean,
    strideBytes: number,
  ): GPURenderPipeline {
    const device = this._device!;

    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;

    if (isQuantized) {
      // BITS12 quantized: compressed0 is 3 or 4 floats
      // Minimum stride: hasNormals ? 16 : 12. Actual stride may be larger
      // (e.g., with webMercator) — extra data is simply skipped by the shader.
      const minStride = hasNormals ? 16 : 12;
      const actualStride = Math.max(strideBytes, minStride);
      const format: GPUVertexFormat = hasNormals ? "float32x4" : "float32x3";
      entryPoint = "vertexMainQuantized";
      vertexBuffers = [
        {
          arrayStride: actualStride,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format }],
        },
      ];
    } else {
      // Uncompressed: position3DAndHeight(vec4=16) + texCoord+normal(vec2/3)
      // Minimum stride: hasNormals ? 28 : 24. Actual stride may be larger
      // (e.g., stride=8 for webMercator+normals = 32 bytes).
      const minStride = hasNormals ? 28 : 24;
      const actualStride = Math.max(strideBytes, minStride);
      const texCoordFormat: GPUVertexFormat = hasNormals
        ? "float32x3"
        : "float32x2";
      entryPoint = "vertexMain";
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

    return device.createRenderPipeline({
      label: `Globe terrain (${quantLabel}, ${normLabel}, ${blendLabel})`,
      layout: this._pipelineLayout!,
      vertex: {
        module: this._shaderModule!,
        entryPoint,
        buffers: vertexBuffers,
      },
      fragment: {
        module: this._shaderModule!,
        entryPoint: "fragmentMain",
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
    isBlend: boolean,
    strideBytes: number,
  ): GPURenderPipeline {
    const cacheKey = `${isQuantized ? "Q" : "U"}${hasNormals ? "N" : "X"}${isBlend ? "B" : "O"}_${strideBytes}`;
    let pipeline = this._pipelineCache.get(cacheKey);
    if (!pipeline) {
      pipeline = this._createPipelineVariant(
        isQuantized,
        hasNormals,
        isBlend,
        strideBytes,
      );
      this._pipelineCache.set(cacheKey, pipeline);
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

    // Diagnostic: log imagery status for first few tiles
    if (this._diagTileCount < 10) {
      this._diagTileCount++;
      const imgLen = imageryCollection ? imageryCollection.length : 0;
      console.log(
        `[WebGPU:GlobeTile] tile=${tileKey} imagery=${imgLen} ready=${totalLayers}`,
      );
      if (totalLayers > 0) {
        const sample = readyLayers[0];
        const ri = sample?.readyImagery;
        console.log(
          `[WebGPU:GlobeTile]   sample: hasImage=${!!ri?.image} hasTexture=${!!ri?.texture} hasWebGPUTex=${!!ri?._webgpuReprojectedTexture} state=${ri?.state}`,
        );
      }
    }

    for (let pass = 0; pass < passCount; pass++) {
      const isSubsequentPass = pass > 0;
      const layerStart = pass * MAX_IMAGERY_LAYERS;
      const layerEnd = Math.min(layerStart + MAX_IMAGERY_LAYERS, totalLayers);
      const passLayers = readyLayers.slice(layerStart, layerEnd);

      const pipeline = this._selectPipeline(
        gpuResources.isQuantized,
        gpuResources.hasNormals,
        isSubsequentPass,
        gpuResources.strideBytes,
      );

      const cameraUB = this._createCameraUniformBuffer(
        device,
        uniformState,
        surfaceTile,
        tileProvider,
        mesh,
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
          { binding: 0, resource: { buffer: cameraUB } },
          { binding: 1, resource: { buffer: tileUB } },
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

      commands.push({
        pipeline,
        bindGroups: [bindGroup0, bindGroup1, bindGroup2, bindGroup3],
        vertexBuffer: gpuResources.vertexBuffer,
        indexBuffer: gpuResources.indexBuffer,
        indexCount: gpuResources.indexCount,
        indexFormat: gpuResources.indexFormat,
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
    const stride = encoding.stride;
    const hasNormals = encoding.hasVertexNormals === true;
    // TerrainQuantization.BITS12 = 1; NONE = 0
    const isQuantized =
      encoding.quantization !== undefined && encoding.quantization === 1;

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

    // Validate: the vertex count (as computed by WebGPU from bufferSize / stride)
    // must exceed the maximum index value in the index buffer.
    const vertexCount = Math.floor(vbSize / strideBytes);
    let validIndexCount = indices.length;
    if (vertexCount > 0 && indices.length > 0) {
      // Find the maximum index referenced
      let maxIdx = 0;
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] > maxIdx) maxIdx = indices[k];
      }
      if (maxIdx >= vertexCount) {
        // Indices reference vertices beyond the buffer — clamp to only
        // the indices that are within bounds. This happens with fill tiles
        // or tiles whose encoding stride doesn't match the actual data layout.
        let safeCount = 0;
        for (let k = 0; k < indices.length; k += 3) {
          // Check entire triangle (3 consecutive indices)
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
  ): GPUBuffer {
    const data = this._cameraUniformData;
    let offset = 0;

    // mvpRelativeToEye (mat4x4, 16 floats)
    const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
    for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

    // modifiedModelView (mat4x4, 16 floats)
    const mv = m4Values(
      this._computeModifiedModelView(uniformState, surfaceTile),
    );
    for (let i = 0; i < 16; i++) data[offset++] = mv[i];

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

    // center3D (vec3 + pad)
    const center = surfaceTile.center || { x: 0, y: 0, z: 0 };
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

    const bufferSize = Math.max(CAMERA_UNIFORM_BYTES, 256);
    const buffer = device.createBuffer({
      label: "Terrain camera UB",
      size: bufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      Math.min(data.byteLength, bufferSize),
    );
    return buffer;
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
  ): GPUBuffer {
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

      // translationAndScale (vec4)
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
    if (frameState && frameState.fog) {
      data[49] = frameState.fog.density ?? 0.0;
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

    const buffer = device.createBuffer({
      label: "Terrain tile UB",
      size: Math.max(TILE_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      data.buffer,
      data.byteOffset,
      Math.min(data.byteLength, Math.max(TILE_UNIFORM_BYTES, 256)),
    );
    return buffer;
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
      } else if (this._diagTileCount <= 10) {
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
  private _getWireframePipeline(
    isQuantized: boolean,
    hasNormals: boolean,
  ): GPURenderPipeline {
    const key = (isQuantized ? 2 : 0) + (hasNormals ? 0 : 1);
    if (this._wireframePipelines[key]) {
      return this._wireframePipelines[key]!;
    }

    const device = this._device!;
    let vertexBuffers: GPUVertexBufferLayout[];
    let entryPoint: string;

    if (isQuantized) {
      const stride = hasNormals ? 16 : 12;
      const format: GPUVertexFormat = hasNormals ? "float32x4" : "float32x3";
      entryPoint = "vertexMainQuantized";
      vertexBuffers = [
        {
          arrayStride: stride,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format }],
        },
      ];
    } else {
      const stride = hasNormals ? 28 : 24;
      const texCoordFormat: GPUVertexFormat = hasNormals
        ? "float32x3"
        : "float32x2";
      entryPoint = "vertexMain";
      vertexBuffers = [
        {
          arrayStride: stride,
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

    const pipeline = device.createRenderPipeline({
      label: `Globe wireframe (${quantLabel}, ${normLabel})`,
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
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this._wireframePipelines[key] = pipeline;
    return pipeline;
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

    const pipeline = this._getWireframePipeline(
      gpuResources.isQuantized,
      gpuResources.hasNormals,
    );

    // Single pass for wireframe — no multi-pass imagery needed
    const cameraUB = this._createCameraUniformBuffer(
      device,
      uniformState,
      surfaceTile,
      tileProvider,
      mesh,
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
        { binding: 0, resource: { buffer: cameraUB } },
        { binding: 1, resource: { buffer: tileUB } },
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
    this._wireframePipelines.fill(null);
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
