import GraphicsContext from "./GraphicsContext.js";
import FeatureRendererKey from "./FeatureRendererKey.js";
import RendererType from "./RendererType.js";
import Buffer from "./Buffer.js";
import Sync from "./Sync.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import createGuid from "../Core/createGuid.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Geometry from "../Core/Geometry.js";
import GeometryAttribute from "../Core/GeometryAttribute.js";
import Matrix4 from "../Core/Matrix4.js";
import PixelFormat from "../Core/PixelFormat.js";
import PrimitiveType from "../Core/PrimitiveType.js";
import RuntimeError from "../Core/RuntimeError.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import ViewportQuadVS from "../Shaders/ViewportQuadVS.js";
import BufferUsage from "./BufferUsage.js";
import ClearCommand from "./ClearCommand.js";
import CubeMap from "./CubeMap.js";
import DrawCommand from "./DrawCommand.js";
import GraphicsCapabilities from "./GraphicsCapabilities.js";
import PassState from "./PassState.js";
import PixelDatatype from "./PixelDatatype.js";
import RenderState from "./RenderState.js";
import ShaderCache from "./ShaderCache.js";
import ShaderProgram from "./ShaderProgram.js";
import Texture from "./Texture.js";
import TextureCache from "./TextureCache.js";
import UniformState from "./UniformState.js";
import VertexArray from "./VertexArray.js";

/**
 * @private
 * @param {HTMLCanvasElement} canvas The canvas element to which the context will be associated
 * @param {WebGLOptions} webglOptions WebGL options to be passed on to HTMLCanvasElement.getContext()
 * @param {boolean} requestWebgl1 Whether to request a WebGLRenderingContext or a WebGL2RenderingContext.
 * @returns {WebGLRenderingContext|WebGL2RenderingContext}
 */
function getWebGLContext(canvas, webglOptions, requestWebgl1) {
  if (typeof WebGLRenderingContext === "undefined") {
    throw new RuntimeError(
      "The browser does not support WebGL.  Visit http://get.webgl.org.",
    );
  }

  // Ensure that WebGL 2 is supported when it is requested. Otherwise, fall back to WebGL 1.
  const webgl2Supported = typeof WebGL2RenderingContext !== "undefined";
  if (!requestWebgl1 && !webgl2Supported) {
    requestWebgl1 = true;
  }

  const contextType = requestWebgl1 ? "webgl" : "webgl2";
  const glContext = canvas.getContext(contextType, webglOptions);

  if (!defined(glContext)) {
    throw new RuntimeError(
      "The browser supports WebGL, but initialization failed.",
    );
  }

  return glContext;
}

function errorToString(gl, error) {
  let message = "WebGL Error:  ";
  switch (error) {
    case gl.INVALID_ENUM:
      message += "INVALID_ENUM";
      break;
    case gl.INVALID_VALUE:
      message += "INVALID_VALUE";
      break;
    case gl.INVALID_OPERATION:
      message += "INVALID_OPERATION";
      break;
    case gl.OUT_OF_MEMORY:
      message += "OUT_OF_MEMORY";
      break;
    case gl.CONTEXT_LOST_WEBGL:
      message += "CONTEXT_LOST_WEBGL lost";
      break;
    default:
      message += `Unknown (${error})`;
  }

  return message;
}

function createErrorMessage(gl, glFunc, glFuncArguments, error) {
  let message = `${errorToString(gl, error)}: ${glFunc.name}(`;

  for (let i = 0; i < glFuncArguments.length; ++i) {
    if (i !== 0) {
      message += ", ";
    }
    message += glFuncArguments[i];
  }
  message += ");";

  return message;
}

function throwOnError(gl, glFunc, glFuncArguments) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new RuntimeError(
      createErrorMessage(gl, glFunc, glFuncArguments, error),
    );
  }
}

function makeGetterSetter(gl, propertyName, logFunction) {
  return {
    get: function () {
      const value = gl[propertyName];
      logFunction(gl, `get: ${propertyName}`, value);
      return gl[propertyName];
    },
    set: function (value) {
      gl[propertyName] = value;
      logFunction(gl, `set: ${propertyName}`, value);
    },
  };
}

function wrapGL(gl, logFunction) {
  if (!defined(logFunction)) {
    return gl;
  }

  function wrapFunction(property) {
    return function () {
      const result = property.apply(gl, arguments);
      logFunction(gl, property, arguments);
      return result;
    };
  }

  const glWrapper = {};

  // JavaScript linters normally demand that a for..in loop must directly contain an if,
  // but in our loop below, we actually intend to iterate all properties, including
  // those in the prototype.
  /*eslint-disable guard-for-in*/
  for (const propertyName in gl) {
    const property = gl[propertyName];

    // wrap any functions we encounter, otherwise just copy the property to the wrapper.
    if (property instanceof Function) {
      glWrapper[propertyName] = wrapFunction(property);
    } else {
      Object.defineProperty(
        glWrapper,
        propertyName,
        makeGetterSetter(gl, propertyName, logFunction),
      );
    }
  }
  /*eslint-enable guard-for-in*/

  return glWrapper;
}

function getExtension(gl, names) {
  const length = names.length;
  for (let i = 0; i < length; ++i) {
    const extension = gl.getExtension(names[i]);
    if (extension) {
      return extension;
    }
  }

  return undefined;
}

const defaultFramebufferMarker = {};

/**
 * Validates a framebuffer.
 * Available in debug builds only.
 * @private
 */
function validateFramebuffer(context) {
  //>>includeStart('debug', pragmas.debug);
  if (context.validateFramebuffer) {
    const gl = context._gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      let message;

      switch (status) {
        case gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT:
          message =
            "Framebuffer is not complete.  Incomplete attachment: at least one attachment point with a renderbuffer or texture attached has its attached object no longer in existence or has an attached image with a width or height of zero, or the color attachment point has a non-color-renderable image attached, or the depth attachment point has a non-depth-renderable image attached, or the stencil attachment point has a non-stencil-renderable image attached.  Color-renderable formats include GL_RGBA4, GL_RGB5_A1, and GL_RGB565. GL_DEPTH_COMPONENT16 is the only depth-renderable format. GL_STENCIL_INDEX8 is the only stencil-renderable format.";
          break;
        case gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS:
          message =
            "Framebuffer is not complete.  Incomplete dimensions: not all attached images have the same width and height.";
          break;
        case gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:
          message =
            "Framebuffer is not complete.  Missing attachment: no images are attached to the framebuffer.";
          break;
        case gl.FRAMEBUFFER_UNSUPPORTED:
          message =
            "Framebuffer is not complete.  Unsupported: the combination of internal formats of the attached images violates an implementation-dependent set of restrictions.";
          break;
      }

      throw new DeveloperError(message);
    }
  }
  //>>includeEnd('debug');
}

