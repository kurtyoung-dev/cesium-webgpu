/**
 * WebGL bright-star catalog starfield renderer
 * (NEW-STARS-BRIGHT-CATALOG-WEBGL-FALLBACK, Batch 324).
 *
 * The WebGL counterpart to {@link WebGPUStarFieldRenderer}: draws the same
 * Yale Bright Star Catalog subset ({@link BrightStarCatalog}) as instanced
 * HDR point sprites into the scene framebuffer with premultiplied additive
 * blend, so the existing bloom post-process makes the brightest stars glow.
 * This augments the static SkyBox star cubemap with real, physically-placed
 * stars on WebGL, closing the night-sky divergence between the two backends.
 *
 * Parity with WebGPU is guaranteed structurally: the per-instance vertex
 * records (RA/Dec → inertial direction, Pogson magnitude → HDR brightness,
 * B−V → blackbody RGB, brightness-driven size boost) come from the SAME
 * backend-neutral {@link module:StarFieldMath} the WebGPU renderer uses.
 * Only the draw path differs — GLSL point sprites (`StarFieldVS/FS.glsl`)
 * vs the WGSL pipeline (`Shaders/WebGPU/Catalog/StarField.wgsl`).
 *
 * Technique:
 *   - magnitude → intensity via the Pogson scale (each magnitude step is a
 *     flux ratio of 100^(1/5) ≈ 2.512).
 *   - B−V color index → color temperature (Ballesteros 2012) → Planckian-
 *     locus RGB.
 *   - inertial (J2000 / TEME) catalog directions rotated into the Earth-
 *     fixed frame each frame by the `czm_temeToPseudoFixed` automatic
 *     uniform — the same rotation SkyBox uses for its cubemap.
 *
 * Lifecycle: the per-instance star buffer + VertexArray + ShaderProgram +
 * RenderState are built ONCE (catalog is static); only the per-frame
 * uniforms (point sizing + day-fade-modulated intensity) change. The
 * resources are cached on `starField._webglCache`. The renderer is
 * registered as the WebGL {@link FeatureRendererKey.STAR_FIELD} feature
 * renderer in {@link Context} and its draw command is executed by
 * {@link EnvironmentRenderer} right after the SkyBox cubemap.
 *
 * @private
 * @module WebGLStarFieldRenderer
 */
import BoundingSphere from "../Core/BoundingSphere.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import defined from "../Core/defined.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import PrimitiveType from "../Core/PrimitiveType.js";
import BlendEquation from "../Scene/BlendEquation.js";
import BlendFunction from "../Scene/BlendFunction.js";
import {
  FLOATS_PER_STAR,
  buildStarInstanceData,
  computeStarDayFade,
} from "../Scene/StarFieldMath.js";
import BrightStarCatalog from "../Scene/BrightStarCatalog.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Buffer from "./Buffer.js";
import BufferUsage from "./BufferUsage.js";
import DrawCommand from "./DrawCommand.js";
import Pass from "./Pass.js";
import RenderState from "./RenderState.js";
import ShaderProgram from "./ShaderProgram.js";
import VertexArray from "./VertexArray.js";
import StarFieldVS from "../Shaders/StarFieldVS.js";
import StarFieldFS from "../Shaders/StarFieldFS.js";

const STAR_VERTEX_STRIDE = FLOATS_PER_STAR * 4; // 32 bytes

// Attribute locations. Attribute 0 MUST be the per-vertex (non-instanced)
// corner — VertexArray forbids an instanceDivisor on attribute zero.
const attributeLocations = {
  corner: 0,
  directionFixed: 1,
  intensity: 2,
  starColor: 3,
  sizeBoost: 4,
};

/**
 * Build the per-instance star vertex buffer + per-vertex quad corner buffer
 * + index buffer into a single instanced VertexArray, plus the shader
 * program and render state. Stored on `cache`. Called once.
 *
 * @private
 */
