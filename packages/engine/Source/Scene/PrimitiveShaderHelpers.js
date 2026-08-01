import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import ShaderSource from "../Renderer/ShaderSource.js";

/**
 * Shader modification helpers for Primitive.
 *
 * These functions modify GLSL vertex/fragment shader source code to add
 * RTE position computation, per-instance show/color/offset/distance-display,
 * pick color output, compressed attribute decoding, and depth clamping.
 *
 * Extracted from Primitive.js to keep the main class under 1000 lines.
 * All functions are file-scoped helpers called by Primitive and its subclasses
 * (ClassificationPrimitive, GroundPolylinePrimitive) via static method aliases.
 *
 * @private
 */

const positionRegex = /in\s+vec(?:3|4)\s+(.*)3DHigh;/g;

/**
 * Modifies the vertex shader to compute RTE position from high/low pairs.
 * Handles 3D-only, 2D/CV morph, and RTC center modes.
 * @private
 */
function modifyShaderPosition(primitive, vertexShaderSource, scene3DOnly) {
  let match;

  let forwardDecl = "";
  let attributes = "";
  let computeFunctions = "";

  while ((match = positionRegex.exec(vertexShaderSource)) !== null) {
    const name = match[1];

    const functionName = `vec4 czm_compute${name[0].toUpperCase()}${name.substr(
      1,
    )}()`;

    // Don't forward-declare czm_computePosition because computePosition.glsl already does.
    if (functionName !== "vec4 czm_computePosition()") {
      forwardDecl += `${functionName};\n`;
    }

    if (!defined(primitive.rtcCenter)) {
      // Use GPU RTE
      if (!scene3DOnly) {
        attributes += `in vec3 ${name}2DHigh;\nin vec3 ${name}2DLow;\n`;

        computeFunctions +=
          `${functionName}\n` +
          `{\n` +
          `    vec4 p;\n` +
          `    if (czm_morphTime == 1.0)\n` +
          `    {\n` +
          `        p = czm_translateRelativeToEye(${name}3DHigh, ${name}3DLow);\n` +
          `    }\n` +
          `    else if (czm_morphTime == 0.0)\n` +
          `    {\n` +
          `        p = czm_translateRelativeToEye(${name}2DHigh.zxy, ${name}2DLow.zxy);\n` +
          `    }\n` +
          `    else\n` +
          `    {\n` +
          `        p = czm_columbusViewMorph(\n` +
          `                czm_translateRelativeToEye(${name}2DHigh.zxy, ${name}2DLow.zxy),\n` +
          `                czm_translateRelativeToEye(${name}3DHigh, ${name}3DLow),\n` +
          `                czm_morphTime);\n` +
          `    }\n` +
          `    return p;\n` +
          `}\n\n`;
      } else {
        computeFunctions +=
          `${functionName}\n` +
          `{\n` +
          `    return czm_translateRelativeToEye(${name}3DHigh, ${name}3DLow);\n` +
          `}\n\n`;
      }
    } else {
      // Use RTC
      vertexShaderSource = vertexShaderSource.replace(
        /in\s+vec(?:3|4)\s+position3DHigh;/g,
        "",
      );
      vertexShaderSource = vertexShaderSource.replace(
        /in\s+vec(?:3|4)\s+position3DLow;/g,
        "",
      );

      forwardDecl += "uniform mat4 u_modifiedModelView;\n";
      attributes += "in vec4 position;\n";

      computeFunctions +=
        `${functionName}\n` +
        `{\n` +
        `    return u_modifiedModelView * position;\n` +
        `}\n\n`;

      vertexShaderSource = vertexShaderSource.replace(
        /czm_modelViewRelativeToEye\s+\*\s+/g,
        "",
      );
      vertexShaderSource = vertexShaderSource.replace(
        /czm_modelViewProjectionRelativeToEye/g,
        "czm_projection",
      );
    }
  }

  return [forwardDecl, attributes, vertexShaderSource, computeFunctions].join(
    "\n",
  );
}

/**
 * Appends a show/hide check based on per-instance show attribute.
 * @private
 */
function appendShowToShader(primitive, vertexShaderSource) {
  if (!defined(primitive._batchTableAttributeIndices.show)) {
    return vertexShaderSource;
  }

  const renamedVS = ShaderSource.replaceMain(
    vertexShaderSource,
    "czm_non_show_main",
  );
  const showMain =
    "void main() \n" +
    "{ \n" +
    "    czm_non_show_main(); \n" +
    "    gl_Position *= czm_batchTable_show(batchId); \n" +
    "}";

  return `${renamedVS}\n${showMain}`;
}

