import buildModuleUrl from "../Core/buildModuleUrl.js";
import BoxGeometry from "../Core/BoxGeometry.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import VertexFormat from "../Core/VertexFormat.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import CubeMap from "../Renderer/CubeMap.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import loadCubeMap from "../Renderer/loadCubeMap.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArray from "../Renderer/VertexArray.js";
import SkyBoxFS from "../Shaders/SkyBoxFS.js";
import SkyBoxVS from "../Shaders/SkyBoxVS.js";
import BlendingState from "./BlendingState.js";
import SceneMode from "./SceneMode.js";

// =========================================================================
// WebGPU SkyBox Helpers
// =========================================================================

// WGSL shader source — loaded once via fetch, cached module-level
let _skyBoxWGSL = null;
let _skyBoxWGSLLoading = false;
let _skyBoxWGSLPromise = null;

/**
 * Fetches and caches the SkyBox WGSL shader source.
 * @returns {Promise<string>} The WGSL shader code
 * @private
 */
function loadSkyBoxWGSL() {
  if (_skyBoxWGSL !== null) {
    return Promise.resolve(_skyBoxWGSL);
  }
  if (_skyBoxWGSLPromise !== null) {
    return _skyBoxWGSLPromise;
  }
  _skyBoxWGSLLoading = true;
  const url = buildModuleUrl("Source/Shaders/WebGPU/SkyBox.wgsl");
  _skyBoxWGSLPromise = fetch(url)
    .then(function (response) {
      return response.text();
    })
    .then(function (code) {
      _skyBoxWGSL = code;
      _skyBoxWGSLLoading = false;
      return code;
    })
    .catch(function (err) {
      _skyBoxWGSLLoading = false;
      console.warn("[SkyBox] Failed to load SkyBox.wgsl:", err);
      return null;
    });
  return _skyBoxWGSLPromise;
}

/**
 * Loads 6 cubemap face images from URLs and writes them to a WebGPU cubemap texture.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {object} sources - Object with positiveX/negativeX/positiveY/negativeY/positiveZ/negativeZ URLs
 * @returns {Promise<{texture: GPUTexture, view: GPUTextureView}>}
 * @private
 */
function loadWebGPUCubeMap(device, sources) {
  const faceNames = [
    "positiveX",
    "negativeX",
    "positiveY",
    "negativeY",
    "positiveZ",
    "negativeZ",
  ];

  const imagePromises = faceNames.map(function (face) {
    const src = sources[face];
    if (typeof src === "string") {
      return fetch(src)
        .then(function (response) {
          return response.blob();
        })
        .then(function (blob) {
          return createImageBitmap(blob);
        });
    }
    // src is already an Image/ImageBitmap
    if (src instanceof ImageBitmap) {
      return Promise.resolve(src);
    }
    return createImageBitmap(src);
  });

  return Promise.all(imagePromises).then(function (bitmaps) {
    const size = bitmaps[0].width;

    const texture = device.createTexture({
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format: "rgba8unorm",
      dimension: "2d",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: "SkyBox CubeMap",
    });

    // Copy each face image to the corresponding array layer
    for (let i = 0; i < 6; i++) {
      device.queue.copyExternalImageToTexture(
        { source: bitmaps[i] },
        { texture: texture, origin: { x: 0, y: 0, z: i } },
        { width: size, height: size },
      );
    }

    const view = texture.createView({
      dimension: "cube",
      format: "rgba8unorm",
      label: "SkyBox CubeMap View",
    });

    return { texture: texture, view: view };
  });
}

// Scratch matrices for per-frame uniform updates
const scratchRotation3x3 = new Matrix3();
const scratchRotation4x4 = new Matrix4();
const scratchUniformData = new Float32Array(36); // 144 bytes / 4 = 36 floats

/**
 * Creates a 4x4 matrix from a 3x3 rotation matrix (upper-left 3x3, rest = identity).
 * @private
 */
function matrix4FromMatrix3(mat3, result) {
  result[0] = mat3[0];
  result[1] = mat3[1];
  result[2] = mat3[2];
  result[3] = 0.0;
  result[4] = mat3[3];
  result[5] = mat3[4];
  result[6] = mat3[5];
  result[7] = 0.0;
  result[8] = mat3[6];
  result[9] = mat3[7];
  result[10] = mat3[8];
  result[11] = 0.0;
  result[12] = 0.0;
  result[13] = 0.0;
  result[14] = 0.0;
  result[15] = 1.0;
  return result;
}