function buildResources(context, cache) {
  // Per-vertex quad corners in [-1, 1] (two triangles via the index buffer).
  // Matches the WGSL cornerForIndex table: (-1,-1)(1,-1)(1,1)(-1,1).
  const corners = new Float32Array([
    -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
  ]);
  const cornerBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: corners,
    usage: BufferUsage.STATIC_DRAW,
  });

  // Per-instance star records (8 floats each), shared layout with WebGPU.
  const starData = buildStarInstanceData();
  const instanceBuffer = Buffer.createVertexBuffer({
    context: context,
    typedArray: starData,
    usage: BufferUsage.STATIC_DRAW,
  });

  const indexBuffer = Buffer.createIndexBuffer({
    context: context,
    typedArray: new Uint16Array([0, 1, 2, 0, 2, 3]),
    usage: BufferUsage.STATIC_DRAW,
    indexDatatype: IndexDatatype.UNSIGNED_SHORT,
  });

  const FLOAT = ComponentDatatype.FLOAT;
  const attributes = [
    {
      index: attributeLocations.corner,
      vertexBuffer: cornerBuffer,
      componentsPerAttribute: 2,
      componentDatatype: FLOAT,
      // instanceDivisor 0 (default) — per-vertex.
    },
    {
      index: attributeLocations.directionFixed,
      vertexBuffer: instanceBuffer,
      componentsPerAttribute: 3,
      componentDatatype: FLOAT,
      offsetInBytes: 0,
      strideInBytes: STAR_VERTEX_STRIDE,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.intensity,
      vertexBuffer: instanceBuffer,
      componentsPerAttribute: 1,
      componentDatatype: FLOAT,
      offsetInBytes: 12,
      strideInBytes: STAR_VERTEX_STRIDE,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.starColor,
      vertexBuffer: instanceBuffer,
      componentsPerAttribute: 3,
      componentDatatype: FLOAT,
      offsetInBytes: 16,
      strideInBytes: STAR_VERTEX_STRIDE,
      instanceDivisor: 1,
    },
    {
      index: attributeLocations.sizeBoost,
      vertexBuffer: instanceBuffer,
      componentsPerAttribute: 1,
      componentDatatype: FLOAT,
      offsetInBytes: 28,
      strideInBytes: STAR_VERTEX_STRIDE,
      instanceDivisor: 1,
    },
  ];

  const vertexArray = new VertexArray({
    context: context,
    attributes: attributes,
    indexBuffer: indexBuffer,
  });

  const shaderProgram = ShaderProgram.fromCache({
    context: context,
    vertexShaderSource: StarFieldVS,
    fragmentShaderSource: StarFieldFS,
    attributeLocations: attributeLocations,
  });

  // Background at infinity, no depth test/write — mirrors the SkyBox
  // cubemap. The stars run in the ENVIRONMENT pass BEFORE the globe/opaque
  // passes, which overwrite them wherever solid geometry is present; with
  // the depth test disabled, the dead-ahead star can't be far-plane clipped
  // (WebGL's [-1,1] NDC z is prone to that — see StarFieldVS.glsl). The
  // blend is premultiplied additive (srcRGB = ONE) — matching the WGSL
  // pipeline; the FS premultiplies rgb by the radial falloff, so
  // SOURCE_ALPHA here would double-attenuate. cullFace disabled (the quad
  // faces the camera).
  const renderState = RenderState.fromCache({
    depthTest: {
      enabled: false,
    },
    depthMask: false,
    cull: {
      enabled: false,
    },
    blending: {
      enabled: true,
      equationRgb: BlendEquation.ADD,
      equationAlpha: BlendEquation.ADD,
      functionSourceRgb: BlendFunction.ONE,
      functionSourceAlpha: BlendFunction.ONE,
      functionDestinationRgb: BlendFunction.ONE,
      functionDestinationAlpha: BlendFunction.ONE,
    },
  });

  cache.cornerBuffer = cornerBuffer;
  cache.instanceBuffer = instanceBuffer;
  cache.indexBuffer = indexBuffer;
  cache.vertexArray = vertexArray;
  cache.shaderProgram = shaderProgram;
  cache.renderState = renderState;
  cache.starCount = BrightStarCatalog.count;
  // C7-SUN-STARS-EXTINCTION — persistent uniform-backing vectors.
  cache.zenithTransmittance = new Cartesian3(1.0, 1.0, 1.0);
  cache.cameraUpFixed = new Cartesian3(0.0, 0.0, 1.0);
  // C12-27 — persistent backing for the angular solar-glare uniforms. The
  // strength (`w = 0`) is the exact identity: the VS skips the whole block.
  cache.solarGlare = new Cartesian4(0.0, 0.0, 1.0, 0.0);
  cache.solarGlareCurve = new Cartesian4(1.0, 0.0, 0.0, 0.0);
}