/**
 * Replaces per-vertex color attribute with per-instance batch table color.
 * @private
 */
function updateColorAttribute(primitive, vertexShaderSource, isDepthFail) {
  if (
    !defined(primitive._batchTableAttributeIndices.color) &&
    !defined(primitive._batchTableAttributeIndices.depthFailColor)
  ) {
    return vertexShaderSource;
  }

  if (vertexShaderSource.search(/in\s+vec4\s+color;/g) === -1) {
    return vertexShaderSource;
  }

  //>>includeStart('debug', pragmas.debug);
  if (
    isDepthFail &&
    !defined(primitive._batchTableAttributeIndices.depthFailColor)
  ) {
    throw new DeveloperError(
      "A depthFailColor per-instance attribute is required when using a depth fail appearance that uses a color attribute.",
    );
  }
  //>>includeEnd('debug');

  let modifiedVS = vertexShaderSource;
  modifiedVS = modifiedVS.replace(/in\s+vec4\s+color;/g, "");
  if (!isDepthFail) {
    modifiedVS = modifiedVS.replace(
      /(\b)color(\b)/g,
      "$1czm_batchTable_color(batchId)$2",
    );
  } else {
    modifiedVS = modifiedVS.replace(
      /(\b)color(\b)/g,
      "$1czm_batchTable_depthFailColor(batchId)$2",
    );
  }
  return modifiedVS;
}

/**
 * Appends pick color varying output to the vertex shader.
 * @private
 */
function appendPickToVertexShader(source) {
  const renamedVS = ShaderSource.replaceMain(source, "czm_non_pick_main");
  const pickMain =
    "out vec4 v_pickColor; \n" +
    "void main() \n" +
    "{ \n" +
    "    czm_non_pick_main(); \n" +
    "    v_pickColor = czm_batchTable_pickColor(batchId); \n" +
    "}";

  return `${renamedVS}\n${pickMain}`;
}

/**
 * Prepends pick color varying input to the fragment shader.
 * @private
 */
function appendPickToFragmentShader(source) {
  return `in vec4 v_pickColor;\n${source}`;
}

/**
 * Replaces per-vertex pickColor attribute with batch table lookup.
 * @private
 */
function updatePickColorAttribute(source) {
  let vsPick = source.replace(/in\s+vec4\s+pickColor;/g, "");
  vsPick = vsPick.replace(
    /(\b)pickColor(\b)/g,
    "$1czm_batchTable_pickColor(batchId)$2",
  );
  return vsPick;
}

/**
 * Appends per-instance 3D/2D offset application.
 * @private
 */
function appendOffsetToShader(primitive, vertexShaderSource) {
  if (!defined(primitive._batchTableAttributeIndices.offset)) {
    return vertexShaderSource;
  }

  let attr = "in float batchId;\n";
  attr += "in float applyOffset;";
  let modifiedShader = vertexShaderSource.replace(
    /in\s+float\s+batchId;/g,
    attr,
  );

  let str = "vec4 $1 = czm_computePosition();\n";
  str += "    if (czm_sceneMode == czm_sceneMode3D)\n";
  str += "    {\n";
  str +=
    "        $1 = $1 + vec4(czm_batchTable_offset(batchId) * applyOffset, 0.0);";
  str += "    }\n";
  str += "    else\n";
  str += "    {\n";
  str +=
    "        $1 = $1 + vec4(czm_batchTable_offset2D(batchId) * applyOffset, 0.0);";
  str += "    }\n";
  modifiedShader = modifiedShader.replace(
    /vec4\s+([A-Za-z0-9_]+)\s+=\s+czm_computePosition\(\);/g,
    str,
  );
  return modifiedShader;
}

/**
 * Appends distance display condition check — hides geometry outside near/far range.
 * @private
 */
