import BoundingRectangle from "../Core/BoundingRectangle.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import BoxOutlineGeometry from "../Core/BoxOutlineGeometry.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Color from "../Core/Color.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import defined from "../Core/defined.js";
import GeometryInstance from "../Core/GeometryInstance.js";
import Intersect from "../Core/Intersect.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import Quaternion from "../Core/Quaternion.js";
import SphereOutlineGeometry from "../Core/SphereOutlineGeometry.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import CubeMap from "../Renderer/CubeMap.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import Pass from "../Renderer/Pass.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import PixelFormat from "../Core/PixelFormat.js";
import Renderbuffer from "../Renderer/Renderbuffer.js";
import RenderbufferFormat from "../Renderer/RenderbufferFormat.js";
import RenderState from "../Renderer/RenderState.js";
import Sampler from "../Renderer/Sampler.js";
import Texture from "../Renderer/Texture.js";
import Camera from "./Camera.js";
import DebugCameraPrimitive from "./DebugCameraPrimitive.js";
import PerInstanceColorAppearance from "./PerInstanceColorAppearance.js";
import Primitive from "./Primitive.js";

// ---------- Framebuffer management ----------

function destroyFramebuffer(shadowMap) {
  const length = shadowMap._passes.length;
  for (let i = 0; i < length; ++i) {
    const pass = shadowMap._passes[i];
    const framebuffer = pass.framebuffer;
    if (defined(framebuffer) && !framebuffer.isDestroyed()) {
      framebuffer.destroy();
    }
    pass.framebuffer = undefined;
  }

  shadowMap._depthAttachment =
    shadowMap._depthAttachment && shadowMap._depthAttachment.destroy();
  shadowMap._colorAttachment =
    shadowMap._colorAttachment && shadowMap._colorAttachment.destroy();
}

function createFramebufferColor(shadowMap, context) {
  const depthRenderbuffer = new Renderbuffer({
    context: context,
    width: shadowMap._textureSize.x,
    height: shadowMap._textureSize.y,
    format: RenderbufferFormat.DEPTH_COMPONENT16,
  });

  const colorTexture = new Texture({
    context: context,
    width: shadowMap._textureSize.x,
    height: shadowMap._textureSize.y,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    sampler: Sampler.NEAREST,
  });

  const framebuffer = new Framebuffer({
    context: context,
    depthRenderbuffer: depthRenderbuffer,
    colorTextures: [colorTexture],
    destroyAttachments: false,
  });

  const length = shadowMap._passes.length;
  for (let i = 0; i < length; ++i) {
    const pass = shadowMap._passes[i];
    pass.framebuffer = framebuffer;
    pass.passState.framebuffer = framebuffer;
  }

  shadowMap._shadowMapTexture = colorTexture;
  shadowMap._depthAttachment = depthRenderbuffer;
  shadowMap._colorAttachment = colorTexture;
}

function createFramebufferDepth(shadowMap, context) {
  const depthStencilTexture = new Texture({
    context: context,
    width: shadowMap._textureSize.x,
    height: shadowMap._textureSize.y,
    pixelFormat: PixelFormat.DEPTH_STENCIL,
    pixelDatatype: PixelDatatype.UNSIGNED_INT_24_8,
    sampler: Sampler.NEAREST,
  });

  const framebuffer = new Framebuffer({
    context: context,
    depthStencilTexture: depthStencilTexture,
    destroyAttachments: false,
  });

  const length = shadowMap._passes.length;
  for (let i = 0; i < length; ++i) {
    const pass = shadowMap._passes[i];
    pass.framebuffer = framebuffer;
    pass.passState.framebuffer = framebuffer;
  }

  shadowMap._shadowMapTexture = depthStencilTexture;
  shadowMap._depthAttachment = depthStencilTexture;
}

function createFramebufferCube(shadowMap, context) {
  const depthRenderbuffer = new Renderbuffer({
    context: context,
    width: shadowMap._textureSize.x,
    height: shadowMap._textureSize.y,
    format: RenderbufferFormat.DEPTH_COMPONENT16,
  });

  const cubeMap = new CubeMap({
    context: context,
    width: shadowMap._textureSize.x,
    height: shadowMap._textureSize.y,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    sampler: Sampler.NEAREST,
  });

  const faces = [
    cubeMap.negativeX,
    cubeMap.negativeY,
    cubeMap.negativeZ,
    cubeMap.positiveX,
    cubeMap.positiveY,
    cubeMap.positiveZ,
  ];

  for (let i = 0; i < 6; ++i) {
    const framebuffer = new Framebuffer({
      context: context,
      depthRenderbuffer: depthRenderbuffer,
      colorTextures: [faces[i]],
      destroyAttachments: false,
    });
    const pass = shadowMap._passes[i];
    pass.framebuffer = framebuffer;
    pass.passState.framebuffer = framebuffer;
  }

  shadowMap._shadowMapTexture = cubeMap;
  shadowMap._depthAttachment = depthRenderbuffer;
  shadowMap._colorAttachment = cubeMap;
}