// =========================================================================
// SkyBox Constructor
// =========================================================================

/**
 * A sky box around the scene to draw stars.  The sky box is defined using the True Equator Mean Equinox (TEME) axes.
 * <p>
 * This is only supported in 3D.  The sky box is faded out when morphing to 2D or Columbus view.  The size of
 * the sky box must not exceed {@link Scene#maximumCubeMapSize}.
 * </p>
 *
 * @alias SkyBox
 * @constructor
 *
 * @param {object} options Object with the following properties:
 * @param {object} [options.sources] The source URL or <code>Image</code> object for each of the six cube map faces.  See the example below.
 * @param {boolean} [options.show=true] Determines if this primitive will be shown.
 *
 *
 * @example
 * scene.skyBox = new Cesium.SkyBox({
 *   sources : {
 *     positiveX : 'skybox_px.png',
 *     negativeX : 'skybox_nx.png',
 *     positiveY : 'skybox_py.png',
 *     negativeY : 'skybox_ny.png',
 *     positiveZ : 'skybox_pz.png',
 *     negativeZ : 'skybox_nz.png'
 *   }
 * });
 *
 * @see Scene#skyBox
 * @see Transforms.computeTemeToPseudoFixedMatrix
 */
function SkyBox(options) {
  /**
   * The sources used to create the cube map faces: an object
   * with <code>positiveX</code>, <code>negativeX</code>, <code>positiveY</code>,
   * <code>negativeY</code>, <code>positiveZ</code>, and <code>negativeZ</code> properties.
   * These can be either URLs or <code>Image</code> objects.
   *
   * @type {object}
   * @default undefined
   */
  this.sources = options.sources;
  this._sources = undefined;

  /**
   * Determines if the sky box will be shown.
   *
   * @type {boolean}
   * @default true
   */
  this.show = options.show ?? true;

  this._command = new DrawCommand({
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    owner: this,
  });
  this._cubeMap = undefined;

  this._attributeLocations = undefined;
  this._useHdr = undefined;
  this._hasError = false;
  this._error = undefined;

  // ── WebGPU-specific state ──
  this._webgpuCommand = undefined;
  this._webgpuCubeMapTexture = undefined;
  this._webgpuCubeMapView = undefined;
  this._webgpuPipeline = undefined;
  this._webgpuUniformBuffer = undefined;
  this._webgpuVertexBuffer = undefined;
  this._webgpuIndexBuffer = undefined;
  this._webgpuUniformBindGroup = undefined;
  this._webgpuTextureBindGroup = undefined;
  this._webgpuSampler = undefined;
  this._webgpuShaderModule = undefined;
  this._webgpuLoadingCubeMap = false;
  this._webgpuInitialized = false;
  this._webgpuIndexCount = 0;
}

// =========================================================================
// WebGPU Update Path
// =========================================================================

/**
 * Creates the WebGPU pipeline, buffers, and bind groups for skybox rendering.
 * Called once when the cubemap and shader are ready.
 * @private
 */
SkyBox.prototype._initWebGPUResources = function (context) {
  const device = context.device;
  if (!device || !_skyBoxWGSL) {
    return false;
  }

  // ── Shader module ──
  this._webgpuShaderModule = device.createShaderModule({
    code: _skyBoxWGSL,
    label: "SkyBox Shader",
  });

  // ── Vertex data from box geometry (position only) ──
  const geometry = BoxGeometry.createGeometry(
    BoxGeometry.fromDimensions({
      dimensions: new Cartesian3(2.0, 2.0, 2.0),
      vertexFormat: VertexFormat.POSITION_ONLY,
    }),
  );

  const posValues = geometry.attributes.position.values;
  this._webgpuVertexBuffer = device.createBuffer({
    size: posValues.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    label: "SkyBox VB",
  });
  device.queue.writeBuffer(this._webgpuVertexBuffer, 0, posValues);

  // ── Index buffer ──
  const indices = geometry.indices;
  this._webgpuIndexCount = indices.length;
  const indexData =
    indices instanceof Uint16Array ? indices : new Uint16Array(indices);
  this._webgpuIndexBuffer = device.createBuffer({
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    label: "SkyBox IB",
  });
  device.queue.writeBuffer(this._webgpuIndexBuffer, 0, indexData);

  // ── Uniform buffer (256 bytes, aligned) ──
  this._webgpuUniformBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "SkyBox UB",
  });

  // ── Sampler ──
  this._webgpuSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
    label: "SkyBox Sampler",
  });

  // ── Bind group layouts ──
  const uniformBGL = device.createBindGroupLayout({
    label: "SkyBox Uniform BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const textureBGL = device.createBindGroupLayout({
    label: "SkyBox Texture BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "cube" },
      },
    ],
  });

  // ── Uniform bind group ──
  this._webgpuUniformBindGroup = device.createBindGroup({
    layout: uniformBGL,
    entries: [{ binding: 0, resource: { buffer: this._webgpuUniformBuffer } }],
    label: "SkyBox Uniform BG",
  });

  // ── Texture bind group ──
  this._webgpuTextureBindGroup = device.createBindGroup({
    layout: textureBGL,
    entries: [
      { binding: 0, resource: this._webgpuSampler },
      { binding: 1, resource: this._webgpuCubeMapView },
    ],
    label: "SkyBox Texture BG",
  });

  // ── Render pipeline ──
  const canvasFormat =
    context.presentationFormat || navigator.gpu.getPreferredCanvasFormat();

  this._webgpuPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [uniformBGL, textureBGL],
    }),
    vertex: {
      module: this._webgpuShaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 12, // 3 floats × 4 bytes
          stepMode: "vertex",
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x3",
            },
          ],
        },
      ],
    },
    fragment: {
      module: this._webgpuShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: canvasFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    label: "SkyBox Pipeline",
  });

  this._webgpuInitialized = true;
  return true;
};