/**
 * Prepares the immutable WebGL resources for the bright-star catalog without
 * submitting a draw or touching per-frame uniforms. This lets a daylight
 * frame warm the renderer so the first contributing twilight/night frame
 * does not synchronously create buffers, the VAO, or the shader program.
 *
 * @param {StarField} starField The backend-agnostic starfield primitive.
 * @param {FrameState} frameState
 * @private
 */
function prepareWebGLStarField(starField, frameState) {
  if (!starField.show) {
    return;
  }

  const context = frameState.context;
  if (!defined(context)) {
    return;
  }

  if (!defined(starField._webglCache)) {
    starField._webglCache = {};
  }
  const cache = starField._webglCache;

  if (!defined(cache.vertexArray)) {
    buildResources(context, cache);
  }
}

/**
 * Updates the WebGL starfield: builds GL resources once, refreshes the
 * per-frame uniforms, and returns one instanced draw command. The caller
 * ({@link StarField#update} → Scene → {@link EnvironmentRenderer}) executes
 * it directly in the ENVIRONMENT pass right after the SkyBox cubemap.
 *
 * @param {StarField} starField The backend-agnostic starfield primitive.
 * @param {FrameState} frameState
 * @returns {DrawCommand|undefined} The instanced draw command, or undefined.
 * @private
 */
