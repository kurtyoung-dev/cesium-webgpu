/**
 * Sort comparators and translucent command execution functions extracted
 * from Scene.js. These determine draw order for opaque (front-to-back with
 * material batching) and translucent (back-to-front) commands.
 *
 * @private
 */
import Cartesian3 from "../Core/Cartesian3.js";
import CesiumMath from "../Core/Math.js";
import defined from "../Core/defined.js";
import mergeSort from "../Core/mergeSort.js";

const scratchCart3 = new Cartesian3();

/**
 * Multi-level transparent sort: sortKey → sortPriority → distance (back-to-front).
 * NO material batching — correct blending order is more important than state changes.
 * @private
 */
function backToFront(a, b, position) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }
  const priorityA = a.sortPriority ?? 0;
  const priorityB = b.sortPriority ?? 0;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }
  return (
    b.boundingVolume.distanceSquaredTo(position) -
    a.boundingVolume.distanceSquaredTo(position)
  );
}

function distanceSquaredToCenter(center, position) {
  const diff = Cartesian3.subtract(center, position, scratchCart3);
  const distance = Math.max(0.0, Cartesian3.magnitude(diff));
  return distance * distance;
}

function backToFrontSplats(a, b, position) {
  const boxA = a.boundingVolume;
  const boxB = b.boundingVolume;

  return (
    distanceSquaredToCenter(boxB.center, position) -
    distanceSquaredToCenter(boxA.center, position)
  );
}

/**
 * Multi-level opaque sort: sortKey → sortPriority → materialSortId → distance (front-to-back).
 * Material batching reduces shader/texture state changes.
 * Distance sort within same material gives early-Z benefit.
 * @private
 */
function frontToBack(a, b, position) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;
  }
  const priorityA = a.sortPriority ?? 0;
  const priorityB = b.sortPriority ?? 0;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }
  const matA = a.materialSortId ?? 0;
  const matB = b.materialSortId ?? 0;
  if (matA !== matB) {
    return matA - matB;
  }
  return (
    a.boundingVolume.distanceSquaredTo(position) -
    b.boundingVolume.distanceSquaredTo(position) +
    CesiumMath.EPSILON12
  );
}

function executeTranslucentCommandsBackToFront(
  scene,
  executeFunction,
  passState,
  commands,
  invertClassification,
) {
  mergeSort(commands, backToFront, scene.camera.positionWC);

  if (defined(invertClassification)) {
    executeFunction(invertClassification.unclassifiedCommand, scene, passState);
  }

  for (let i = 0; i < commands.length; ++i) {
    executeFunction(commands[i], scene, passState);
  }
}

function executeTranslucentCommandsFrontToBack(
  scene,
  executeFunction,
  passState,
  commands,
  invertClassification,
) {
  mergeSort(commands, frontToBack, scene.camera.positionWC);

  if (defined(invertClassification)) {
    executeFunction(invertClassification.unclassifiedCommand, scene, passState);
  }

  for (let i = 0; i < commands.length; ++i) {
    executeFunction(commands[i], scene, passState);
  }
}

/**
 * Returns the appropriate translucent command execution function based on
 * whether OIT is enabled and active. Caches the OIT function on the scene
 * to avoid per-frame allocation.
 * @private
 */
function obtainTranslucentCommandExecutionFunction(scene) {
  if (scene._environmentState.useOIT) {
    if (!defined(scene._executeOITFunction)) {
      const { view, context } = scene;
      scene._executeOITFunction = function (
        scene,
        executeFunction,
        passState,
        commands,
        invertClassification,
      ) {
        view.globeDepth.prepareColorTextures(context);
        view.oit.executeCommands(
          scene,
          executeFunction,
          passState,
          commands,
          invertClassification,
        );
      };
    }
    return scene._executeOITFunction;
  }
  if (scene.frameState.passes.render) {
    return executeTranslucentCommandsBackToFront;
  }
  return executeTranslucentCommandsFrontToBack;
}

export {
  backToFront,
  backToFrontSplats,
  executeTranslucentCommandsBackToFront,
  executeTranslucentCommandsFrontToBack,
  frontToBack,
  obtainTranslucentCommandExecutionFunction,
};

// Namespace default export for build system barrel compatibility
const CommandSorter = {
  backToFront,
  backToFrontSplats,
  executeTranslucentCommandsBackToFront,
  executeTranslucentCommandsFrontToBack,
  frontToBack,
  obtainTranslucentCommandExecutionFunction,
};
export default CommandSorter;