/**
 * Updates the WebGPU uniform buffer with current frame camera data.
 * @private
 */
SkyBox.prototype._updateWebGPUUniforms = function (frameState) {
  const context = frameState.context;
  const device = context.device;
  const us = context.uniformState;

  if (!device || !this._webgpuUniformBuffer) {
    return;
  }

  const ud = scratchUniformData;

  // Pack projection matrix (16 floats, offset 0)
  Matrix4.pack(us.projection, ud, 0);

  // Compute rotationMatrix = viewRotation * temeToPseudoFixed (3x3)
  const viewRot = us.viewRotation;
  const teme = us.temeToPseudoFixedMatrix;
  Matrix3.multiply(viewRot, teme, scratchRotation3x3);

  // Convert 3x3 to 4x4 for the uniform buffer
  matrix4FromMatrix3(scratchRotation3x3, scratchRotation4x4);

  // Pack rotation matrix (16 floats, offset 16)
  Matrix4.pack(scratchRotation4x4, ud, 16);

  // Pack params (4 floats, offset 32): far, morphTime, 0, 0
  ud[32] = us.entireFrustum.y; // far plane
  ud[33] = frameState.morphTime !== undefined ? frameState.morphTime : 1.0;
  ud[34] = 0.0;
  ud[35] = 0.0;

  // Write to GPU (36 floats = 144 bytes)
  device.queue.writeBuffer(this._webgpuUniformBuffer, 0, ud.buffer, 0, 144);
};

// =========================================================================
// SkyBox.update — Main Rendering Method
// =========================================================================

/**
 * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
 * get the draw commands needed to render this primitive.
 * <p>
 * Do not call this function directly.  This is documented just to
 * list the exceptions that may be propagated when the scene is rendered:
 * </p>
 *
 * @exception {DeveloperError} this.sources is required and must have positiveX, negativeX, positiveY, negativeY, positiveZ, and negativeZ properties.
 * @exception {DeveloperError} this.sources properties must all be the same type.
 */
