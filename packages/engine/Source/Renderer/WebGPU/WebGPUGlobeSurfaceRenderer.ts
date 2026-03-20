/// <reference types="@webgpu/types" />
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
/**
 * WebGPU Globe Surface Renderer
 *
 * Converts terrain tile data (from GlobeSurfaceTileProvider) into WebGPU
 * draw commands. Manages pipeline creation, vertex/index buffer upload,
 * imagery texture creation, and per-tile uniform buffer management.
 *
 * The terrain pipeline:
 *   1. GlobeSurfaceTileProvider.endUpdate() iterates visible tiles
 *   2. For each tile, addDrawCommandsForTile() is called
 *   3. When isWebGPU, this renderer creates WebGPUDrawCommand instead of DrawCommand
 *   4. Commands are pushed to frameState.commandList with pass=GLOBE
 *
 * Vertex data: Interleaved Float32Array from TerrainEncoding
 *   - Uncompressed (stride 6-10): [posX, posY, posZ, height, u, v, ...]
 *   - Quantized BITS12 (stride 3-6): [compressed0, compressed1, compressed2, ...]
 *   Currently supports uncompressed format only (BITS12 support planned).
 *
 * @private
 */

// ─── Uniform buffer sizes (must match GlobeTerrain.wgsl) ───
// CameraUniforms: 48 floats = 192 bytes
const CAMERA_UNIFORM_FLOATS = 48;
const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;
// TileUniforms: 4 layers × 12 floats + 4 floats = 52 floats = 208 bytes
const TILE_UNIFORM_FLOATS = 52;
const TILE_UNIFORM_BYTES = TILE_UNIFORM_FLOATS * 4;

// Max imagery layers per tile in single draw call
const MAX_IMAGERY_LAYERS = 4;

/** Cached per-tile WebGPU resources */
interface TileGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  stride: number; // vertex stride in floats
  hasNormals: boolean;
  /** Generation counter to detect stale buffers */
  meshGeneration: number;
}

/** Cached imagery texture */
interface ImageryGPUTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  /** Source image width for cache invalidation */
  sourceWidth: number;
  sourceHeight: number;
}

export class WebGPUGlobeSurfaceRenderer {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _pipelineNoNormals: GPURenderPipeline | null = null;
  private _shaderModule: GPUShaderModule | null = null;
  private _sampler: GPUSampler | null = null;
  private _bindGroupLayout0: GPUBindGroupLayout | null = null;
  private _bindGroupLayout1: GPUBindGroupLayout | null = null;
  private _pipelineLayout: GPUPipelineLayout | null = null;
  private _placeholderTexture: GPUTexture | null = null;
  private _placeholderView: GPUTextureView | null = null;
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";

  // Per-tile GPU resource caches (keyed by tile key string)
  private _tileBufferCache: Map<string, TileGPUResources> = new Map();
  private _imageryTextureCache: Map<string, ImageryGPUTexture> = new Map();

  // Reusable typed arrays for uniform data
  private _cameraUniformData: Float32Array = new Float32Array(
    CAMERA_UNIFORM_FLOATS,
  );
  private _tileUniformData: Float32Array = new Float32Array(
    TILE_UNIFORM_FLOATS,
  );
  // For the layerCount u32 at end of tile uniforms
  private _tileUniformU32View: Uint32Array;

  private _isDestroyed: boolean = false;
  private _isInitialized: boolean = false;

  constructor() {
    // Create a Uint32Array view into the same buffer as tile uniforms
    // The layerCount is at float offset 48 (byte offset 192)
    this._tileUniformU32View = new Uint32Array(this._tileUniformData.buffer);
  }

  /**
   * Initialize the renderer with the GPU device and shader code.
   * Must be called once before creating tile commands.
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
    this._createSampler();
    this._createPlaceholderTexture();
    this._createPipelines();

    this._isInitialized = true;
  }

  /** Check if initialized */
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

    // Group 0: Uniform buffers (camera + tile)
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