function appendDistanceDisplayConditionToShader(
  primitive,
  vertexShaderSource,
  scene3DOnly,
) {
  if (
    !defined(primitive._batchTableAttributeIndices.distanceDisplayCondition)
  ) {
    return vertexShaderSource;
  }

  const renamedVS = ShaderSource.replaceMain(
    vertexShaderSource,
    "czm_non_distanceDisplayCondition_main",
  );
  let distanceDisplayConditionMain =
    "void main() \n" +
    "{ \n" +
    "    czm_non_distanceDisplayCondition_main(); \n" +
    "    vec2 distanceDisplayCondition = czm_batchTable_distanceDisplayCondition(batchId);\n" +
    "    vec3 boundingSphereCenter3DHigh = czm_batchTable_boundingSphereCenter3DHigh(batchId);\n" +
    "    vec3 boundingSphereCenter3DLow = czm_batchTable_boundingSphereCenter3DLow(batchId);\n" +
    "    float boundingSphereRadius = czm_batchTable_boundingSphereRadius(batchId);\n";

  if (!scene3DOnly) {
    distanceDisplayConditionMain +=
      "    vec3 boundingSphereCenter2DHigh = czm_batchTable_boundingSphereCenter2DHigh(batchId);\n" +
      "    vec3 boundingSphereCenter2DLow = czm_batchTable_boundingSphereCenter2DLow(batchId);\n" +
      "    vec4 centerRTE;\n" +
      "    if (czm_morphTime == 1.0)\n" +
      "    {\n" +
      "        centerRTE = czm_translateRelativeToEye(boundingSphereCenter3DHigh, boundingSphereCenter3DLow);\n" +
      "    }\n" +
      "    else if (czm_morphTime == 0.0)\n" +
      "    {\n" +
      "        centerRTE = czm_translateRelativeToEye(boundingSphereCenter2DHigh.zxy, boundingSphereCenter2DLow.zxy);\n" +
      "    }\n" +
      "    else\n" +
      "    {\n" +
      "        centerRTE = czm_columbusViewMorph(\n" +
      "                czm_translateRelativeToEye(boundingSphereCenter2DHigh.zxy, boundingSphereCenter2DLow.zxy),\n" +
      "                czm_translateRelativeToEye(boundingSphereCenter3DHigh, boundingSphereCenter3DLow),\n" +
      "                czm_morphTime);\n" +
      "    }\n";
  } else {
    distanceDisplayConditionMain +=
      "    vec4 centerRTE = czm_translateRelativeToEye(boundingSphereCenter3DHigh, boundingSphereCenter3DLow);\n";
  }

  distanceDisplayConditionMain +=
    "    float radiusSq = boundingSphereRadius * boundingSphereRadius; \n" +
    "    float distanceSq; \n" +
    "    if (czm_sceneMode == czm_sceneMode2D) \n" +
    "    { \n" +
    "        distanceSq = czm_eyeHeight2D.y - radiusSq; \n" +
    "    } \n" +
    "    else \n" +
    "    { \n" +
    "        distanceSq = dot(centerRTE.xyz, centerRTE.xyz) - radiusSq; \n" +
    "    } \n" +
    "    distanceSq = max(distanceSq, 0.0); \n" +
    "    float nearSq = distanceDisplayCondition.x * distanceDisplayCondition.x; \n" +
    "    float farSq = distanceDisplayCondition.y * distanceDisplayCondition.y; \n" +
    "    float show = (distanceSq >= nearSq && distanceSq <= farSq) ? 1.0 : 0.0; \n" +
    "    gl_Position *= show; \n" +
    "}";
  return `${renamedVS}\n${distanceDisplayConditionMain}`;
}

/**
 * Replaces normal/st/tangent/bitangent attributes with compressed attribute decoding.
 * @private
 */
