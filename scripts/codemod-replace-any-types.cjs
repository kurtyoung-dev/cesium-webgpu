/**
 * jscodeshift codemod: Replace `: any` parameter annotations in WebGPU TS
 * files with proper CesiumJS ambient types from cesium-js-types.d.ts.
 *
 * This operates on the PARAMETER NAME to determine the correct type:
 *   - frameState → CesiumFrameState
 *   - uniformState → CesiumUniformState
 *   - surfaceTile → CesiumGlobeSurfaceTile
 *   - context → CesiumGraphicsContext
 *   - passState → CesiumPassState
 *   - drawCommand / command / cmd → CesiumDrawCommand
 *   - shadowMap → CesiumShadowMap
 *   - tile (with surfaceTile-shaped access) → CesiumGlobeSurfaceTile
 *
 * Usage:
 *   npx jscodeshift -t scripts/codemod-replace-any-types.cjs --extensions ts \
 *       --parser ts packages/engine/Source/Renderer/WebGPU/
 */

"use strict";

module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  let changed = false;

  // Map of parameter name patterns → replacement type annotation string
  const nameToType = {
    frameState: "CesiumFrameState",
    uniformState: "CesiumUniformState",
    surfaceTile: "CesiumGlobeSurfaceTile",
    tileProvider: "any", // keep — too varied
    passState: "CesiumPassState",
    shadowMap: "CesiumShadowMap",
    mesh: "CesiumTerrainMesh",
    encoding: "CesiumTerrainEncoding",
  };

  // For function parameters typed as `: any`, check the param name
  // and replace with the mapped type if available.
  root.find(j.TSTypeAnnotation).forEach((path) => {
    const annotation = path.node;
    if (annotation.typeAnnotation.type !== "TSAnyKeyword") {
      return;
    }

    // Walk up to find the parameter/variable declarator that owns this annotation
    const parent = path.parentPath;
    if (!parent || !parent.node) {
      return;
    }

    let paramName;
    if (parent.node.type === "Identifier") {
      paramName = parent.node.name;
    } else if (
      parent.node.type === "AssignmentPattern" &&
      parent.node.left?.type === "Identifier"
    ) {
      paramName = parent.node.left.name;
    }

    if (!paramName) {
      return;
    }

    const mappedType = nameToType[paramName];
    if (!mappedType || mappedType === "any") {
      return;
    }

    // Replace the TSAnyKeyword with a TSTypeReference to our declared type
    annotation.typeAnnotation = j.tsTypeReference(j.identifier(mappedType));
    changed = true;
  });

  if (!changed) {
    return;
  }
  return root.toSource({ quote: "double", trailingComma: true, tabWidth: 2 });
};