function createFramebuffer(shadowMap, context) {
  if (shadowMap._isPointLight) {
    createFramebufferCube(shadowMap, context);
  } else if (shadowMap._usesDepthTexture) {
    createFramebufferDepth(shadowMap, context);
  } else {
    createFramebufferColor(shadowMap, context);
  }
}

function checkFramebuffer(shadowMap, context) {
  if (
    shadowMap._usesDepthTexture &&
    shadowMap._passes[0].framebuffer.status !==
      WebGLConstants.FRAMEBUFFER_COMPLETE
  ) {
    shadowMap._usesDepthTexture = false;
    shadowMap._createRenderStates();
    destroyFramebuffer(shadowMap);
    createFramebuffer(shadowMap, context);
  }
}

function clearFramebuffer(shadowMap, context, shadowPass) {
  shadowPass = shadowPass ?? 0;
  if (shadowMap._isPointLight || shadowPass === 0) {
    shadowMap._clearCommand.framebuffer =
      shadowMap._passes[shadowPass].framebuffer;
    shadowMap._clearCommand.execute(context, shadowMap._clearPassState);
  }
}

function updateFramebuffer(shadowMap, context) {
  if (
    !defined(shadowMap._passes[0].framebuffer) ||
    shadowMap._shadowMapTexture.width !== shadowMap._textureSize.x
  ) {
    destroyFramebuffer(shadowMap);
    createFramebuffer(shadowMap, context);
    checkFramebuffer(shadowMap, context);
    clearFramebuffer(shadowMap, context);
  }
}

// ---------- Resize ----------

function resize(shadowMap, size) {
  shadowMap._size = size;
  const limits = shadowMap._context.limits;
  const passes = shadowMap._passes;
  const numberOfPasses = passes.length;
  const textureSize = shadowMap._textureSize;

  if (shadowMap._isPointLight) {
    size = limits.maximumCubeMapSize >= size ? size : limits.maximumCubeMapSize;
    textureSize.x = size;
    textureSize.y = size;
    const faceViewport = new BoundingRectangle(0, 0, size, size);
    passes[0].passState.viewport = faceViewport;
    passes[1].passState.viewport = faceViewport;
    passes[2].passState.viewport = faceViewport;
    passes[3].passState.viewport = faceViewport;
    passes[4].passState.viewport = faceViewport;
    passes[5].passState.viewport = faceViewport;
  } else if (numberOfPasses === 1) {
    // +----+
    // |  1 |
    // +----+
    size = limits.maximumTextureSize >= size ? size : limits.maximumTextureSize;
    textureSize.x = size;
    textureSize.y = size;
    passes[0].passState.viewport = new BoundingRectangle(0, 0, size, size);
  } else if (numberOfPasses === 4) {
    // +----+----+
    // |  3 |  4 |
    // +----+----+
    // |  1 |  2 |
    // +----+----+
    size =
      limits.maximumTextureSize >= size * 2
        ? size
        : limits.maximumTextureSize / 2;
    textureSize.x = size * 2;
    textureSize.y = size * 2;
    passes[0].passState.viewport = new BoundingRectangle(0, 0, size, size);
    passes[1].passState.viewport = new BoundingRectangle(size, 0, size, size);
    passes[2].passState.viewport = new BoundingRectangle(0, size, size, size);
    passes[3].passState.viewport = new BoundingRectangle(
      size,
      size,
      size,
      size,
    );
  }

  // Update clear pass state
  shadowMap._clearPassState.viewport = new BoundingRectangle(
    0,
    0,
    textureSize.x,
    textureSize.y,
  );

  // Transforms shadow coordinates [0, 1] into the pass's region of the texture
  for (let i = 0; i < numberOfPasses; ++i) {
    const pass = passes[i];
    const viewport = pass.passState.viewport;
    const biasX = viewport.x / textureSize.x;
    const biasY = viewport.y / textureSize.y;
    const scaleX = viewport.width / textureSize.x;
    const scaleY = viewport.height / textureSize.y;
    pass.textureOffsets = new Matrix4(
      scaleX,
      0.0,
      0.0,
      biasX,
      0.0,
      scaleY,
      0.0,
      biasY,
      0.0,
      0.0,
      1.0,
      0.0,
      0.0,
      0.0,
      0.0,
      1.0,
    );
  }
}

// ---------- Cascade computation ----------