    // Group 1: Textures + sampler (4 day textures + 1 sampler)
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
  }

  // ─── Pipeline Layout ───
  private _createPipelineLayout(): void {
    this._pipelineLayout = this._device!.createPipelineLayout({
      label: "Globe terrain pipeline layout",
      bindGroupLayouts: [this._bindGroupLayout0!, this._bindGroupLayout1!],
    });
  }

  // ─── Sampler ───
  private _createSampler(): void {
    this._sampler = this._device!.createSampler({
      label: "Globe terrain sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  // ─── Placeholder 1x1 white texture for tiles without imagery ───
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

  // ─── Render Pipelines ───
  private _createPipelines(): void {
    // Pipeline with normals (stride 7+ floats = 28+ bytes)
    this._pipeline = this._createPipelineVariant(true);
    // Pipeline without normals (stride 6 floats = 24 bytes)
    this._pipelineNoNormals = this._createPipelineVariant(false);
  }

  private _createPipelineVariant(hasNormals: boolean): GPURenderPipeline {
    const device = this._device!;
    const stride = hasNormals ? 28 : 24; // 7 or 6 floats
    const texCoordFormat: GPUVertexFormat = hasNormals
      ? "float32x3"
      : "float32x2";

    return device.createRenderPipeline({
      label: `Globe terrain pipeline (normals=${hasNormals})`,
      layout: this._pipelineLayout!,
      vertex: {
        module: this._shaderModule!,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: stride,
            stepMode: "vertex",
            attributes: [
              {
                // position3DAndHeight: vec4<f32>
                shaderLocation: 0,
                offset: 0,
                format: "float32x4",
              },
              {
                // textureCoordAndEncodedNormals: vec2 or vec3
                shaderLocation: 1,
                offset: 16,
                format: texCoordFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: this._shaderModule!,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: this._canvasFormat,
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
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tile Command Creation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a WebGPU draw command for a terrain tile.
   *
   * @param tile - The QuadtreeTile
   * @param surfaceTile - The GlobeSurfaceTile (tile.data)
   * @param tileProvider - The GlobeSurfaceTileProvider
   * @param frameState - Current frame state
   * @param uniformState - UniformState with RTE matrices
   * @returns Object with command properties to push to commandList, or null
   */
  createTileCommand(
    tile: any,
    surfaceTile: any,
    tileProvider: any,
    frameState: any,
    uniformState: any,
  ): any | null {
    if (!this._isInitialized || !this._device) return null;

    const device = this._device;
    const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
    if (!mesh) return null;

    // Get or create vertex/index buffers for this tile
    const tileKey = this._getTileKey(tile);
    const gpuResources = this._getOrCreateTileBuffers(tileKey, mesh);
    if (!gpuResources) return null;

    // Select pipeline based on normals
    const pipeline = gpuResources.hasNormals
      ? this._pipeline!
      : this._pipelineNoNormals!;

    // Create uniform buffers for this frame
    const cameraUB = this._createCameraUniformBuffer(
      device,
      uniformState,
      surfaceTile,
      tileProvider,
    );
    const tileUB = this._createTileUniformBuffer(
      device,
      surfaceTile,
      frameState,
    );

    // Create bind group 0 (uniforms)
    const bindGroup0 = device.createBindGroup({
      layout: this._bindGroupLayout0!,
      entries: [
        { binding: 0, resource: { buffer: cameraUB } },
        { binding: 1, resource: { buffer: tileUB } },
      ],
    });

    // Create bind group 1 (textures)
    const bindGroup1 = this._createTextureBindGroup(device, surfaceTile);

    // Return a command descriptor (to be wrapped in WebGPUDrawCommand by the caller)
    return {
      pipeline,
      bindGroups: [bindGroup0, bindGroup1],
      vertexBuffer: gpuResources.vertexBuffer,
      indexBuffer: gpuResources.indexBuffer,
      indexCount: gpuResources.indexCount,
      indexFormat: gpuResources.indexFormat,
      boundingVolume: tile.boundingVolume || surfaceTile.boundingSphere3D,
    };
  }

  // ─── Tile Key ───
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

    // Check cache
    const cached = this._tileBufferCache.get(tileKey);
    if (cached && cached.meshGeneration === generation) {
      return cached;
    }

    // Destroy old buffers if stale
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
    const stride = encoding.stride; // floats per vertex
    const hasNormals = encoding.hasVertexNormals === true;

    // Create vertex buffer
    const vertexBuffer = device.createBuffer({
      label: `Terrain VB ${tileKey}`,
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

    // Create index buffer
    const indexBuffer = device.createBuffer({
      label: `Terrain IB ${tileKey}`,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));

    const indexFormat: GPUIndexFormat =
      indices.BYTES_PER_ELEMENT === 4 ? "uint32" : "uint16";

    const resources: TileGPUResources = {
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
      indexFormat,
      stride,
      hasNormals,
      meshGeneration: generation,
    };

    this._tileBufferCache.set(tileKey, resources);
    return resources;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Uniform Buffer Creation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create camera uniform buffer with RTE matrices and tile center.
   */
  private _createCameraUniformBuffer(
    device: GPUDevice,
    uniformState: any,
    surfaceTile: any,
    tileProvider: any,
  ): GPUBuffer {
    const data = this._cameraUniformData;
    let offset = 0;

    // mvpRelativeToEye (mat4x4, 16 floats)
    const mvpRTE = m4Values(uniformState.modelViewProjectionRelativeToEye);
    for (let i = 0; i < 16; i++) data[offset++] = mvpRTE[i];

    // modifiedModelView (mat4x4, 16 floats)
    // Computed from the tile's RTC center + view matrix
    const mv = m4Values(
      this._computeModifiedModelView(uniformState, surfaceTile),
    );
    for (let i = 0; i < 16; i++) data[offset++] = mv[i];

    // encodedCameraHigh (vec3 + pad)
    const camHigh = uniformState.encodedCameraPositionMCHigh;
    data[offset++] = camHigh.x;
    data[offset++] = camHigh.y;
    data[offset++] = camHigh.z;
    data[offset++] = 0; // pad

    // encodedCameraLow (vec3 + pad)
    const camLow = uniformState.encodedCameraPositionMCLow;
    data[offset++] = camLow.x;
    data[offset++] = camLow.y;
    data[offset++] = camLow.z;
    data[offset++] = 0; // pad

    // center3D (vec3 + pad)
    const center = surfaceTile.center || { x: 0, y: 0, z: 0 };
    data[offset++] = center.x;
    data[offset++] = center.y;
    data[offset++] = center.z;
    data[offset++] = 0; // pad

    // sunDirectionEC (vec3) + enableLighting (f32)
    const sunDir = uniformState.sunDirectionEC;
    data[offset++] = sunDir.x;
    data[offset++] = sunDir.y;
    data[offset++] = sunDir.z;
    data[offset++] = tileProvider.enableLighting ? 1.0 : 0.0;

    const buffer = device.createBuffer({
      label: "Terrain camera UB",
      size: Math.max(CAMERA_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      gpuData(data),
      0,
      CAMERA_UNIFORM_FLOATS,
    );
    return buffer;
  }

  /**
   * Compute the modified model-view matrix for a terrain tile.
   * This is view matrix with the tile's RTC center baked into translation.
   */
  private _computeModifiedModelView(
    uniformState: any,
    surfaceTile: any,
  ): Float64Array {
    const view = uniformState.view;
    const center = surfaceTile.center;
    if (!center) return new Float64Array(view);

    // modifiedModelView = view * translate(center)
    // Since terrain vertex positions are relative to center,
    // we need: eye_pos = view * (vertex + center) = view*vertex + view*center
    // The modified matrix bakes view*center into the translation column
    const result = new Float64Array(16);
    for (let i = 0; i < 16; i++) result[i] = view[i];

    // Add view * center to translation column (column 3)
    result[12] += view[0] * center.x + view[4] * center.y + view[8] * center.z;
    result[13] += view[1] * center.x + view[5] * center.y + view[9] * center.z;
    result[14] += view[2] * center.x + view[6] * center.y + view[10] * center.z;

    return result;
  }

  /**
   * Create tile uniform buffer with imagery layer parameters and fog.
   */
  private _createTileUniformBuffer(
    device: GPUDevice,
    surfaceTile: any,
    frameState?: any,
  ): GPUBuffer {
    const data = this._tileUniformData;
    const u32 = this._tileUniformU32View;
    data.fill(0);

    const imageryCollection = surfaceTile.imagery;
    let layerCount = 0;

    if (imageryCollection) {
      for (
        let i = 0;
        i < imageryCollection.length && layerCount < MAX_IMAGERY_LAYERS;
        i++
      ) {
        const tileImagery = imageryCollection[i];
        if (!tileImagery || !tileImagery.readyImagery) continue;

        const imagery = tileImagery.readyImagery;
        if (!imagery.imageryLayer) continue;

        const baseOffset = layerCount * 12; // 12 floats per layer

        // translationAndScale (vec4)
        const ts = tileImagery.textureTranslationAndScale;
        if (ts) {
          data[baseOffset + 0] = ts.x;
          data[baseOffset + 1] = ts.y;
          data[baseOffset + 2] = ts.z;
          data[baseOffset + 3] = ts.w;
        } else {
          data[baseOffset + 0] = 0;
          data[baseOffset + 1] = 0;
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
          data[baseOffset + 4] = 0;
          data[baseOffset + 5] = 0;
          data[baseOffset + 6] = 1;
          data[baseOffset + 7] = 1;
        }

        // alpha, brightness, contrast, saturation
        const layer = imagery.imageryLayer;
        data[baseOffset + 8] = layer.alpha !== undefined ? layer.alpha : 1.0;
        data[baseOffset + 9] =
          layer.brightness !== undefined ? layer.brightness : 1.0;
        data[baseOffset + 10] =
          layer.contrast !== undefined ? layer.contrast : 1.0;
        data[baseOffset + 11] =
          layer.saturation !== undefined ? layer.saturation : 1.0;

        layerCount++;
      }
    }

    // layerCount at float offset 48 (u32)
    u32[48] = layerCount;

    // Fog parameters at offsets 49, 50, 51 — matches TileUniforms in GlobeTerrain.wgsl
    // fogDensity is computed by Fog.js and stored on frameState.fog
    if (frameState && frameState.fog) {
      const fog = frameState.fog;
      data[49] = fog.density !== undefined ? fog.density : 0.0;
      data[50] = fog.offset !== undefined ? fog.offset : 0.0;
      data[51] =
        fog.minimumBrightness !== undefined ? fog.minimumBrightness : 0.03;
    } else {
      data[49] = 0.0; // fogDensity (0 = fog disabled)
      data[50] = 0.0; // fogOffset
      data[51] = 0.03; // fogMinimumBrightness
    }

    const buffer = device.createBuffer({
      label: "Terrain tile UB",
      size: Math.max(TILE_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, gpuData(data), 0, TILE_UNIFORM_FLOATS);
    return buffer;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Texture Management
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create the texture bind group for a tile's imagery layers.
   */
  private _createTextureBindGroup(
    device: GPUDevice,
    surfaceTile: any,
  ): GPUBindGroup {
    const textureViews: GPUTextureView[] = [];
    const imageryCollection = surfaceTile.imagery;

    if (imageryCollection) {
      for (
        let i = 0;
        i < imageryCollection.length &&
        textureViews.length < MAX_IMAGERY_LAYERS;
        i++
      ) {
        const tileImagery = imageryCollection[i];
        if (!tileImagery || !tileImagery.readyImagery) continue;

        const imagery = tileImagery.readyImagery;
        const view = this._getOrCreateImageryTexture(imagery);
        if (view) {
          textureViews.push(view);
        }
      }
    }

    // Pad with placeholder textures to fill all 4 slots
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
   * Get or create a WebGPU texture for an imagery tile.
   * Tries to use the original image source for zero-copy upload.
   */
  private _getOrCreateImageryTexture(imagery: any): GPUTextureView | null {
    if (!imagery) return null;

    // Check for cached WebGPU texture
    const cacheKey =
      imagery.key || `${imagery.x}_${imagery.y}_${imagery.level}`;
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) return cached.view;

    // Try to get the source image for GPU upload
    const source = imagery.image || imagery.texture?._source;
    if (!source) return null;

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
        label: `Imagery ${cacheKey}`,
        size: [width, height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Upload image data
      device.queue.copyExternalImageToTexture(
        { source: source as any },
        { texture },
        [width, height],
      );

      const view = texture.createView();
      this._imageryTextureCache.set(cacheKey, {
        texture,
        view,
        sourceWidth: width,
        sourceHeight: height,
      });

      return view;
    } catch (e) {
      // Failed to create texture (e.g., cross-origin, corrupt image)
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cache Eviction
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Remove GPU resources for tiles that are no longer visible.
   * Call periodically (e.g., every N frames) with the set of active tile keys.
   */
  evictStaleResources(activeTileKeys: Set<string>): void {
    for (const [key, resources] of this._tileBufferCache) {
      if (!activeTileKeys.has(key)) {
        resources.vertexBuffer.destroy();
        resources.indexBuffer.destroy();
        this._tileBufferCache.delete(key);
      }
    }
  }

  /**
   * Remove a specific imagery texture from cache.
   */
  removeImageryTexture(cacheKey: string): void {
    const cached = this._imageryTextureCache.get(cacheKey);
    if (cached) {
      cached.texture.destroy();
      this._imageryTextureCache.delete(cacheKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pipeline Access (for external command creation)
  // ═══════════════════════════════════════════════════════════════════════

  get pipeline(): GPURenderPipeline | null {
    return this._pipeline;
  }

  get pipelineNoNormals(): GPURenderPipeline | null {
    return this._pipelineNoNormals;
  }

  get bindGroupLayout0(): GPUBindGroupLayout | null {
    return this._bindGroupLayout0;
  }

  get bindGroupLayout1(): GPUBindGroupLayout | null {
    return this._bindGroupLayout1;
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

    // Destroy tile buffers
    for (const [, resources] of this._tileBufferCache) {
      resources.vertexBuffer.destroy();
      resources.indexBuffer.destroy();
    }
    this._tileBufferCache.clear();

    // Destroy imagery textures
    for (const [, cached] of this._imageryTextureCache) {
      cached.texture.destroy();
    }
    this._imageryTextureCache.clear();

    // Destroy placeholder
    if (this._placeholderTexture) {
      this._placeholderTexture.destroy();
    }

    this._pipeline = null;
    this._pipelineNoNormals = null;
    this._shaderModule = null;
    this._sampler = null;
    this._bindGroupLayout0 = null;
    this._bindGroupLayout1 = null;
    this._pipelineLayout = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