function updateWebGLStarField(starField, frameState) {
  if (!starField.show) {
    return undefined;
  }
  const context = frameState.context;
  if (!defined(context)) {
    return undefined;
  }

  // Prepare immutable resources even when this frame contributes exactly
  // zero. The zero path remains free of per-frame uniform work and command
  // creation while avoiding a cold synchronous resource build at dusk.
  prepareWebGLStarField(starField, frameState);

  const effectiveIntensityScale = defined(starField._effectiveIntensityScale)
    ? starField._effectiveIntensityScale
    : starField._intensity *
      computeStarDayFade(
        context.uniformState.sunDirectionWC,
        frameState.camera?.positionWC,
        frameState.camera?.positionCartographic?.height,
      );
  if (effectiveIntensityScale === 0.0) {
    return undefined;
  }

  const cache = starField._webglCache;

  // Per-frame uniforms. Aspect-corrected point half-size in NDC from the
  // projection focal terms (proj[0] horizontal, proj[5] vertical) so a
  // fixed angular radius renders round on any viewport aspect — identical
  // to the WebGPU pack.
  const uniformState = context.uniformState;
  const proj = uniformState.projection;
  const angularRadius = starField._pointAngularSize; // radians
  cache.pointSizeX = angularRadius * Math.abs(proj[0]);
  cache.pointSizeY = angularRadius * Math.abs(proj[5]);

  cache.intensityScale = effectiveIntensityScale;
  cache.minPointSize = starField._minPointSize;

  // C7-SUN-STARS-EXTINCTION — per-frame zenith transmittance + camera up
  // (Earth-fixed). Published by StarField.update (shared B629 integrator).
  // ONE / no extinction when the atmosphere is hidden or from orbit → the
  // shader's pow(1, airmass) leaves every star byte-identical.
  const zenithT = frameState.starZenithTransmittance;
  if (defined(zenithT)) {
    Cartesian3.clone(zenithT, cache.zenithTransmittance);
  } else {
    Cartesian3.clone(Cartesian3.ONE, cache.zenithTransmittance);
  }
  const camPos = frameState.camera?.positionWC;
  const camLen = defined(camPos) ? Cartesian3.magnitude(camPos) : 0.0;
  if (camLen > 1.0) {
    Cartesian3.divideByScalar(camPos, camLen, cache.cameraUpFixed);
  } else {
    Cartesian3.clone(Cartesian3.UNIT_Z, cache.cameraUpFixed);
  }

  // C12-27 — angular solar-glare washout. Resolved once per frame by
  // `Scene.updateEnvironment` (`Scene/SolarGlareAppearance.js`) and read here
  // exactly as `starZenithTransmittance` is, so the WebGPU pack and this one
  // consume the identical numbers. Strength 0 (toggle off, or no resolution
  // published) makes the VS skip its whole glare block — byte-identical.
  const glare = frameState.solarGlareAppearance;
  if (defined(glare) && glare.enabled === true) {
    const sun = glare.sunDirectionTeme;
    cache.solarGlare.x = sun.x;
    cache.solarGlare.y = sun.y;
    cache.solarGlare.z = sun.z;
    cache.solarGlare.w = glare.strength;
    cache.solarGlareCurve.x = glare.angularCore;
    cache.solarGlareCurve.y = glare.pedestal;
    cache.solarGlareCurve.z = glare.support;
  } else {
    cache.solarGlare.w = 0.0;
  }

  if (!defined(cache.uniformMap)) {
    cache.uniformMap = {
      u_pointSize: function () {
        scratchPointSize.x = cache.pointSizeX;
        scratchPointSize.y = cache.pointSizeY;
        return scratchPointSize;
      },
      u_intensityScale: function () {
        return cache.intensityScale;
      },
      u_minPointSize: function () {
        return cache.minPointSize;
      },
      u_zenithTransmittance: function () {
        return cache.zenithTransmittance;
      },
      u_cameraUpFixed: function () {
        return cache.cameraUpFixed;
      },
      u_solarGlare: function () {
        return cache.solarGlare;
      },
      u_solarGlareCurve: function () {
        return cache.solarGlareCurve;
      },
    };
  }

  if (!defined(cache.command)) {
    cache.command = new DrawCommand({
      vertexArray: cache.vertexArray,
      shaderProgram: cache.shaderProgram,
      renderState: cache.renderState,
      uniformMap: cache.uniformMap,
      primitiveType: PrimitiveType.TRIANGLES,
      instanceCount: cache.starCount,
      // BV-less command — stars are directional (at infinity). Like the Sun,
      // it is executed directly by EnvironmentRenderer (not binned), so no
      // bounding volume / frustum culling is needed.
      boundingVolume: new BoundingSphere(),
      pass: Pass.ENVIRONMENT,
      owner: starField,
    });
  }
  return cache.command;
}

const scratchPointSize = { x: 0.0, y: 0.0 };

/**
 * Debug surface — returns a diagnostic snapshot of a starfield's WebGL
 * cache. Pure read; safe from Scene.getDebugSnapshot().
 *
 * @param {StarField} starField
 * @returns {object|null}
 * @private
 */
function getWebGLStarFieldStatistics(starField) {
  if (!defined(starField) || !defined(starField._webglCache)) {
    return null;
  }
  const cache = starField._webglCache;
  return {
    backend: "webgl",
    starCount: cache.starCount ?? 0,
    pipelineReady: defined(cache.shaderProgram),
    bindGroupReady: defined(cache.vertexArray),
    intensityScale: defined(cache.intensityScale) ? cache.intensityScale : null,
  };
}

/**
 * Releases the starfield's WebGL resources.
 * @param {StarField} starField
 * @private
 */
function destroyWebGLStarFieldResources(starField) {
  const cache = starField && starField._webglCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.vertexArray)) {
    cache.vertexArray.destroy();
  }
  if (defined(cache.shaderProgram)) {
    cache.shaderProgram.destroy();
  }
  // The corner/instance/index buffers are owned by the VertexArray and are
  // freed by its destroy(); nothing else to release here.
  starField._webglCache = undefined;
}

export {
  prepareWebGLStarField,
  updateWebGLStarField,
  getWebGLStarFieldStatistics,
  destroyWebGLStarFieldResources,
};

export default {
  prepareWebGLStarField,
  updateWebGLStarField,
  getWebGLStarFieldStatistics,
  destroyWebGLStarFieldResources,
};