const frustumCornersNDC = new Array(8);
frustumCornersNDC[0] = new Cartesian4(-1.0, -1.0, -1.0, 1.0);
frustumCornersNDC[1] = new Cartesian4(1.0, -1.0, -1.0, 1.0);
frustumCornersNDC[2] = new Cartesian4(1.0, 1.0, -1.0, 1.0);
frustumCornersNDC[3] = new Cartesian4(-1.0, 1.0, -1.0, 1.0);
frustumCornersNDC[4] = new Cartesian4(-1.0, -1.0, 1.0, 1.0);
frustumCornersNDC[5] = new Cartesian4(1.0, -1.0, 1.0, 1.0);
frustumCornersNDC[6] = new Cartesian4(1.0, 1.0, 1.0, 1.0);
frustumCornersNDC[7] = new Cartesian4(-1.0, 1.0, 1.0, 1.0);

const scratchMatrix = new Matrix4();
const scratchFrustumCorners = new Array(8);
for (let i = 0; i < 8; ++i) {
  scratchFrustumCorners[i] = new Cartesian4();
}

const scratchSplits = new Array(5);
const scratchFrustum = new PerspectiveFrustum();
const scratchCascadeDistances = new Array(4);
const scratchMin = new Cartesian3();
const scratchMax = new Cartesian3();

function getProjectionMatrix(frustum, clipSpaceConvention) {
  return typeof frustum.getProjectionMatrix === "function"
    ? frustum.getProjectionMatrix(clipSpaceConvention)
    : frustum.projectionMatrix;
}

function getFrustumCorner(index, clipSpaceConvention, result) {
  Cartesian4.clone(frustumCornersNDC[index], result);
  if (index < 4) {
    result.z = clipSpaceConvention.nearDepth;
  }
  return result;
}