SkyBox.prototype.update = function (frameState, useHdr) {
  const that = this;
  const { mode, passes, context } = frameState;

  if (!this.show) {
    return undefined;
  }

  if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
    return undefined;
  }

  // The sky box is only rendered during the render pass; it is not pickable, it doesn't cast shadows, etc.
  if (!passes.render) {
    return undefined;
  }

  // Throw any errors that had previously occurred asynchronously so they aren't
  // ignored when running.  See https://github.com/CesiumGS/cesium/pull/12307
  if (this._hasError) {
    const error = this._error;
    this._hasError = false;
    this._error = undefined;
    throw error;
  }

  // ── WebGPU Path ──
  if (context.isWebGPU) {
    return this._updateWebGPU(frameState, useHdr);
  }

  // ── WebGL Path (existing, untouched) ──
  if (this._sources !== this.sources) {
    this._sources = this.sources;
    const sources = this.sources;

    //>>includeStart('debug', pragmas.debug);
    Check.defined("this.sources", sources);
    if (
      Object.values(CubeMap.FaceName).some(
        (faceName) => !defined(sources[faceName]),
      )
    ) {
      throw new DeveloperError(
        "this.sources must have positiveX, negativeX, positiveY, negativeY, positiveZ, and negativeZ properties.",
      );
    }

    const sourceType = typeof sources.positiveX;
    if (
      Object.values(CubeMap.FaceName).some(
        (faceName) => typeof sources[faceName] !== sourceType,
      )
    ) {
      throw new DeveloperError(
        "this.sources properties must all be the same type.",
      );
    }
    //>>includeEnd('debug');

    if (typeof sources.positiveX === "string") {
      // Given urls for cube-map images.  Load them.
      loadCubeMap(context, this._sources)
        .then(function (cubeMap) {
          that._cubeMap = that._cubeMap && that._cubeMap.destroy();
          that._cubeMap = cubeMap;
        })
        .catch((error) => {
          // Defer throwing the error until the next call to update to prevent
          // test from failing in `afterAll` if this is rejected after the test
          // using the Skybox ends.  See https://github.com/CesiumGS/cesium/pull/12307
          this._hasError = true;
          this._error = error;
        });
    } else {
      this._cubeMap = this._cubeMap && this._cubeMap.destroy();
      this._cubeMap = new CubeMap({
        context: context,
        source: sources,
      });
    }
  }

  const command = this._command;

  if (!defined(command.vertexArray)) {
    command.uniformMap = {
      u_cubeMap: function () {
        return that._cubeMap;
      },
    };

    const geometry = BoxGeometry.createGeometry(
      BoxGeometry.fromDimensions({
        dimensions: new Cartesian3(2.0, 2.0, 2.0),
        vertexFormat: VertexFormat.POSITION_ONLY,
      }),
    );
    const attributeLocations = (this._attributeLocations =
      GeometryPipeline.createAttributeLocations(geometry));

    command.vertexArray = VertexArray.fromGeometry({
      context: context,
      geometry: geometry,
      attributeLocations: attributeLocations,
      bufferUsage: BufferUsage.STATIC_DRAW,
    });

    command.renderState = RenderState.fromCache({
      blending: BlendingState.ALPHA_BLEND,
    });
  }

  if (!defined(command.shaderProgram) || this._useHdr !== useHdr) {
    const fs = new ShaderSource({
      defines: [useHdr ? "HDR" : ""],
      sources: [SkyBoxFS],
    });
    command.shaderProgram = ShaderProgram.fromCache({
      context: context,
      vertexShaderSource: SkyBoxVS,
      fragmentShaderSource: fs,
      attributeLocations: this._attributeLocations,
    });
    this._useHdr = useHdr;
  }

  if (!defined(this._cubeMap)) {
    return undefined;
  }

  return command;
};

/**
 * WebGPU update path — called from update() when context.isWebGPU is true.
 * @private
 */
SkyBox.prototype._updateWebGPU = function (frameState) {
  const context = frameState.context;
  const device = context.device;

  if (!device) {
    return undefined;
  }

  // ── Step 1: Start loading WGSL shader (async, once) ──
  if (_skyBoxWGSL === null && !_skyBoxWGSLLoading) {
    loadSkyBoxWGSL();
  }

  // ── Step 2: Load cubemap texture (async, when sources change) ──
  if (this._sources !== this.sources && !this._webgpuLoadingCubeMap) {
    this._sources = this.sources;
    const sources = this.sources;

    if (!defined(sources)) {
      return undefined;
    }

    this._webgpuLoadingCubeMap = true;
    this._webgpuInitialized = false;

    // Destroy old cubemap
    if (this._webgpuCubeMapTexture) {
      this._webgpuCubeMapTexture.destroy();
      this._webgpuCubeMapTexture = undefined;
      this._webgpuCubeMapView = undefined;
    }

    const that = this;
    loadWebGPUCubeMap(device, sources)
      .then(function (result) {
        that._webgpuCubeMapTexture = result.texture;
        that._webgpuCubeMapView = result.view;
        that._webgpuLoadingCubeMap = false;
      })
      .catch(function (error) {
        that._webgpuLoadingCubeMap = false;
        that._hasError = true;
        that._error = error;
      });
  }

  // ── Step 3: Wait for both shader and cubemap to be ready ──
  if (!this._webgpuCubeMapView || _skyBoxWGSL === null) {
    return undefined;
  }

  // ── Step 4: Initialize GPU resources (once) ──
  if (!this._webgpuInitialized) {
    if (!this._initWebGPUResources(context)) {
      return undefined;
    }
  }

  // ── Step 5: Create or reuse the WebGPU draw command ──
  if (!this._webgpuCommand) {
    // Import WebGPUDrawCommand dynamically to avoid circular deps at module level
    // We create a lightweight command object that matches the interface
    this._webgpuCommand = {
      isWebGPUDrawCommand: true,
      enabled: true,
      pipeline: this._webgpuPipeline,
      bindGroups: [this._webgpuUniformBindGroup, this._webgpuTextureBindGroup],
      vertexBuffers: [{ buffer: this._webgpuVertexBuffer }],
      indexBuffer: { buffer: this._webgpuIndexBuffer },
      indexFormat: "uint16",
      indexCount: this._webgpuIndexCount,
      instanceCount: 1,
      firstIndex: 0,
      firstInstance: 0,
      pass: 0, // Pass.ENVIRONMENT
      owner: this,
      cull: false,
      execute: function (passEncoder) {
        if (!this.enabled) {
          return;
        }
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroups[0]);
        passEncoder.setBindGroup(1, this.bindGroups[1]);
        passEncoder.setVertexBuffer(0, this.vertexBuffers[0].buffer);
        passEncoder.setIndexBuffer(this.indexBuffer.buffer, this.indexFormat);
        passEncoder.drawIndexed(this.indexCount, 1, 0, 0, 0);
      },
    };
  }

  // ── Step 6: Update uniforms each frame ──
  this._updateWebGPUUniforms(frameState);

  return this._webgpuCommand;
};