function applyRenderState(context, renderState, passState, clear) {
  RenderState.validateForContext(renderState, context.limits);
  const previousRenderState = context._currentRenderState;
  const previousPassState = context._currentPassState;
  context._currentRenderState = renderState;
  context._currentPassState = passState;
  RenderState.partialApply(
    context._gl,
    previousRenderState,
    renderState,
    previousPassState,
    passState,
    clear,
  );
}

let scratchBackBufferArray;
// this check must use typeof, not defined, because defined doesn't work with undeclared variables.
if (typeof WebGLRenderingContext !== "undefined") {
  scratchBackBufferArray = [WebGLConstants.BACK];
}

function bindFramebuffer(context, framebuffer) {
  if (framebuffer !== context._currentFramebuffer) {
    context._currentFramebuffer = framebuffer;
    let buffers = scratchBackBufferArray;

    if (defined(framebuffer)) {
      framebuffer._bind();
      validateFramebuffer(context);

      // TODO: Need a way for a command to give what draw buffers are active.
      buffers = framebuffer._getActiveColorAttachments();
    } else {
      const gl = context._gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    if (context.drawBuffers) {
      context.glDrawBuffers(buffers);
    }
  }
}

const defaultClearCommand = new ClearCommand();

function beginDraw(
  context,
  framebuffer,
  passState,
  shaderProgram,
  renderState,
) {
  //>>includeStart('debug', pragmas.debug);
  if (defined(framebuffer) && renderState.depthTest) {
    if (renderState.depthTest.enabled && !framebuffer.hasDepthAttachment) {
      throw new DeveloperError(
        "The depth test can not be enabled (drawCommand.renderState.depthTest.enabled) because the framebuffer (drawCommand.framebuffer) does not have a depth or depth-stencil renderbuffer.",
      );
    }
  }
  //>>includeEnd('debug');

  bindFramebuffer(context, framebuffer);
  applyRenderState(context, renderState, passState, false);
  shaderProgram._bind();

  context._maxFrameTextureUnitIndex = Math.max(
    context._maxFrameTextureUnitIndex,
    shaderProgram.maximumTextureUnitIndex,
  );
}

function continueDraw(context, drawCommand, shaderProgram, uniformMap) {
  const primitiveType = drawCommand._primitiveType;
  const va = drawCommand._vertexArray;
  let offset = drawCommand._offset;
  let count = drawCommand._count;
  const instanceCount = drawCommand.instanceCount;

  //>>includeStart('debug', pragmas.debug);
  if (!PrimitiveType.validate(primitiveType)) {
    throw new DeveloperError(
      "drawCommand.primitiveType is required and must be valid.",
    );
  }

  Check.defined("drawCommand.vertexArray", va);
  Check.typeOf.number.greaterThanOrEquals("drawCommand.offset", offset, 0);
  if (defined(count)) {
    Check.typeOf.number.greaterThanOrEquals("drawCommand.count", count, 0);
  }
  Check.typeOf.number.greaterThanOrEquals(
    "drawCommand.instanceCount",
    instanceCount,
    0,
  );
  if (instanceCount > 0 && !context.instancedArrays) {
    throw new DeveloperError("Instanced arrays extension is not supported");
  }
  //>>includeEnd('debug');

  context._us.model = drawCommand._modelMatrix ?? Matrix4.IDENTITY;
  shaderProgram._setUniforms(
    uniformMap,
    context._us,
    context.validateShaderProgram,
  );

  va._bind();
  const indexBuffer = va.indexBuffer;

  if (defined(indexBuffer)) {
    offset = offset * indexBuffer.bytesPerIndex; // offset in vertices to offset in bytes
    if (defined(count)) {
      count = Math.min(count, indexBuffer.numberOfIndices);
    } else {
      count = indexBuffer.numberOfIndices;
    }
    if (instanceCount === 0) {
      context._gl.drawElements(
        primitiveType,
        count,
        indexBuffer.indexDatatype,
        offset,
      );
    } else {
      context.glDrawElementsInstanced(
        primitiveType,
        count,
        indexBuffer.indexDatatype,
        offset,
        instanceCount,
      );
    }
  } else {
    if (defined(count)) {
      count = Math.min(count, va.numberOfVertices);
    } else {
      count = va.numberOfVertices;
    }

    if (instanceCount === 0) {
      context._gl.drawArrays(primitiveType, offset, count);
    } else {
      context.glDrawArraysInstanced(
        primitiveType,
        offset,
        count,
        instanceCount,
      );
    }
  }

  va._unBind();
}

const viewportQuadAttributeLocations = {
  position: 0,
  textureCoordinates: 1,
};

// PickId class moved to shared Renderer/PickId.js
// Pick ID management (createPickId, getObjectByPickColor) is now in
// GraphicsContext base class — both WebGL and WebGPU inherit it.

/**
 * @private
 *
 * @param {HTMLCanvasElement} canvas The canvas element to which the context will be associated
 * @param {ContextOptions} [options] Options to control WebGL settings for the context
 */
class Context extends GraphicsContext {
  constructor(canvas, options) {
    super(); // Initialize GraphicsContext base (registry, logging, feature renderers)

    //>>includeStart('debug', pragmas.debug);
    Check.defined("canvas", canvas);
    //>>includeEnd('debug');

    const {
      getWebGLStub,
      requestWebgl1,
      webgl: webglOptions = {},
      allowTextureFilterAnisotropic = true,
    } = options ?? {};

    // Override select WebGL defaults
    webglOptions.alpha = webglOptions.alpha ?? false; // WebGL default is true
    webglOptions.stencil = webglOptions.stencil ?? true; // WebGL default is false
    webglOptions.powerPreference =
      webglOptions.powerPreference ?? "high-performance"; // WebGL default is "default"

    const glContext = defined(getWebGLStub)
      ? getWebGLStub(canvas, webglOptions)
      : getWebGLContext(canvas, webglOptions, requestWebgl1);

    // Get context type. instanceof will throw if WebGL2 is not supported
    const webgl2Supported = typeof WebGL2RenderingContext !== "undefined";
    const webgl2 =
      webgl2Supported && glContext instanceof WebGL2RenderingContext;

    this._canvas = canvas;
    this._originalGLContext = glContext;
    this._gl = glContext;
    this._webgl2 = webgl2;
    this._id = createGuid();

    // Validation and logging disabled by default for speed.
    this.validateFramebuffer = false;
    this.validateShaderProgram = false;
    this.logShaderCompilation = false;

    this._throwOnWebGLError = false;

    this._shaderCache = new ShaderCache(this);
    this._textureCache = new TextureCache();

    const gl = glContext;

    this._stencilBits = gl.getParameter(gl.STENCIL_BITS);

    const capabilityOptions = {
      maximumCombinedTextureImageUnits: gl.getParameter(
        gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS,
      ),
      maximumCubeMapSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
      maximumFragmentUniformVectors: gl.getParameter(
        gl.MAX_FRAGMENT_UNIFORM_VECTORS,
      ),
      maximumTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      maximumRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maximumTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maximum3DTextureSize: webgl2
        ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)
        : 0,
      maximumArrayTextureLayers: webgl2
        ? gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)
        : 0,
      maximumVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
      maximumVertexAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maximumVertexTextureImageUnits: gl.getParameter(
        gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS,
      ),
      maximumVertexUniformVectors: gl.getParameter(
        gl.MAX_VERTEX_UNIFORM_VECTORS,
      ),
      maximumSamples: webgl2 ? gl.getParameter(gl.MAX_SAMPLES) : 0,
    };

    const aliasedLineWidthRange = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE); // must include 1
    capabilityOptions.minimumAliasedLineWidth = aliasedLineWidthRange[0];
    capabilityOptions.maximumAliasedLineWidth = aliasedLineWidthRange[1];

    const aliasedPointSizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); // must include 1
    capabilityOptions.minimumAliasedPointSize = aliasedPointSizeRange[0];
    capabilityOptions.maximumAliasedPointSize = aliasedPointSizeRange[1];

    const maximumViewportDimensions = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    capabilityOptions.maximumViewportWidth = maximumViewportDimensions[0];
    capabilityOptions.maximumViewportHeight = maximumViewportDimensions[1];

    const highpFloat = gl.getShaderPrecisionFormat(
      gl.FRAGMENT_SHADER,
      gl.HIGH_FLOAT,
    );
    capabilityOptions.highpFloatSupported = highpFloat.precision !== 0;
    const highpInt = gl.getShaderPrecisionFormat(
      gl.FRAGMENT_SHADER,
      gl.HIGH_INT,
    );
    capabilityOptions.highpIntSupported = highpInt.rangeMax !== 0;

    this._antialias = gl.getContextAttributes().antialias;

    // Query and initialize extensions
    this._standardDerivatives = !!getExtension(gl, [
      "OES_standard_derivatives",
    ]);
    this._blendMinmax = !!getExtension(gl, ["EXT_blend_minmax"]);
    this._elementIndexUint = !!getExtension(gl, ["OES_element_index_uint"]);
    this._depthTexture = !!getExtension(gl, [
      "WEBGL_depth_texture",
      "WEBKIT_WEBGL_depth_texture",
    ]);
    this._fragDepth = !!getExtension(gl, ["EXT_frag_depth"]);
    this._debugShaders = getExtension(gl, ["WEBGL_debug_shaders"]);

    this._textureFloat = !!getExtension(gl, ["OES_texture_float"]);
    this._textureHalfFloat = !!getExtension(gl, ["OES_texture_half_float"]);

    this._textureFloatLinear = !!getExtension(gl, ["OES_texture_float_linear"]);
    this._textureHalfFloatLinear = !!getExtension(gl, [
      "OES_texture_half_float_linear",
    ]);

    this._supportsTextureLod = !!getExtension(gl, ["EXT_shader_texture_lod"]);

    this._colorBufferFloat = !!getExtension(gl, [
      "EXT_color_buffer_float",
      "WEBGL_color_buffer_float",
    ]);
    this._floatBlend = !!getExtension(gl, ["EXT_float_blend"]);
    this._colorBufferHalfFloat = !!getExtension(gl, [
      "EXT_color_buffer_half_float",
    ]);

    // ─── Compute shader extension probing (WebGL 2.0 future-ready) ───
    // These extensions do not exist yet in any shipping browser (as of 2026).
    // When WebGL 2.0 gains compute shader support (analogous to GL ES 3.1
    // GL_ARB_compute_shader), the extension names will be registered here.
    // Until then, all three will be `undefined` and the capability getters
    // on GraphicsContext (supportsComputeShaders, supportsStorageBuffers, etc.)
    // will return their default `false` values. Only this file needs updating
    // when the extensions ship — all scene code queries GraphicsContext.
    this._webglCompute = getExtension(gl, [
      "WEBGL_compute",
      "WEBKIT_WEBGL_compute",
    ]);
    this._webglShaderStorageBuffer = getExtension(gl, [
      "WEBGL_shader_storage_buffer",
      "WEBKIT_WEBGL_shader_storage_buffer",
    ]);

    this._s3tc = !!getExtension(gl, [
      "WEBGL_compressed_texture_s3tc",
      "MOZ_WEBGL_compressed_texture_s3tc",
      "WEBKIT_WEBGL_compressed_texture_s3tc",
    ]);
    this._pvrtc = !!getExtension(gl, [
      "WEBGL_compressed_texture_pvrtc",
      "WEBKIT_WEBGL_compressed_texture_pvrtc",
    ]);
    this._astc = !!getExtension(gl, ["WEBGL_compressed_texture_astc"]);
    this._etc = !!getExtension(gl, ["WEBGL_compressed_texture_etc"]);
    this._etc1 = !!getExtension(gl, ["WEBGL_compressed_texture_etc1"]);
    this._bc7 = !!getExtension(gl, ["EXT_texture_compression_bptc"]);

    const textureFilterAnisotropic = allowTextureFilterAnisotropic
      ? getExtension(gl, [
          "EXT_texture_filter_anisotropic",
          "WEBKIT_EXT_texture_filter_anisotropic",
        ])
      : undefined;
    this._textureFilterAnisotropic = textureFilterAnisotropic;
    capabilityOptions.maximumTextureFilterAnisotropy = defined(
      textureFilterAnisotropic,
    )
      ? gl.getParameter(textureFilterAnisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1.0;

    let glCreateVertexArray;
    let glBindVertexArray;
    let glDeleteVertexArray;

    let glDrawElementsInstanced;
    let glDrawArraysInstanced;
    let glVertexAttribDivisor;

    let glDrawBuffers;

    let vertexArrayObject;
    let instancedArrays;
    let drawBuffers;

    if (webgl2) {
      const that = this;

      glCreateVertexArray = function () {
        return that._gl.createVertexArray();
      };
      glBindVertexArray = function (vao) {
        that._gl.bindVertexArray(vao);
      };
      glDeleteVertexArray = function (vao) {
        that._gl.deleteVertexArray(vao);
      };

      glDrawElementsInstanced = function (
        mode,
        count,
        type,
        offset,
        instanceCount,
      ) {
        gl.drawElementsInstanced(mode, count, type, offset, instanceCount);
      };
      glDrawArraysInstanced = function (mode, first, count, instanceCount) {
        gl.drawArraysInstanced(mode, first, count, instanceCount);
      };
      glVertexAttribDivisor = function (index, divisor) {
        gl.vertexAttribDivisor(index, divisor);
      };

      glDrawBuffers = function (buffers) {
        gl.drawBuffers(buffers);
      };
    } else {
      vertexArrayObject = getExtension(gl, ["OES_vertex_array_object"]);
      if (defined(vertexArrayObject)) {
        glCreateVertexArray = function () {
          return vertexArrayObject.createVertexArrayOES();
        };
        glBindVertexArray = function (vertexArray) {
          vertexArrayObject.bindVertexArrayOES(vertexArray);
        };
        glDeleteVertexArray = function (vertexArray) {
          vertexArrayObject.deleteVertexArrayOES(vertexArray);
        };
      }

      instancedArrays = getExtension(gl, ["ANGLE_instanced_arrays"]);
      if (defined(instancedArrays)) {
        glDrawElementsInstanced = function (
          mode,
          count,
          type,
          offset,
          instanceCount,
        ) {
          instancedArrays.drawElementsInstancedANGLE(
            mode,
            count,
            type,
            offset,
            instanceCount,
          );
        };
        glDrawArraysInstanced = function (mode, first, count, instanceCount) {
          instancedArrays.drawArraysInstancedANGLE(
            mode,
            first,
            count,
            instanceCount,
          );
        };
        glVertexAttribDivisor = function (index, divisor) {
          instancedArrays.vertexAttribDivisorANGLE(index, divisor);
        };
      }

      drawBuffers = getExtension(gl, ["WEBGL_draw_buffers"]);
      if (defined(drawBuffers)) {
        glDrawBuffers = function (buffers) {
          drawBuffers.drawBuffersWEBGL(buffers);
        };
      }
    }

    this.glCreateVertexArray = glCreateVertexArray;
    this.glBindVertexArray = glBindVertexArray;
    this.glDeleteVertexArray = glDeleteVertexArray;

    this.glDrawElementsInstanced = glDrawElementsInstanced;
    this.glDrawArraysInstanced = glDrawArraysInstanced;
    this.glVertexAttribDivisor = glVertexAttribDivisor;

    this.glDrawBuffers = glDrawBuffers;

    this._vertexArrayObject = !!vertexArrayObject;
    this._instancedArrays = !!instancedArrays;
    this._drawBuffers = !!drawBuffers;

    capabilityOptions.maximumDrawBuffers = this.drawBuffers
      ? gl.getParameter(WebGLConstants.MAX_DRAW_BUFFERS)
      : 1;
    capabilityOptions.maximumColorAttachments = this.drawBuffers
      ? gl.getParameter(WebGLConstants.MAX_COLOR_ATTACHMENTS)
      : 1;

    capabilityOptions.ktx2TranscodeTargets = {
      s3tc: this._s3tc,
      pvrtc: this._pvrtc,
      astc: this._astc,
      etc: this._etc,
      etc1: this._etc1,
      bc7: this._bc7,
    };
    this._graphicsCapabilities = GraphicsCapabilities.create(capabilityOptions);

    this._clearColor = new Color(0.0, 0.0, 0.0, 0.0);
    this._clearDepth = 1.0;
    this._clearStencil = 0;

    const us = new UniformState(this.clipSpaceConvention);
    const ps = new PassState(this);
    const rs = RenderState.fromCache();

    this._defaultPassState = ps;
    this._defaultRenderState = rs;
    // default texture has a value of (1, 1, 1)
    // default emissive texture has a value of (0, 0, 0)
    // default normal texture is +z which is encoded as (0.5, 0.5, 1)
    this._defaultTexture = undefined;
    this._defaultEmissiveTexture = undefined;
    this._defaultNormalTexture = undefined;
    this._defaultCubeMap = undefined;

    this._us = us;
    this._currentRenderState = rs;
    this._currentPassState = ps;
    this._currentFramebuffer = undefined;
    this._maxFrameTextureUnitIndex = 0;

    // Vertex attribute divisor state cache. Workaround for ANGLE (also look at VertexArray.setVertexAttribDivisor)
    this._vertexAttribDivisors = [];
    this._previousDrawInstanced = false;
    for (let i = 0; i < this.limits.maximumVertexAttributes; i++) {
      this._vertexAttribDivisors.push(0);
    }

    // Pick ID management (createPickId, getObjectByPickColor, _pickObjects,
    // _nextPickColor) inherited from GraphicsContext base class.

    /**
     * The options used to construct this context
     *
     * @type {ContextOptions}
     */
    this.options = {
      getWebGLStub: getWebGLStub,
      requestWebgl1: requestWebgl1,
      webgl: webglOptions,
      allowTextureFilterAnisotropic: allowTextureFilterAnisotropic,
    };

    /**
     * A cache of objects tied to this context.  Just before the Context is destroyed,
     * <code>destroy</code> will be invoked on each object in this object literal that has
     * such a method.  This is useful for caching any objects that might otherwise
     * be stored globally, except they're tied to a particular context, and to manage
     * their lifetime.
     *
     * @type {object}
     */
    this.cache = {};

    RenderState.apply(gl, rs, ps);

    // ── WebGL feature renderers ──
    // The WebGL backend renders almost everything through the legacy
    // direct-command path (no FR needed), so unlike WebGPU it registers
    // only the handful of FRs that have a true WebGL-specific draw path.
    //
    // STAR_FIELD (NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK, Batch 324) —
    // the bright-star catalog starfield. Lazily imported so the renderer
    // module (and its GLSL shader strings) only enter the bundle when a
    // StarField actually updates, and so Context.js stays free of a static
    // Renderer→Scene import cycle. Until the import settles,
    // `StarField.update` no-ops (returns undefined) and the SkyBox cubemap
    // stars are the only starfield — same graceful warm-up as WebGPU's
    // async pipeline cache.
    this.registerFeatureRendererLoader(
      FeatureRendererKey.STAR_FIELD,
      async () => {
        const mod = await import("./WebGLStarFieldRenderer.js");
        return {
          update: mod.updateWebGLStarField,
          // Warm-keep on the zero-contribution (daylight) path so the first
          // contributing dusk frame does not synchronously build the VAO /
          // shader program / buffers (C9-06 star pop-in). No per-frame
          // uniform or command work.
          prepare: mod.prepareWebGLStarField,
          destroy: mod.destroyWebGLStarFieldResources,
          getStatistics: mod.getWebGLStarFieldStatistics,
        };
      },
    );

    // Register with the global ContextRegistry (Phase B)
    this._registerWithRegistry();
  }

  // ═══════════════════════════════════════════════════════════
  // GRAPHICSCONTEXT ABSTRACT METHOD IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * The renderer type for this context. Always WEBGL.
   * @returns {RendererType}
   */
  get rendererType() {
    return RendererType.WEBGL;
  }

  /**
   * Backend-agnostic render-target format epoch. WebGL's scene FBO color
   * format never changes at runtime on an HDR toggle (it uses a separate
   * float-target path), so this is a constant 0 — command builders that key a
   * rebuild off it stay byte-identical on WebGL. The WebGPU context overrides
   * this to increment on every scene FB color-format change.
   * @returns {number}
   */
  get renderTargetGeneration() {
    return 0;
  }

  /**
   * Get a human-readable string describing this renderer.
   * @returns {string}
   */
  getRendererString() {
    const gl = this._gl;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR);
    const renderer = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return `WebGL ${this._webgl2 ? "2" : "1"}: ${vendor} ${renderer}`;
  }

  /**
   * Resize the drawing buffer. WebGL canvas auto-resizes via CSS,
   * so this is a no-op for WebGL contexts.
   */
  resize() {
    // WebGL canvases auto-resize — no explicit action needed.
  }

  /**
   * Cloud-unification epic — backend-neutral volumetric cloud publish seam.
   * WebGL renders no volumetric cloud deck, so this is a no-op; scene code calls
   * it unconditionally (never branching on backend). Mirrors the base
   * {@link GraphicsContext#requestVolumetricClouds} no-op explicitly so the WebGL
   * intent is documented at the WebGL class. See
   * migration_doc/CLOUD_UNIFICATION_DESIGN.md §2.4.
   * @param {object} config The volumetric cloud config (ignored on WebGL).
   */
  requestVolumetricClouds(config) {
    // No-op: the WebGL renderer has no volumetric cloud pass.
  }

  // ═══════════════════════════════════════════════════════════
  // PROPERTY GETTERS
  // ═══════════════════════════════════════════════════════════

  get id() {
    return this._id;
  }

  get webgl2() {
    return this._webgl2;
  }

  get canvas() {
    return this._canvas;
  }

  get shaderCache() {
    return this._shaderCache;
  }

  get textureCache() {
    return this._textureCache;
  }

  get uniformState() {
    return this._us;
  }

  /**
   * The number of stencil bits per pixel in the default bound framebuffer.  The minimum is eight bits.
   * @type {number}
   * @see {@link https://www.khronos.org/opengles/sdk/docs/man/xhtml/glGet.xml|glGet} with <code>STENCIL_BITS</code>.
   */
  get stencilBits() {
    return this._stencilBits;
  }

  /**
   * <code>true</code> if the WebGL context supports stencil buffers.
   * Stencil buffers are not supported by all systems.
   * @type {boolean}
   */
  get stencilBuffer() {
    return this._stencilBits >= 8;
  }

  /**
   * <code>true</code> if the WebGL context supports antialiasing.  By default
   * antialiasing is requested, but it is not supported by all systems.
   * @type {boolean}
   */
  get antialias() {
    return this._antialias;
  }

  /**
   * <code>true</code> if the WebGL context supports multisample antialiasing. Requires
   * WebGL2.
   * @type {boolean}
   */
  get msaa() {
    return this._webgl2;
  }

  /**
   * <code>true</code> if the OES_standard_derivatives extension is supported.
   * @type {boolean}
   */
  get standardDerivatives() {
    return this._standardDerivatives || this._webgl2;
  }

  /**
   * <code>true</code> if the EXT_float_blend extension is supported.
   * @type {boolean}
   */
  get floatBlend() {
    return this._floatBlend;
  }

  /**
   * <code>true</code> if the EXT_blend_minmax extension is supported.
   * @type {boolean}
   */
  get blendMinmax() {
    return this._blendMinmax || this._webgl2;
  }

  /**
   * <code>true</code> if the OES_element_index_uint extension is supported.
   * @type {boolean}
   */
  get elementIndexUint() {
    return this._elementIndexUint || this._webgl2;
  }

  /**
   * <code>true</code> if WEBGL_depth_texture is supported.
   * @type {boolean}
   */
  get depthTexture() {
    return this._depthTexture || this._webgl2;
  }

  /**
   * <code>true</code> if OES_texture_float is supported.
   * @type {boolean}
   */
  get floatingPointTexture() {
    return this._webgl2 || this._textureFloat;
  }

  /**
   * <code>true</code> if OES_texture_half_float is supported.
   * @type {boolean}
   */
  get halfFloatingPointTexture() {
    return this._webgl2 || this._textureHalfFloat;
  }

  /**
   * <code>true</code> if OES_texture_float_linear is supported.
   * @type {boolean}
   */
  get textureFloatLinear() {
    return this._textureFloatLinear;
  }

  /**
   * <code>true</code> if OES_texture_half_float_linear is supported.
   * @type {boolean}
   */
  get textureHalfFloatLinear() {
    return (
      (this._webgl2 && this._textureFloatLinear) ||
      (!this._webgl2 && this._textureHalfFloatLinear)
    );
  }

  /**
   * <code>true</code> if EXT_shader_texture_lod is supported.
   * @type {boolean}
   */
  get supportsTextureLod() {
    return this._webgl2 || this._supportsTextureLod;
  }

  /**
   * <code>true</code> if EXT_texture_filter_anisotropic is supported.
   * @type {boolean}
   */
  get textureFilterAnisotropic() {
    return !!this._textureFilterAnisotropic;
  }

  /**
   * <code>true</code> if WEBGL_compressed_texture_s3tc is supported.
   * @type {boolean}
   */
  get s3tc() {
    return this._s3tc;
  }

  /**
   * <code>true</code> if WEBGL_compressed_texture_pvrtc is supported.
   * @type {boolean}
   */
  get pvrtc() {
    return this._pvrtc;
  }

  /**
   * <code>true</code> if WEBGL_compressed_texture_astc is supported.
   * @type {boolean}
   */
  get astc() {
    return this._astc;
  }

  /**
   * <code>true</code> if WEBGL_compressed_texture_etc is supported.
   * @type {boolean}
   */
  get etc() {
    return this._etc;
  }

  /**
   * <code>true</code> if WEBGL_compressed_texture_etc1 is supported.
   * @type {boolean}
   */
  get etc1() {
    return this._etc1;
  }

  /**
   * <code>true</code> if EXT_texture_compression_bptc is supported.
   * @type {boolean}
   */
  get bc7() {
    return this._bc7;
  }

  /**
   * <code>true</code> if S3TC, PVRTC, ASTC, ETC, ETC1, or BC7 compression is supported.
   * @type {boolean}
   */
  get supportsBasis() {
    return this.graphicsCapabilities.supportsBasis;
  }

  /**
   * <code>true</code> if the OES_vertex_array_object extension is supported.
   * @type {boolean}
   */
  get vertexArrayObject() {
    return this._vertexArrayObject || this._webgl2;
  }

  /**
   * <code>true</code> if the EXT_frag_depth extension is supported.
   * @type {boolean}
   */
  get fragmentDepth() {
    return this._fragDepth || this._webgl2;
  }

  /**
   * <code>true</code> if the ANGLE_instanced_arrays extension is supported.
   * @type {boolean}
   */
  get instancedArrays() {
    return this._instancedArrays || this._webgl2;
  }

  /**
   * <code>true</code> if the EXT_color_buffer_float extension is supported.
   * @type {boolean}
   */
  get colorBufferFloat() {
    return this._colorBufferFloat;
  }

  /**
   * <code>true</code> if the EXT_color_buffer_half_float extension is supported.
   * @type {boolean}
   */
  get colorBufferHalfFloat() {
    return (
      (this._webgl2 && this._colorBufferFloat) ||
      (!this._webgl2 && this._colorBufferHalfFloat)
    );
  }

  /**
   * <code>true</code> if the WEBGL_draw_buffers extension is supported.
   * @type {boolean}
   */
  get drawBuffers() {
    return this._drawBuffers || this._webgl2;
  }

  // ═══════════════════════════════════════════════════════════
  // COMPUTE SHADER CAPABILITY OVERRIDES (WebGL 2.0 future-ready)
  //
  // These override the GraphicsContext base class defaults (all false/0).
  // Currently they all return false/0 because no WebGL compute extension
  // ships yet. When WEBGL_compute or an equivalent lands in browsers,
  // the `_webglCompute` probe in the constructor will detect it, and
  // these getters will start returning true/non-zero — enabling compute
  // shader codepaths for WebGL 2.0 without any scene-level changes.
  // ═══════════════════════════════════════════════════════════

  /**
   * Whether this WebGL context supports real GPU compute shaders.
   * Currently always false (no WEBGL_compute extension exists yet).
   * When the extension ships, this will automatically return true.
   * @type {boolean}
   */
  get supportsComputeShaders() {
    return !!this._webglCompute;
  }

  /**
   * Whether this WebGL context supports shader storage buffers (SSBOs).
   * Currently always false (no WEBGL_shader_storage_buffer extension yet).
   * @type {boolean}
   */
  get supportsStorageBuffers() {
    return !!this._webglShaderStorageBuffer;
  }

  get debugShaders() {
    return this._debugShaders;
  }

  get throwOnWebGLError() {
    return this._throwOnWebGLError;
  }

  set throwOnWebGLError(value) {
    this._throwOnWebGLError = value;
    this._gl = wrapGL(
      this._originalGLContext,
      value ? throwOnError : undefined,
    );
  }

  /**
   * A 1x1 RGBA texture initialized to [255, 255, 255, 255].  This can
   * be used as a placeholder texture while other textures are downloaded.
   * @type {Texture}
   */
  get defaultTexture() {
    if (this._defaultTexture === undefined) {
      this._defaultTexture = new Texture({
        context: this,
        source: {
          width: 1,
          height: 1,
          arrayBufferView: new Uint8Array([255, 255, 255, 255]),
        },
        flipY: false,
      });
    }

    return this._defaultTexture;
  }

  /**
   * A 1x1 RGB texture initialized to [0, 0, 0] representing a material that is
   * not emissive.
   * @type {Texture}
   */
  get defaultEmissiveTexture() {
    if (this._defaultEmissiveTexture === undefined) {
      this._defaultEmissiveTexture = new Texture({
        context: this,
        pixelFormat: PixelFormat.RGB,
        source: {
          width: 1,
          height: 1,
          arrayBufferView: new Uint8Array([0, 0, 0]),
        },
        flipY: false,
      });
    }

    return this._defaultEmissiveTexture;
  }

  /**
   * A 1x1 RGBA texture initialized to [128, 128, 255] to encode a tangent
   * space normal pointing in the +z direction, i.e. (0, 0, 1).
   * @type {Texture}
   */
  get defaultNormalTexture() {
    if (this._defaultNormalTexture === undefined) {
      this._defaultNormalTexture = new Texture({
        context: this,
        pixelFormat: PixelFormat.RGB,
        source: {
          width: 1,
          height: 1,
          arrayBufferView: new Uint8Array([128, 128, 255]),
        },
        flipY: false,
      });
    }

    return this._defaultNormalTexture;
  }

  /**
   * A cube map, where each face is a 1x1 RGBA texture initialized to
   * [255, 255, 255, 255].
   * @type {CubeMap}
   */
  get defaultCubeMap() {
    if (this._defaultCubeMap === undefined) {
      const face = {
        width: 1,
        height: 1,
        arrayBufferView: new Uint8Array([255, 255, 255, 255]),
      };

      this._defaultCubeMap = new CubeMap({
        context: this,
        source: {
          positiveX: face,
          negativeX: face,
          positiveY: face,
          negativeY: face,
          positiveZ: face,
          negativeZ: face,
        },
        flipY: false,
      });
    }

    return this._defaultCubeMap;
  }

  /**
   * The drawingBufferHeight of the underlying GL context.
   * @type {number}
   */
  get drawingBufferHeight() {
    return this._gl.drawingBufferHeight;
  }

  /**
   * The drawingBufferWidth of the underlying GL context.
   * @type {number}
   */
  get drawingBufferWidth() {
    return this._gl.drawingBufferWidth;
  }

  /**
   * Gets an object representing the currently bound framebuffer.
   * @type {object}
   */
  get defaultFramebuffer() {
    return defaultFramebufferMarker;
  }

  // ═══════════════════════════════════════════════════════════
  // METHODS
  // ═══════════════════════════════════════════════════════════

  clear(clearCommand, passState) {
    clearCommand = clearCommand ?? defaultClearCommand;
    passState = passState ?? this._defaultPassState;

    const gl = this._gl;
    let bitmask = 0;

    const c = clearCommand.color;
    const d = clearCommand.depth;
    const s = clearCommand.stencil;

    if (defined(c)) {
      if (!Color.equals(this._clearColor, c)) {
        Color.clone(c, this._clearColor);
        gl.clearColor(c.red, c.green, c.blue, c.alpha);
      }
      bitmask |= gl.COLOR_BUFFER_BIT;
    }

    if (defined(d)) {
      if (d !== this._clearDepth) {
        this._clearDepth = d;
        gl.clearDepth(d);
      }
      bitmask |= gl.DEPTH_BUFFER_BIT;
    }

    if (defined(s)) {
      if (s !== this._clearStencil) {
        this._clearStencil = s;
        gl.clearStencil(s);
      }
      bitmask |= gl.STENCIL_BUFFER_BIT;
    }

    const rs = clearCommand.renderState ?? this._defaultRenderState;
    applyRenderState(this, rs, passState, true);

    // The command's framebuffer takes presidence over the pass' framebuffer, e.g., for off-screen rendering.
    const framebuffer = clearCommand.framebuffer ?? passState.framebuffer;
    bindFramebuffer(this, framebuffer);

    gl.clear(bitmask);
  }

  draw(drawCommand, passState, shaderProgram, uniformMap) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("drawCommand", drawCommand);
    Check.defined("drawCommand.shaderProgram", drawCommand._shaderProgram);
    //>>includeEnd('debug');

    passState = passState ?? this._defaultPassState;
    // The command's framebuffer takes precedence over the pass' framebuffer, e.g., for off-screen rendering.
    const framebuffer = drawCommand._framebuffer ?? passState.framebuffer;
    const renderState = drawCommand._renderState ?? this._defaultRenderState;
    shaderProgram = shaderProgram ?? drawCommand._shaderProgram;
    uniformMap = uniformMap ?? drawCommand._uniformMap;

    beginDraw(this, framebuffer, passState, shaderProgram, renderState);
    continueDraw(this, drawCommand, shaderProgram, uniformMap);
  }

  beginFrame() {
    // A no-op. Overridden when drawing to a SharedContext.
  }

  endFrame() {
    const gl = this._gl;
    gl.useProgram(null);

    this._currentFramebuffer = undefined;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const buffers = scratchBackBufferArray;
    if (this.drawBuffers) {
      this.glDrawBuffers(buffers);
    }

    const length = this._maxFrameTextureUnitIndex;
    this._maxFrameTextureUnitIndex = 0;

    for (let i = 0; i < length; ++i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }
  }

  /**
   * Read pixels from a framebuffer into a Pixel Buffer Object (PBO).
   *
   * @private
   * @param {ReadState} readState Options defining a rectangle to read pixels from.
   * @returns {Buffer} A PixelBuffer containing the pixels read from the specified rectangle.
   *
   * @exception {DeveloperError} A WebGL 2 context is required to read pixels using a PBO.
   */
  readPixelsToPBO(readState) {
    const gl = this._gl;

    readState = readState ?? Frozen.EMPTY_OBJECT;
    const x = Math.max(readState.x ?? 0, 0);
    const y = Math.max(readState.y ?? 0, 0);
    const width = readState.width ?? this.drawingBufferWidth;
    const height = readState.height ?? this.drawingBufferHeight;
    const framebuffer = readState.framebuffer;

    if (!this._webgl2) {
      throw new DeveloperError(
        "A WebGL 2 context is required to read pixels using a PBO.",
      );
    }

    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThan("readState.width", width, 0);
    Check.typeOf.number.greaterThan("readState.height", height, 0);
    //>>includeEnd('debug');

    let pixelDatatype = PixelDatatype.UNSIGNED_BYTE;
    let pixelFormat = PixelFormat.RGBA;
    if (defined(framebuffer) && framebuffer.numberOfColorAttachments > 0) {
      pixelDatatype = framebuffer.getColorTexture(0).pixelDatatype;
      pixelFormat = framebuffer.getColorTexture(0).pixelFormat;
    }

    const pixels = Buffer.createPixelBuffer({
      context: this,
      sizeInBytes: PixelFormat.textureSizeInBytes(
        pixelFormat,
        pixelDatatype,
        width,
        height,
      ),
      usage: BufferUsage.DYNAMIC_READ,
    });

    bindFramebuffer(this, framebuffer);

    pixels._bind();
    gl.readPixels(
      x,
      y,
      width,
      height,
      pixelFormat,
      PixelDatatype.toWebGLConstant(pixelDatatype, this),
      0,
    );
    pixels._unBind();

    return pixels;
  }

  /**
   * Read pixels from a framebuffer into a typed array.
   *
   * @private
   * @param {ReadState} readState Options defining a rectangle to read pixels from.
   * @returns {Uint8Array|Uint16Array|Float32Array|Uint32Array} The pixels in the specified rectangle.
   */
  readPixels(readState) {
    const gl = this._gl;

    readState = readState ?? Frozen.EMPTY_OBJECT;
    const x = Math.max(readState.x ?? 0, 0);
    const y = Math.max(readState.y ?? 0, 0);
    const width = readState.width ?? this.drawingBufferWidth;
    const height = readState.height ?? this.drawingBufferHeight;
    const framebuffer = readState.framebuffer;

    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThan("readState.width", width, 0);
    Check.typeOf.number.greaterThan("readState.height", height, 0);
    //>>includeEnd('debug');

    let pixelDatatype = PixelDatatype.UNSIGNED_BYTE;
    let pixelFormat = PixelFormat.RGBA;
    if (defined(framebuffer) && framebuffer.numberOfColorAttachments > 0) {
      pixelDatatype = framebuffer.getColorTexture(0).pixelDatatype;
      pixelFormat = framebuffer.getColorTexture(0).pixelFormat;
    }

    const pixels = PixelFormat.createTypedArray(
      pixelFormat,
      pixelDatatype,
      width,
      height,
    );

    bindFramebuffer(this, framebuffer);

    gl.readPixels(
      x,
      y,
      width,
      height,
      PixelFormat.RGBA,
      PixelDatatype.toWebGLConstant(pixelDatatype, this),
      pixels,
    );

    return pixels;
  }

  getViewportQuadVertexArray() {
    // Per-context cache for viewport quads
    let vertexArray = this.cache.viewportQuad_vertexArray;

    if (!defined(vertexArray)) {
      const geometry = new Geometry({
        attributes: {
          position: new GeometryAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0],
          }),

          textureCoordinates: new GeometryAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
          }),
        },
        // Workaround Internet Explorer 11.0.8 lack of TRIANGLE_FAN
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        primitiveType: PrimitiveType.TRIANGLES,
      });

      vertexArray = VertexArray.fromGeometry({
        context: this,
        geometry: geometry,
        attributeLocations: viewportQuadAttributeLocations,
        bufferUsage: BufferUsage.STATIC_DRAW,
        interleave: true,
      });

      this.cache.viewportQuad_vertexArray = vertexArray;
    }

    return vertexArray;
  }

  createViewportQuadCommand(fragmentShaderSource, overrides) {
    overrides = overrides ?? Frozen.EMPTY_OBJECT;

    return new DrawCommand({
      vertexArray: this.getViewportQuadVertexArray(),
      primitiveType: PrimitiveType.TRIANGLES,
      renderState: overrides.renderState,
      shaderProgram: ShaderProgram.fromCache({
        context: this,
        vertexShaderSource: ViewportQuadVS,
        fragmentShaderSource: fragmentShaderSource,
        attributeLocations: viewportQuadAttributeLocations,
      }),
      uniformMap: overrides.uniformMap,
      owner: overrides.owner,
      framebuffer: overrides.framebuffer,
      pass: overrides.pass,
    });
  }

  /**
   * AUDIT_2026_05_02 C.7 — backend-agnostic GPU-completion fence
   * factory. WebGL backend wraps `gl.fenceSync` + `gl.clientWaitSync`
   * via the existing {@link Sync} class. See {@link GraphicsContext.createSync}
   * for the contract.
   */
  createSync(options) {
    const opts = options ?? Frozen.EMPTY_OBJECT;
    return Sync.create({ ...opts, context: this });
  }

  // getObjectByPickColor() and createPickId() are inherited from
  // GraphicsContext base class — no override needed. (FORK-35 consolidation)

  isDestroyed() {
    return false;
  }

  destroy() {
    // Unregister from the global ContextRegistry before destroying resources
    this._unregisterFromRegistry();
    this._destroyFeatureRenderers();

    // Destroy all objects in the cache that have a destroy method.
    const cache = this.cache;
    for (const property in cache) {
      if (cache.hasOwnProperty(property)) {
        const propertyValue = cache[property];
        if (defined(propertyValue.destroy)) {
          propertyValue.destroy();
        }
      }
    }

    this._shaderCache = this._shaderCache.destroy();
    this._textureCache = this._textureCache.destroy();
    this._defaultTexture =
      this._defaultTexture && this._defaultTexture.destroy();
    this._defaultEmissiveTexture =
      this._defaultEmissiveTexture && this._defaultEmissiveTexture.destroy();
    this._defaultNormalTexture =
      this._defaultNormalTexture && this._defaultNormalTexture.destroy();
    this._defaultCubeMap =
      this._defaultCubeMap && this._defaultCubeMap.destroy();

    return destroyObject(this);
  }
}