function computeCascades(shadowMap, frameState) {
  const shadowMapCamera = shadowMap._shadowMapCamera;
  const sceneCamera = shadowMap._sceneCamera;
  const cameraNear = sceneCamera.frustum.near;
  const cameraFar = sceneCamera.frustum.far;
  const numberOfCascades = shadowMap._numberOfCascades;
  const clipSpaceConvention = shadowMap._context.clipSpaceConvention;

  // Split cascades. Use a mix of linear and log splits.
  let i;
  const range = cameraFar - cameraNear;
  const ratio = cameraFar / cameraNear;

  let lambda = 0.9;
  let clampCascadeDistances = false;

  // When the camera is close to a relatively small model, provide more detail in the closer cascades.
  // If the camera is near or inside a large model, such as the root tile of a city, then use the default values.
  // To get the most accurate cascade splits we would need to find the min and max values from the depth texture.
  if (frameState.shadowState.closestObjectSize < 200.0) {
    clampCascadeDistances = true;
    lambda = 0.9;
  }

  const cascadeDistances = scratchCascadeDistances;
  const splits = scratchSplits;
  splits[0] = cameraNear;
  splits[numberOfCascades] = cameraFar;

  // Find initial splits
  for (i = 0; i < numberOfCascades; ++i) {
    const p = (i + 1) / numberOfCascades;
    const logScale = cameraNear * Math.pow(ratio, p);
    const uniformScale = cameraNear + range * p;
    const split = CesiumMath.lerp(uniformScale, logScale, lambda);
    splits[i + 1] = split;
    cascadeDistances[i] = split - splits[i];
  }

  if (clampCascadeDistances) {
    // Clamp each cascade to its maximum distance
    for (i = 0; i < numberOfCascades; ++i) {
      cascadeDistances[i] = Math.min(
        cascadeDistances[i],
        shadowMap._maximumCascadeDistances[i],
      );
    }

    // Recompute splits
    let distance = splits[0];
    for (i = 0; i < numberOfCascades - 1; ++i) {
      distance += cascadeDistances[i];
      splits[i + 1] = distance;
    }
  }

  Cartesian4.unpack(splits, 0, shadowMap._cascadeSplits[0]);
  Cartesian4.unpack(splits, 1, shadowMap._cascadeSplits[1]);
  Cartesian4.unpack(cascadeDistances, 0, shadowMap._cascadeDistances);

  const shadowFrustum = shadowMapCamera.frustum;
  const left = shadowFrustum.left;
  const right = shadowFrustum.right;
  const bottom = shadowFrustum.bottom;
  const top = shadowFrustum.top;
  const near = shadowFrustum.near;
  const far = shadowFrustum.far;

  const position = shadowMapCamera.positionWC;
  const direction = shadowMapCamera.directionWC;
  const up = shadowMapCamera.upWC;

  const cascadeSubFrustum = sceneCamera.frustum.clone(scratchFrustum);
  const shadowViewProjection = shadowMapCamera.getViewProjection();

  for (i = 0; i < numberOfCascades; ++i) {
    // Find the bounding box of the camera sub-frustum in shadow map texture space
    cascadeSubFrustum.near = splits[i];
    cascadeSubFrustum.far = splits[i + 1];
    const viewProjection = Matrix4.multiply(
      getProjectionMatrix(cascadeSubFrustum, clipSpaceConvention),
      sceneCamera.viewMatrix,
      scratchMatrix,
    );
    const inverseViewProjection = Matrix4.inverse(
      viewProjection,
      scratchMatrix,
    );
    const shadowMapMatrix = Matrix4.multiply(
      shadowViewProjection,
      inverseViewProjection,
      scratchMatrix,
    );

    // Project each corner from camera NDC space to shadow map texture space. Min and max will be from 0 to 1.
    const min = Cartesian3.fromElements(
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      scratchMin,
    );
    const max = Cartesian3.fromElements(
      -Number.MAX_VALUE,
      -Number.MAX_VALUE,
      -Number.MAX_VALUE,
      scratchMax,
    );

    for (let k = 0; k < 8; ++k) {
      const corner = getFrustumCorner(
        k,
        clipSpaceConvention,
        scratchFrustumCorners[k],
      );
      Matrix4.multiplyByVector(shadowMapMatrix, corner, corner);
      Cartesian3.divideByScalar(corner, corner.w, corner); // Handle the perspective divide
      Cartesian3.minimumByComponent(corner, min, min);
      Cartesian3.maximumByComponent(corner, max, max);
    }

    // Limit light-space coordinates to the [0, 1] range
    min.x = Math.max(min.x, 0.0);
    min.y = Math.max(min.y, 0.0);
    min.z = 0.0; // Always start cascade frustum at the top of the light frustum to capture objects in the light's path
    max.x = Math.min(max.x, 1.0);
    max.y = Math.min(max.y, 1.0);
    max.z = Math.min(max.z, 1.0);

    const pass = shadowMap._passes[i];
    const cascadeCamera = pass.camera;
    cascadeCamera.clone(shadowMapCamera); // PERFORMANCE_IDEA : could do a shallow clone for all properties except the frustum

    const frustum = cascadeCamera.frustum;
    frustum.left = left + min.x * (right - left);
    frustum.right = left + max.x * (right - left);
    frustum.bottom = bottom + min.y * (top - bottom);
    frustum.top = bottom + max.y * (top - bottom);
    frustum.near = near + min.z * (far - near);
    frustum.far = near + max.z * (far - near);

    pass.cullingVolume = cascadeCamera.frustum.computeCullingVolume(
      position,
      direction,
      up,
    );

    // Transforms from eye space to the cascade's texture space
    const cascadeMatrix = shadowMap._cascadeMatrices[i];
    Matrix4.multiply(
      cascadeCamera.getViewProjection(),
      sceneCamera.inverseViewMatrix,
      cascadeMatrix,
    );
    Matrix4.multiply(pass.textureOffsets, cascadeMatrix, cascadeMatrix);
  }
}

// ---------- Light fitting ----------

const scratchLightView = new Matrix4();
const scratchRight = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchTranslation = new Cartesian3();

