import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import clone from "../Core/clone.js";
import combine from "../Core/combine.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import CullFace from "./CullFace.js";
import DepthFunction from "./DepthFunction.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import {
  modifyShaderPosition,
  appendShowToShader,
  updateColorAttribute,
  appendPickToVertexShader,
  appendPickToFragmentShader,
  appendOffsetToShader,
  appendDistanceDisplayConditionToShader,
  modifyForEncodedNormals,
  depthClampVS,
  depthClampFS,
  validateShaderMatching,
} from "./PrimitiveShaderHelpers.js";

/**
 * Command creation, render state, shader program, uniform, and bounding
 * volume helpers for Primitive.
 *
 * Extracted from Primitive.js to keep the main class under 1000 lines.
 *
 * @private
 */

function createRenderStates(primitive, context, appearance, twoPasses) {
  let renderState = appearance.getRenderState();
  let rs;

  if (twoPasses) {
    rs = clone(renderState, false);
    rs.cull = {
      enabled: true,
      face: CullFace.BACK,
    };
    primitive._frontFaceRS = RenderState.fromCache(rs);

    rs.cull.face = CullFace.FRONT;
    primitive._backFaceRS = RenderState.fromCache(rs);
  } else {
    primitive._frontFaceRS = RenderState.fromCache(renderState);
    primitive._backFaceRS = primitive._frontFaceRS;
  }

  rs = clone(renderState, false);
  if (defined(primitive._depthFailAppearance)) {
    rs.depthTest.enabled = false;
  }

  if (defined(primitive._depthFailAppearance)) {
    renderState = primitive._depthFailAppearance.getRenderState();
    rs = clone(renderState, false);
    rs.depthTest.func = DepthFunction.GREATER;
    if (twoPasses) {
      rs.cull = {
        enabled: true,
        face: CullFace.BACK,
      };
      primitive._frontFaceDepthFailRS = RenderState.fromCache(rs);

      rs.cull.face = CullFace.FRONT;
      primitive._backFaceDepthFailRS = RenderState.fromCache(rs);
    } else {
      primitive._frontFaceDepthFailRS = RenderState.fromCache(rs);
      primitive._backFaceDepthFailRS = primitive._frontFaceRS;
    }
  }
}

function createShaderProgram(primitive, frameState, appearance) {
  const context = frameState.context;
  const attributeLocations = primitive._attributeLocations;

  let vs = primitive._batchTable.getVertexShaderCallback()(
    appearance.vertexShaderSource,
  );
  vs = appendOffsetToShader(primitive, vs);
  vs = appendShowToShader(primitive, vs);
  vs = appendDistanceDisplayConditionToShader(
    primitive,
    vs,
    frameState.scene3DOnly,
  );
  vs = appendPickToVertexShader(vs);
  vs = updateColorAttribute(primitive, vs, false);
  vs = modifyForEncodedNormals(primitive, vs);
  vs = modifyShaderPosition(primitive, vs, frameState.scene3DOnly);
  let fs = appearance.getFragmentShaderSource();
  fs = appendPickToFragmentShader(fs);

  primitive._sp = ShaderProgram.replaceCache({
    context: context,
    shaderProgram: primitive._sp,
    vertexShaderSource: vs,
    fragmentShaderSource: fs,
    attributeLocations: attributeLocations,
  });
  validateShaderMatching(primitive._sp, attributeLocations);

  if (defined(primitive._depthFailAppearance)) {
    vs = primitive._batchTable.getVertexShaderCallback()(
      primitive._depthFailAppearance.vertexShaderSource,
    );
    vs = appendShowToShader(primitive, vs);
    vs = appendDistanceDisplayConditionToShader(
      primitive,
      vs,
      frameState.scene3DOnly,
    );
    vs = appendPickToVertexShader(vs);
    vs = updateColorAttribute(primitive, vs, true);
    vs = modifyForEncodedNormals(primitive, vs);
    vs = modifyShaderPosition(primitive, vs, frameState.scene3DOnly);
    vs = depthClampVS(vs);

    fs = primitive._depthFailAppearance.getFragmentShaderSource();
    fs = appendPickToFragmentShader(fs);
    fs = depthClampFS(fs);

    primitive._spDepthFail = ShaderProgram.replaceCache({
      context: context,
      shaderProgram: primitive._spDepthFail,
      vertexShaderSource: vs,
      fragmentShaderSource: fs,
      attributeLocations: attributeLocations,
    });
    validateShaderMatching(primitive._spDepthFail, attributeLocations);
  }
}