function modifyForEncodedNormals(primitive, vertexShaderSource) {
  if (!primitive.compressVertices) {
    return vertexShaderSource;
  }

  const containsNormal =
    vertexShaderSource.search(/in\s+vec3\s+normal;/g) !== -1;
  const containsSt = vertexShaderSource.search(/in\s+vec2\s+st;/g) !== -1;
  if (!containsNormal && !containsSt) {
    return vertexShaderSource;
  }

  const containsTangent =
    vertexShaderSource.search(/in\s+vec3\s+tangent;/g) !== -1;
  const containsBitangent =
    vertexShaderSource.search(/in\s+vec3\s+bitangent;/g) !== -1;

  let numComponents = containsSt && containsNormal ? 2.0 : 1.0;
  numComponents += containsTangent || containsBitangent ? 1 : 0;

  const type = numComponents > 1 ? `vec${numComponents}` : "float";

  const attributeName = "compressedAttributes";
  const attributeDecl = `in ${type} ${attributeName};`;

  let globalDecl = "";
  let decode = "";

  if (containsSt) {
    globalDecl += "vec2 st;\n";
    const stComponent =
      numComponents > 1 ? `${attributeName}.x` : attributeName;
    decode += `    st = czm_decompressTextureCoordinates(${stComponent});\n`;
  }

  if (containsNormal && containsTangent && containsBitangent) {
    globalDecl += "vec3 normal;\n" + "vec3 tangent;\n" + "vec3 bitangent;\n";
    decode += `    czm_octDecode(${attributeName}.${
      containsSt ? "yz" : "xy"
    }, normal, tangent, bitangent);\n`;
  } else {
    if (containsNormal) {
      globalDecl += "vec3 normal;\n";
      decode += `    normal = czm_octDecode(${attributeName}${
        numComponents > 1 ? `.${containsSt ? "y" : "x"}` : ""
      });\n`;
    }

    if (containsTangent) {
      globalDecl += "vec3 tangent;\n";
      decode += `    tangent = czm_octDecode(${attributeName}.${
        containsSt && containsNormal ? "z" : "y"
      });\n`;
    }

    if (containsBitangent) {
      globalDecl += "vec3 bitangent;\n";
      decode += `    bitangent = czm_octDecode(${attributeName}.${
        containsSt && containsNormal ? "z" : "y"
      });\n`;
    }
  }

  let modifiedVS = vertexShaderSource;
  modifiedVS = modifiedVS.replace(/in\s+vec3\s+normal;/g, "");
  modifiedVS = modifiedVS.replace(/in\s+vec2\s+st;/g, "");
  modifiedVS = modifiedVS.replace(/in\s+vec3\s+tangent;/g, "");
  modifiedVS = modifiedVS.replace(/in\s+vec3\s+bitangent;/g, "");
  modifiedVS = ShaderSource.replaceMain(modifiedVS, "czm_non_compressed_main");
  const compressedMain =
    `${"void main() \n" + "{ \n"}${decode}    czm_non_compressed_main(); \n` +
    `}`;

  return [attributeDecl, globalDecl, modifiedVS, compressedMain].join("\n");
}

/**
 * Wraps vertex shader with depth clamping for depth-fail appearance.
 * @private
 */
function depthClampVS(vertexShaderSource) {
  let modifiedVS = ShaderSource.replaceMain(
    vertexShaderSource,
    "czm_non_depth_clamp_main",
  );
  modifiedVS +=
    "void main() {\n" +
    "    czm_non_depth_clamp_main();\n" +
    "    gl_Position = czm_depthClamp(gl_Position);" +
    "}\n";
  return modifiedVS;
}

/**
 * Wraps fragment shader with depth clamping for depth-fail appearance.
 * @private
 */
function depthClampFS(fragmentShaderSource) {
  let modifiedFS = ShaderSource.replaceMain(
    fragmentShaderSource,
    "czm_non_depth_clamp_main",
  );
  modifiedFS +=
    "void main() {\n" +
    "    czm_non_depth_clamp_main();\n" +
    "    #if defined(LOG_DEPTH)\n" +
    "        czm_writeLogDepth();\n" +
    "    #else\n" +
    "        czm_writeDepthClamp();\n" +
    "    #endif\n" +
    "}\n";
  return modifiedFS;
}

/**
 * Debug-only: validates that the VAO has all attributes required by the shader.
 * @private
 */
function validateShaderMatching(shaderProgram, attributeLocations) {
  //>>includeStart('debug', pragmas.debug);
  const shaderAttributes = shaderProgram.vertexAttributes;
  for (const name in shaderAttributes) {
    if (Object.hasOwn(shaderAttributes, name)) {
      if (!defined(attributeLocations[name])) {
        throw new DeveloperError(
          `Appearance/Geometry mismatch.  The appearance requires vertex shader attribute input '${name}', which was not computed as part of the Geometry.  Use the appearance's vertexFormat property when constructing the geometry.`,
        );
      }
    }
  }
  //>>includeEnd('debug');
}

export {
  modifyShaderPosition,
  appendShowToShader,
  updateColorAttribute,
  appendPickToVertexShader,
  appendPickToFragmentShader,
  updatePickColorAttribute,
  appendOffsetToShader,
  appendDistanceDisplayConditionToShader,
  modifyForEncodedNormals,
  depthClampVS,
  depthClampFS,
  validateShaderMatching,
};

// Namespace default export for build system barrel compatibility
const PrimitiveShaderHelpers = {
  modifyShaderPosition,
  appendShowToShader,
  updateColorAttribute,
  appendPickToVertexShader,
  appendPickToFragmentShader,
  updatePickColorAttribute,
  appendOffsetToShader,
  appendDistanceDisplayConditionToShader,
  modifyForEncodedNormals,
  depthClampVS,
  depthClampFS,
  validateShaderMatching,
};
export default PrimitiveShaderHelpers;