function fitShadowMapToScene(shadowMap, frameState) {
  const shadowMapCamera = shadowMap._shadowMapCamera;
  const sceneCamera = shadowMap._sceneCamera;
  const clipSpaceConvention = shadowMap._context.clipSpaceConvention;

  // 1. First find a tight bounding box in light space that contains the entire camera frustum.
  const viewProjection = Matrix4.multiply(
    getProjectionMatrix(sceneCamera.frustum, clipSpaceConvention),
    sceneCamera.viewMatrix,
    scratchMatrix,
  );
  const inverseViewProjection = Matrix4.inverse(viewProjection, scratchMatrix);

  // Start to construct the light view matrix. Set translation later once the bounding box is found.
  const lightDir = shadowMapCamera.directionWC;
  let lightUp = sceneCamera.directionWC; // Align shadows to the camera view.
  if (Cartesian3.equalsEpsilon(lightDir, lightUp, CesiumMath.EPSILON10)) {
    lightUp = sceneCamera.upWC;
  }
  const lightRight = Cartesian3.cross(lightDir, lightUp, scratchRight);
  lightUp = Cartesian3.cross(lightRight, lightDir, scratchUp); // Recalculate up now that right is derived
  Cartesian3.normalize(lightUp, lightUp);
  Cartesian3.normalize(lightRight, lightRight);
  const lightPosition = Cartesian3.fromElements(
    0.0,
    0.0,
    0.0,
    scratchTranslation,
  );

  let lightView = Matrix4.computeView(
    lightPosition,
    lightDir,
    lightUp,
    lightRight,
    scratchLightView,
  );
  const cameraToLight = Matrix4.multiply(
    lightView,
    inverseViewProjection,
    scratchMatrix,
  );

  // Project each corner from NDC space to light view space, and calculate a min and max in light view space
  const min = Cartesian3.fromElements(
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    scratchMin,
  );
  const max = Cartesian3.fromElements(
    -Number.MAX_VALUE,
    -Number.MAX_VALUE,
    -Number.MAX_VALUE,
    scratchMax,
  );

  for (let i = 0; i < 8; ++i) {
    const corner = getFrustumCorner(
      i,
      clipSpaceConvention,
      scratchFrustumCorners[i],
    );
    Matrix4.multiplyByVector(cameraToLight, corner, corner);
    Cartesian3.divideByScalar(corner, corner.w, corner); // Handle the perspective divide
    Cartesian3.minimumByComponent(corner, min, min);
    Cartesian3.maximumByComponent(corner, max, max);
  }

  // 2. Set bounding box back to include objects in the light's view
  max.z += 1000.0; // Note: in light space, a positive number is behind the camera
  min.z -= 10.0; // Extend the shadow volume forward slightly to avoid problems right at the edge

  // 3. Adjust light view matrix so that it is centered on the bounding volume
  const translation = scratchTranslation;
  translation.x = -(0.5 * (min.x + max.x));
  translation.y = -(0.5 * (min.y + max.y));
  translation.z = -max.z;

  const translationMatrix = Matrix4.fromTranslation(translation, scratchMatrix);
  lightView = Matrix4.multiply(translationMatrix, lightView, lightView);

  // 4. Create an orthographic frustum that covers the bounding box extents
  const halfWidth = 0.5 * (max.x - min.x);
  const halfHeight = 0.5 * (max.y - min.y);
  const depth = max.z - min.z;

  const frustum = shadowMapCamera.frustum;
  frustum.left = -halfWidth;
  frustum.right = halfWidth;
  frustum.bottom = -halfHeight;
  frustum.top = halfHeight;
  frustum.near = 0.01;
  frustum.far = depth;

  // 5. Update the shadow map camera
  Matrix4.clone(lightView, shadowMapCamera.viewMatrix);
  Matrix4.inverse(lightView, shadowMapCamera.inverseViewMatrix);
  Matrix4.getTranslation(
    shadowMapCamera.inverseViewMatrix,
    shadowMapCamera.positionWC,
  );
  frameState.mapProjection.ellipsoid.cartesianToCartographic(
    shadowMapCamera.positionWC,
    shadowMapCamera.positionCartographic,
  );
  Cartesian3.clone(lightDir, shadowMapCamera.directionWC);
  Cartesian3.clone(lightUp, shadowMapCamera.upWC);
  Cartesian3.clone(lightRight, shadowMapCamera.rightWC);
}

// ---------- Omnidirectional (point light) ----------

const directions = [
  new Cartesian3(-1.0, 0.0, 0.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(0.0, 1.0, 0.0),
  new Cartesian3(0.0, 0.0, 1.0),
];

const ups = [
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, 1.0),
  new Cartesian3(0.0, -1.0, 0.0),
];