const modifiedModelViewScratch = new Matrix4();
const rtcScratch = new Cartesian3();

function getUniformFunction(uniforms, name) {
  return function () {
    return uniforms[name];
  };
}

function getUniforms(primitive, appearance, material, frameState) {
  const materialUniformMap = defined(material) ? material._uniforms : undefined;
  const appearanceUniformMap = {};
  const appearanceUniforms = appearance.uniforms;
  if (defined(appearanceUniforms)) {
    for (const name in appearanceUniforms) {
      if (Object.hasOwn(appearanceUniforms, name)) {
        //>>includeStart('debug', pragmas.debug);
        if (defined(materialUniformMap) && defined(materialUniformMap[name])) {
          throw new DeveloperError(
            `Appearance and material have a uniform with the same name: ${name}`,
          );
        }
        //>>includeEnd('debug');

        appearanceUniformMap[name] = getUniformFunction(
          appearanceUniforms,
          name,
        );
      }
    }
  }
  let uniforms = combine(appearanceUniformMap, materialUniformMap);
  uniforms = primitive._batchTable.getUniformMapCallback()(uniforms);

  if (defined(primitive.rtcCenter)) {
    uniforms.u_modifiedModelView = function () {
      const viewMatrix = frameState.context.uniformState.view;
      Matrix4.multiply(
        viewMatrix,
        primitive._modelMatrix,
        modifiedModelViewScratch,
      );
      Matrix4.multiplyByPoint(
        modifiedModelViewScratch,
        primitive.rtcCenter,
        rtcScratch,
      );
      Matrix4.setTranslation(
        modifiedModelViewScratch,
        rtcScratch,
        modifiedModelViewScratch,
      );
      return modifiedModelViewScratch;
    };
  }

  return uniforms;
}

function createWebGLCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const uniforms = getUniforms(primitive, appearance, material, frameState);

  let depthFailUniforms;
  if (defined(primitive._depthFailAppearance)) {
    depthFailUniforms = getUniforms(
      primitive,
      primitive._depthFailAppearance,
      primitive._depthFailAppearance.material,
      frameState,
    );
  }

  const pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

  let multiplier = twoPasses ? 2 : 1;
  multiplier *= defined(primitive._depthFailAppearance) ? 2 : 1;
  colorCommands.length = primitive._va.length * multiplier;

  const length = colorCommands.length;
  let vaIndex = 0;
  for (let i = 0; i < length; ++i) {
    let colorCommand;

    if (twoPasses) {
      colorCommand = colorCommands[i];
      if (!defined(colorCommand)) {
        colorCommand = colorCommands[i] = new DrawCommand({
          owner: primitive,
          primitiveType: primitive._primitiveType,
        });
      }
      colorCommand.vertexArray = primitive._va[vaIndex];
      colorCommand.renderState = primitive._backFaceRS;
      colorCommand.shaderProgram = primitive._sp;
      colorCommand.uniformMap = uniforms;
      colorCommand.pass = pass;

      ++i;
    }

    colorCommand = colorCommands[i];
    if (!defined(colorCommand)) {
      colorCommand = colorCommands[i] = new DrawCommand({
        owner: primitive,
        primitiveType: primitive._primitiveType,
      });
    }
    colorCommand.vertexArray = primitive._va[vaIndex];
    colorCommand.renderState = primitive._frontFaceRS;
    colorCommand.shaderProgram = primitive._sp;
    colorCommand.uniformMap = uniforms;
    colorCommand.pass = pass;

    if (defined(primitive._depthFailAppearance)) {
      if (twoPasses) {
        ++i;

        colorCommand = colorCommands[i];
        if (!defined(colorCommand)) {
          colorCommand = colorCommands[i] = new DrawCommand({
            owner: primitive,
            primitiveType: primitive._primitiveType,
          });
        }
        colorCommand.vertexArray = primitive._va[vaIndex];
        colorCommand.renderState = primitive._backFaceDepthFailRS;
        colorCommand.shaderProgram = primitive._spDepthFail;
        colorCommand.uniformMap = depthFailUniforms;
        colorCommand.pass = pass;
      }

      ++i;

      colorCommand = colorCommands[i];
      if (!defined(colorCommand)) {
        colorCommand = colorCommands[i] = new DrawCommand({
          owner: primitive,
          primitiveType: primitive._primitiveType,
        });
      }
      colorCommand.vertexArray = primitive._va[vaIndex];
      colorCommand.renderState = primitive._frontFaceDepthFailRS;
      colorCommand.shaderProgram = primitive._spDepthFail;
      colorCommand.uniformMap = depthFailUniforms;
      colorCommand.pass = pass;
    }

    ++vaIndex;
  }
}