// =========================================================================
// Lifecycle Methods
// =========================================================================

/**
 * Returns true if this object was destroyed; otherwise, false.
 * <br /><br />
 * If this object was destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
 *
 * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
 *
 * @see SkyBox#destroy
 */
SkyBox.prototype.isDestroyed = function () {
  return false;
};

/**
 * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
 * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
 * <br /><br />
 * Once an object is destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
 * assign the return value (<code>undefined</code>) to the object as done in the example.
 *
 * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
 *
 *
 * @example
 * skyBox = skyBox && skyBox.destroy();
 *
 * @see SkyBox#isDestroyed
 */
SkyBox.prototype.destroy = function () {
  // WebGL cleanup
  const command = this._command;
  command.vertexArray = command.vertexArray && command.vertexArray.destroy();
  command.shaderProgram =
    command.shaderProgram && command.shaderProgram.destroy();
  this._cubeMap = this._cubeMap && this._cubeMap.destroy();

  // WebGPU cleanup
  if (this._webgpuVertexBuffer) {
    this._webgpuVertexBuffer.destroy();
    this._webgpuVertexBuffer = undefined;
  }
  if (this._webgpuIndexBuffer) {
    this._webgpuIndexBuffer.destroy();
    this._webgpuIndexBuffer = undefined;
  }
  if (this._webgpuUniformBuffer) {
    this._webgpuUniformBuffer.destroy();
    this._webgpuUniformBuffer = undefined;
  }
  if (this._webgpuCubeMapTexture) {
    this._webgpuCubeMapTexture.destroy();
    this._webgpuCubeMapTexture = undefined;
  }
  this._webgpuCubeMapView = undefined;
  this._webgpuPipeline = undefined;
  this._webgpuShaderModule = undefined;
  this._webgpuUniformBindGroup = undefined;
  this._webgpuTextureBindGroup = undefined;
  this._webgpuSampler = undefined;
  this._webgpuCommand = undefined;
  this._webgpuInitialized = false;

  return destroyObject(this);
};

// =========================================================================
// Static Factory
// =========================================================================

function getDefaultSkyBoxUrl(suffix) {
  return buildModuleUrl(`Assets/Textures/SkyBox/tycho2t3_80_${suffix}.jpg`);
}

/**
 * Creates a skybox instance with the default starmap for the Earth.
 * @return {SkyBox} The default skybox for the Earth
 *
 * @example
 * viewer.scene.skyBox = Cesium.SkyBox.createEarthSkyBox();
 */
SkyBox.createEarthSkyBox = function () {
  return new SkyBox({
    sources: {
      positiveX: getDefaultSkyBoxUrl("px"),
      negativeX: getDefaultSkyBoxUrl("mx"),
      positiveY: getDefaultSkyBoxUrl("py"),
      negativeY: getDefaultSkyBoxUrl("my"),
      positiveZ: getDefaultSkyBoxUrl("pz"),
      negativeZ: getDefaultSkyBoxUrl("mz"),
    },
  });
};

export default SkyBox;