const rights = [
  new Cartesian3(0.0, 0.0, 1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(-1.0, 0.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(1.0, 0.0, 0.0),
];

function computeOmnidirectional(shadowMap, frameState) {
  // All sides share the same frustum
  const frustum = new PerspectiveFrustum();
  frustum.fov = CesiumMath.PI_OVER_TWO;
  frustum.near = 1.0;
  frustum.far = shadowMap._pointLightRadius;
  frustum.aspectRatio = 1.0;

  for (let i = 0; i < 6; ++i) {
    const camera = shadowMap._passes[i].camera;
    camera.positionWC = shadowMap._shadowMapCamera.positionWC;
    camera.positionCartographic =
      frameState.mapProjection.ellipsoid.cartesianToCartographic(
        camera.positionWC,
        camera.positionCartographic,
      );
    camera.directionWC = directions[i];
    camera.upWC = ups[i];
    camera.rightWC = rights[i];

    Matrix4.computeView(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
      camera.rightWC,
      camera.viewMatrix,
    );
    Matrix4.inverse(camera.viewMatrix, camera.inverseViewMatrix);

    camera.frustum = frustum;
  }
}

// ---------- Visibility ----------

const scratchCartesian1 = new Cartesian3();
const scratchCartesian2 = new Cartesian3();
const scratchBoundingSphere = new BoundingSphere();
const scratchCenter = scratchBoundingSphere.center;

function checkVisibility(shadowMap, frameState) {
  const sceneCamera = shadowMap._sceneCamera;
  const shadowMapCamera = shadowMap._shadowMapCamera;

  const boundingSphere = scratchBoundingSphere;

  // Check whether the shadow map is in view and needs to be updated
  if (shadowMap._cascadesEnabled) {
    // If the nearest shadow receiver is further than the shadow map's maximum distance then the shadow map is out of view.
    if (sceneCamera.frustum.near >= shadowMap.maximumDistance) {
      shadowMap._outOfView = true;
      shadowMap._needsUpdate = false;
      return;
    }

    // If the light source is below the horizon then the shadow map is out of view
    const surfaceNormal =
      frameState.mapProjection.ellipsoid.geodeticSurfaceNormal(
        sceneCamera.positionWC,
        scratchCartesian1,
      );
    const lightDirection = Cartesian3.negate(
      shadowMapCamera.directionWC,
      scratchCartesian2,
    );
    const dot = Cartesian3.dot(surfaceNormal, lightDirection);
    if (shadowMap.fadingEnabled) {
      // Shadows start to fade out once the light gets closer to the horizon.
      // At this point the globe uses vertex lighting alone to darken the surface.
      const darknessAmount = CesiumMath.clamp(dot / 0.1, 0.0, 1.0);
      shadowMap._darkness = CesiumMath.lerp(
        1.0,
        shadowMap.darkness,
        darknessAmount,
      );
    } else {
      shadowMap._darkness = shadowMap.darkness;
    }

    if (dot < 0.0) {
      shadowMap._outOfView = true;
      shadowMap._needsUpdate = false;
      return;
    }

    // By default cascaded shadows need to update and are always in view
    shadowMap._needsUpdate = true;
    shadowMap._outOfView = false;
  } else if (shadowMap._isPointLight) {
    // Sphere-frustum intersection test
    boundingSphere.center = shadowMapCamera.positionWC;
    boundingSphere.radius = shadowMap._pointLightRadius;
    shadowMap._outOfView =
      frameState.cullingVolume.computeVisibility(boundingSphere) ===
      Intersect.OUTSIDE;
    shadowMap._needsUpdate =
      !shadowMap._outOfView &&
      !shadowMap._boundingSphere.equals(boundingSphere);
    BoundingSphere.clone(boundingSphere, shadowMap._boundingSphere);
  } else {
    // Simplify frustum-frustum intersection test as a sphere-frustum test
    const frustumRadius = shadowMapCamera.frustum.far / 2.0;
    const frustumCenter = Cartesian3.add(
      shadowMapCamera.positionWC,
      Cartesian3.multiplyByScalar(
        shadowMapCamera.directionWC,
        frustumRadius,
        scratchCenter,
      ),
      scratchCenter,
    );
    boundingSphere.center = frustumCenter;
    boundingSphere.radius = frustumRadius;
    shadowMap._outOfView =
      frameState.cullingVolume.computeVisibility(boundingSphere) ===
      Intersect.OUTSIDE;
    shadowMap._needsUpdate =
      !shadowMap._outOfView &&
      !shadowMap._boundingSphere.equals(boundingSphere);
    BoundingSphere.clone(boundingSphere, shadowMap._boundingSphere);
  }
}

// ---------- Camera updates ----------

function updateCameras(shadowMap, frameState) {
  const camera = frameState.camera; // The actual camera in the scene
  const lightCamera = shadowMap._lightCamera; // The external camera representing the light source
  const sceneCamera = shadowMap._sceneCamera; // Clone of camera, with clamped near and far planes
  const shadowMapCamera = shadowMap._shadowMapCamera; // Camera representing the shadow volume, initially cloned from lightCamera

  // Clone light camera into the shadow map camera
  if (shadowMap._cascadesEnabled) {
    Cartesian3.clone(lightCamera.directionWC, shadowMapCamera.directionWC);
  } else if (shadowMap._isPointLight) {
    Cartesian3.clone(lightCamera.positionWC, shadowMapCamera.positionWC);
  } else {
    shadowMapCamera.clone(lightCamera);
  }

  // Get the light direction in eye coordinates
  const lightDirection = shadowMap._lightDirectionEC;
  Matrix4.multiplyByPointAsVector(
    camera.viewMatrix,
    shadowMapCamera.directionWC,
    lightDirection,
  );
  Cartesian3.normalize(lightDirection, lightDirection);
  Cartesian3.negate(lightDirection, lightDirection);

  // Get the light position in eye coordinates
  Matrix4.multiplyByPoint(
    camera.viewMatrix,
    shadowMapCamera.positionWC,
    shadowMap._lightPositionEC,
  );
  shadowMap._lightPositionEC.w = shadowMap._pointLightRadius;

  // Get the near and far of the scene camera
  let near;
  let far;
  if (shadowMap._fitNearFar) {
    // shadowFar can be very large, so limit to shadowMap.maximumDistance
    // Push the far plane slightly further than the near plane to avoid degenerate frustum
    near = Math.min(
      frameState.shadowState.nearPlane,
      shadowMap.maximumDistance,
    );
    far = Math.min(frameState.shadowState.farPlane, shadowMap.maximumDistance);
    far = Math.max(far, near + 1.0);
  } else {
    near = camera.frustum.near;
    far = shadowMap.maximumDistance;
  }

  shadowMap._sceneCamera = Camera.clone(camera, sceneCamera);
  camera.frustum.clone(shadowMap._sceneCamera.frustum);
  shadowMap._sceneCamera.frustum.near = near;
  shadowMap._sceneCamera.frustum.far = far;
  shadowMap._distance = far - near;

  checkVisibility(shadowMap, frameState);

  if (!shadowMap._outOfViewPrevious && shadowMap._outOfView) {
    shadowMap._needsUpdate = true;
  }
  shadowMap._outOfViewPrevious = shadowMap._outOfView;
}

// ---------- Debug visualization ----------

const scratchViewport = new BoundingRectangle();
const scratchScale = new Cartesian3();
const debugOutlineColors = [Color.RED, Color.GREEN, Color.BLUE, Color.MAGENTA];

function createDebugShadowViewCommand(shadowMap, context) {
  let fs;
  if (shadowMap._isPointLight) {
    fs = `uniform samplerCube shadowMap_textureCube;
in vec2 v_textureCoordinates;
void main() {
    vec2 uv = v_textureCoordinates;
    vec3 dir;
    if (uv.y < 0.5) {
        if (uv.x < 0.333) { dir.x = -1.0; dir.y = uv.x * 6.0 - 1.0; dir.z = uv.y * 4.0 - 1.0; }
        else if (uv.x < 0.666) { dir.y = -1.0; dir.x = uv.x * 6.0 - 3.0; dir.z = uv.y * 4.0 - 1.0; }
        else { dir.z = -1.0; dir.x = uv.x * 6.0 - 5.0; dir.y = uv.y * 4.0 - 1.0; }
    } else {
        if (uv.x < 0.333) { dir.x = 1.0; dir.y = uv.x * 6.0 - 1.0; dir.z = uv.y * 4.0 - 3.0; }
        else if (uv.x < 0.666) { dir.y = 1.0; dir.x = uv.x * 6.0 - 3.0; dir.z = uv.y * 4.0 - 3.0; }
        else { dir.z = 1.0; dir.x = uv.x * 6.0 - 5.0; dir.y = uv.y * 4.0 - 3.0; }
    }
    float shadow = czm_unpackDepth(czm_textureCube(shadowMap_textureCube, dir));
    out_FragColor = vec4(vec3(shadow), 1.0);
}`;
  } else {
    const sampleLine = shadowMap._usesDepthTexture
      ? "    float shadow = texture(shadowMap_texture, v_textureCoordinates).r;"
      : "    float shadow = czm_unpackDepth(texture(shadowMap_texture, v_textureCoordinates));";
    fs = `uniform sampler2D shadowMap_texture;
in vec2 v_textureCoordinates;
void main() {
${sampleLine}
    out_FragColor = vec4(vec3(shadow), 1.0);
}`;
  }

  const drawCommand = context.createViewportQuadCommand(fs, {
    uniformMap: {
      shadowMap_texture: function () {
        return shadowMap._shadowMapTexture;
      },
      shadowMap_textureCube: function () {
        return shadowMap._shadowMapTexture;
      },
    },
  });
  drawCommand.pass = Pass.OVERLAY;
  return drawCommand;
}

function updateDebugShadowViewCommand(shadowMap, frameState) {
  // Draws the shadow map on the bottom-right corner of the screen
  const context = frameState.context;
  const screenWidth = frameState.context.drawingBufferWidth;
  const screenHeight = frameState.context.drawingBufferHeight;
  const size = Math.min(screenWidth, screenHeight) * 0.3;

  const viewport = scratchViewport;
  viewport.x = screenWidth - size;
  viewport.y = 0;
  viewport.width = size;
  viewport.height = size;

  let debugCommand = shadowMap._debugShadowViewCommand;
  if (!defined(debugCommand)) {
    debugCommand = createDebugShadowViewCommand(shadowMap, context);
    shadowMap._debugShadowViewCommand = debugCommand;
  }

  if (
    !defined(debugCommand.renderState) ||
    !BoundingRectangle.equals(debugCommand.renderState.viewport, viewport)
  ) {
    debugCommand.renderState = RenderState.fromCache({
      viewport: BoundingRectangle.clone(viewport),
    });
  }

  frameState.commandList.push(shadowMap._debugShadowViewCommand);
}

function createDebugPointLight(modelMatrix, color) {
  const box = new GeometryInstance({
    geometry: new BoxOutlineGeometry({
      minimum: new Cartesian3(-0.5, -0.5, -0.5),
      maximum: new Cartesian3(0.5, 0.5, 0.5),
    }),
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
  });

  const sphere = new GeometryInstance({
    geometry: new SphereOutlineGeometry({
      radius: 0.5,
    }),
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
  });

  return new Primitive({
    geometryInstances: [box, sphere],
    appearance: new PerInstanceColorAppearance({
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
    modelMatrix: modelMatrix,
  });
}

function applyDebugSettings(shadowMap, frameState) {
  updateDebugShadowViewCommand(shadowMap, frameState);

  const enterFreezeFrame =
    shadowMap.debugFreezeFrame && !shadowMap._debugFreezeFrame;
  shadowMap._debugFreezeFrame = shadowMap.debugFreezeFrame;

  if (shadowMap.debugFreezeFrame) {
    if (enterFreezeFrame) {
      shadowMap._debugCameraFrustum =
        shadowMap._debugCameraFrustum &&
        shadowMap._debugCameraFrustum.destroy();
      shadowMap._debugCameraFrustum = new DebugCameraPrimitive({
        camera: shadowMap._sceneCamera,
        color: Color.CYAN,
        updateOnChange: false,
      });
    }
    shadowMap._debugCameraFrustum.update(frameState);
  }

  if (shadowMap._cascadesEnabled) {
    if (shadowMap.debugFreezeFrame) {
      if (enterFreezeFrame) {
        shadowMap._debugLightFrustum =
          shadowMap._debugLightFrustum &&
          shadowMap._debugLightFrustum.destroy();
        shadowMap._debugLightFrustum = new DebugCameraPrimitive({
          camera: shadowMap._shadowMapCamera,
          color: Color.YELLOW,
          updateOnChange: false,
        });
      }
      shadowMap._debugLightFrustum.update(frameState);

      for (let i = 0; i < shadowMap._numberOfCascades; ++i) {
        if (enterFreezeFrame) {
          shadowMap._debugCascadeFrustums[i] =
            shadowMap._debugCascadeFrustums[i] &&
            shadowMap._debugCascadeFrustums[i].destroy();
          shadowMap._debugCascadeFrustums[i] = new DebugCameraPrimitive({
            camera: shadowMap._passes[i].camera,
            color: debugOutlineColors[i],
            updateOnChange: false,
          });
        }
        shadowMap._debugCascadeFrustums[i].update(frameState);
      }
    }
  } else if (shadowMap._isPointLight) {
    if (!defined(shadowMap._debugLightFrustum) || shadowMap._needsUpdate) {
      const translation = shadowMap._shadowMapCamera.positionWC;
      const rotation = Quaternion.IDENTITY;
      const uniformScale = shadowMap._pointLightRadius * 2.0;
      const scale = Cartesian3.fromElements(
        uniformScale,
        uniformScale,
        uniformScale,
        scratchScale,
      );
      const modelMatrix = Matrix4.fromTranslationQuaternionRotationScale(
        translation,
        rotation,
        scale,
        scratchMatrix,
      );

      shadowMap._debugLightFrustum =
        shadowMap._debugLightFrustum && shadowMap._debugLightFrustum.destroy();
      shadowMap._debugLightFrustum = createDebugPointLight(
        modelMatrix,
        Color.YELLOW,
      );
    }
    shadowMap._debugLightFrustum.update(frameState);
  } else {
    if (!defined(shadowMap._debugLightFrustum) || shadowMap._needsUpdate) {
      shadowMap._debugLightFrustum = new DebugCameraPrimitive({
        camera: shadowMap._shadowMapCamera,
        color: Color.YELLOW,
        updateOnChange: false,
      });
    }
    shadowMap._debugLightFrustum.update(frameState);
  }
}

export {
  destroyFramebuffer,
  updateFramebuffer,
  clearFramebuffer,
  resize,
  updateCameras,
  computeCascades,
  fitShadowMapToScene,
  computeOmnidirectional,
  applyDebugSettings,
};

// Namespace default export for build system barrel compatibility
const ShadowMapComputations = {
  destroyFramebuffer,
  updateFramebuffer,
  clearFramebuffer,
  resize,
  updateCameras,
  computeCascades,
  fitShadowMapToScene,
  computeOmnidirectional,
  applyDebugSettings,
};
export default ShadowMapComputations;