function createCommands(
  primitive,
  appearance,
  material,
  translucent,
  twoPasses,
  colorCommands,
  pickCommands,
  frameState,
) {
  const fr = frameState.context.getFeatureRenderer(
    FeatureRendererKey.PRIMITIVE,
  );

  if (fr) {
    const hasMaterial = defined(material);
    const createFn = hasMaterial
      ? fr.createMaterialCommands
      : fr.createCommands;
    createFn(
      primitive,
      appearance,
      material,
      translucent,
      twoPasses,
      colorCommands,
      pickCommands,
      frameState,
    );
  } else {
    createWebGLCommands(
      primitive,
      appearance,
      material,
      translucent,
      twoPasses,
      colorCommands,
      pickCommands,
      frameState,
    );
  }
}

function updateBoundingVolumes(
  primitive,
  frameState,
  modelMatrix,
  forceUpdate,
) {
  let i;
  let length;
  let boundingSphere;

  if (forceUpdate || !Matrix4.equals(modelMatrix, primitive._modelMatrix)) {
    Matrix4.clone(modelMatrix, primitive._modelMatrix);
    length = primitive._boundingSpheres.length;
    for (i = 0; i < length; ++i) {
      boundingSphere = primitive._boundingSpheres[i];
      if (defined(boundingSphere)) {
        primitive._boundingSphereWC[i] = BoundingSphere.transform(
          boundingSphere,
          modelMatrix,
          primitive._boundingSphereWC[i],
        );
        if (!frameState.scene3DOnly) {
          primitive._boundingSphere2D[i] = BoundingSphere.clone(
            primitive._boundingSphereCV[i],
            primitive._boundingSphere2D[i],
          );
          primitive._boundingSphereMorph[i] = BoundingSphere.union(
            primitive._boundingSphereWC[i],
            primitive._boundingSphereCV[i],
          );
        }
      }
    }
  }

  // Update bounding volumes for primitives that are sized in pixels.
  const pixelSize = primitive.appearance.pixelSize;
  if (defined(pixelSize)) {
    length = primitive._boundingSpheres.length;
    for (i = 0; i < length; ++i) {
      boundingSphere = primitive._boundingSpheres[i];
      const boundingSphereWC = primitive._boundingSphereWC[i];
      const pixelSizeInMeters = frameState.camera.getPixelSize(
        boundingSphere,
        frameState.context.drawingBufferWidth,
        frameState.context.drawingBufferHeight,
      );
      const sizeInMeters = pixelSizeInMeters * pixelSize;
      boundingSphereWC.radius = boundingSphere.radius + sizeInMeters;
    }
  }
}