/**
 * @typedef {object} ContextOptions
 *
 * Options to control the setting up of a WebGL Context.
 * <p>
 * <code>allowTextureFilterAnisotropic</code> defaults to true, which enables
 * anisotropic texture filtering when the WebGL extension is supported.
 * Setting this to false will improve performance, but hurt visual quality,
 * especially for horizon views.
 * </p>
 *
 * @property {boolean} [requestWebgl1=false] If true and the browser supports it, use a WebGL 1 rendering context
 * @property {boolean} [allowTextureFilterAnisotropic=true] If true, use anisotropic filtering during texture sampling
 * @property {WebGLOptions} [webgl] WebGL options to be passed on to canvas.getContext
 * @property {Function} [getWebGLStub] A function to create a WebGL stub for testing
 */

/**
 * @typedef {object} WebGLOptions
 *
 * WebGL options to be passed on to HTMLCanvasElement.getContext().
 * See {@link https://registry.khronos.org/webgl/specs/latest/1.0/#5.2|WebGLContextAttributes}
 * but note the modified defaults for 'alpha', 'stencil', and 'powerPreference'
 *
 * <p>
 * <code>alpha</code> defaults to false, which can improve performance
 * compared to the standard WebGL default of true.  If an application needs
 * to composite Cesium above other HTML elements using alpha-blending, set
 * <code>alpha</code> to true.
 * </p>
 *
 * @property {boolean} [alpha=false]
 * @property {boolean} [depth=true]
 * @property {boolean} [stencil=false]
 * @property {boolean} [antialias=true]
 * @property {boolean} [premultipliedAlpha=true]
 * @property {boolean} [preserveDrawingBuffer=false]
 * @property {("default"|"low-power"|"high-performance")} [powerPreference="high-performance"]
 * @property {boolean} [failIfMajorPerformanceCaveat=false]
 */

/**
 * @typedef {object} ReadState
 *
 * Options defining a rectangle to read pixels from.
 *
 * @private
 * @property {number} [x=0] The x offset of the rectangle to read from.
 * @property {number} [y=0] The y offset of the rectangle to read from.
 * @property {number} [width=this.drawingBufferWidth] The width of the rectangle to read from.
 * @property {number} [height=this.drawingBufferHeight] The height of the rectangle to read from.
 * @property {FrameBuffer|undefined} [framebuffer] The framebuffer to read from. If undefined, the read will be from the default framebuffer.
 */

export default Context;