function updateAndQueueCommands(
  primitive,
  frameState,
  colorCommands,
  pickCommands,
  modelMatrix,
  cull,
  debugShowBoundingVolume,
  twoPasses,
) {
  //>>includeStart('debug', pragmas.debug);
  if (
    frameState.mode !== SceneMode.SCENE3D &&
    !Matrix4.equals(modelMatrix, Matrix4.IDENTITY)
  ) {
    throw new DeveloperError(
      "Primitive.modelMatrix is only supported in 3D mode.",
    );
  }
  //>>includeEnd('debug');

  updateBoundingVolumes(primitive, frameState, modelMatrix);

  let boundingSpheres;
  if (frameState.mode === SceneMode.SCENE3D) {
    boundingSpheres = primitive._boundingSphereWC;
  } else if (frameState.mode === SceneMode.COLUMBUS_VIEW) {
    boundingSpheres = primitive._boundingSphereCV;
  } else if (
    frameState.mode === SceneMode.SCENE2D &&
    defined(primitive._boundingSphere2D)
  ) {
    boundingSpheres = primitive._boundingSphere2D;
  } else if (defined(primitive._boundingSphereMorph)) {
    boundingSpheres = primitive._boundingSphereMorph;
  }

  const commandList = frameState.commandList;
  const passes = frameState.passes;
  if (passes.render || passes.pick) {
    const allowPicking = primitive.allowPicking;
    const castShadows = ShadowMode.castShadows(primitive.shadows);
    const receiveShadows = ShadowMode.receiveShadows(primitive.shadows);
    const colorLength = colorCommands.length;

    let factor = twoPasses ? 2 : 1;
    factor *= defined(primitive._depthFailAppearance) ? 2 : 1;

    for (let j = 0; j < colorLength; ++j) {
      const colorCommand = colorCommands[j];

      if (!defined(colorCommand)) {
        continue;
      }

      // Alternate renderer: Update uniform buffers with current camera matrices every frame.
      // Uses duck-typing (check for _webgpuShaderType) instead of backend type check.
      if (defined(colorCommand._webgpuShaderType)) {
        const pfr = frameState.context.getFeatureRenderer(
          FeatureRendererKey.PRIMITIVE,
        );
        if (pfr) {
          const st = colorCommand._webgpuShaderType;
          if (st.startsWith("mat") || st.startsWith("pbr")) {
            pfr.updateMaterialCommandUniforms(
              colorCommand,
              frameState,
              modelMatrix,
            );
          } else {
            pfr.updateCommandUniforms(colorCommand, frameState, modelMatrix);
          }
        }
      }

      const sphereIndex = Math.floor(j / factor);
      colorCommand.modelMatrix = modelMatrix;
      colorCommand.boundingVolume = boundingSpheres[sphereIndex];
      colorCommand.cull = cull;
      colorCommand.debugShowBoundingVolume = debugShowBoundingVolume;
      colorCommand.castShadows = castShadows;
      colorCommand.receiveShadows = receiveShadows;

      if (allowPicking) {
        colorCommand.pickId = "v_pickColor";
      } else {
        colorCommand.pickId = undefined;
      }

      // SORT-1: Wire primitive renderPriority/renderLayer to DrawCommand sort properties
      colorCommand.sortPriority = primitive.renderPriority;
      colorCommand.sortLayer = primitive.renderLayer;

      // During pick-only passes, push pick commands instead of color commands
      // when the command was created by a feature renderer (duck-type check)
      if (
        passes.pick &&
        !passes.render &&
        defined(colorCommand._webgpuShaderType) &&
        allowPicking &&
        defined(pickCommands) &&
        defined(pickCommands[j])
      ) {
        commandList.push(pickCommands[j]);
      } else {
        commandList.push(colorCommand);
      }
    }

    // WebGPU: Update and queue pick commands
    if (allowPicking && defined(pickCommands) && pickCommands.length > 0) {
      const pickLength = pickCommands.length;
      for (let k = 0; k < pickLength; ++k) {
        const pickCommand = pickCommands[k];
        if (!defined(pickCommand)) {
          continue;
        }

        // Update pick command uniforms when created by a feature renderer
        if (defined(pickCommand._webgpuShaderType)) {
          const pfr = frameState.context.getFeatureRenderer(
            FeatureRendererKey.PRIMITIVE,
          );
          if (pfr) {
            pfr.updatePickCommandUniforms(pickCommand, frameState, modelMatrix);
          }
        }

        const pickSphereIndex = Math.min(k, boundingSpheres.length - 1);
        pickCommand.modelMatrix = modelMatrix;
        pickCommand.boundingVolume = boundingSpheres[pickSphereIndex];
        pickCommand.cull = cull;
        pickCommand.castShadows = false;
        pickCommand.receiveShadows = false;
      }
    }
  }
}

export {
  createRenderStates,
  createShaderProgram,
  createWebGLCommands,
  createCommands,
  getUniforms,
  updateBoundingVolumes,
  updateAndQueueCommands,
};

// Namespace default export for build system barrel compatibility
const PrimitiveCommandHelpers = {
  createRenderStates,
  createShaderProgram,
  createWebGLCommands,
  createCommands,
  getUniforms,
  updateBoundingVolumes,
  updateAndQueueCommands,
};
export default PrimitiveCommandHelpers;
