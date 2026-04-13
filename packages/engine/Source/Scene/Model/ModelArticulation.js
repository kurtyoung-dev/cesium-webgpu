import Check from "../../Core/Check.js";
import Frozen from "../../Core/Frozen.js";
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import ModelArticulationStage from "./ModelArticulationStage.js";

/**
 * An in-memory representation of an articulation that affects nodes in the
 * {@link ModelSceneGraph}. This is defined in a model by the
 * <code>AGI_articulations</code> extension.
 *
 * @param {object} options An object containing the following options:
 * @param {ModelComponents.Articulation} options.articulation The articulation components from the 3D model.
 * @param {ModelSceneGraph} options.sceneGraph The scene graph this articulation belongs to.
 *
 * @alias ModelArticulation
 * @constructor
 *
 * @private
 */
class ModelArticulation {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    const articulation = options.articulation;
    const sceneGraph = options.sceneGraph;
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("options.articulation", articulation);
    Check.typeOf.object("options.sceneGraph", sceneGraph);
    //>>includeEnd('debug');

    this._articulation = articulation;
    this._sceneGraph = sceneGraph;

    this._name = articulation.name;
    this._runtimeStages = [];
    this._runtimeStagesByName = {};

    // Will be populated as the runtime nodes are created
    this._runtimeNodes = [];

    // Set to true so that the first call to
    // ModelSceneGraph.applyArticulations will work.
    this._dirty = true;

    initialize(this);
  }

  /**
   * Sets the current value of an articulation stage.
   *
   * @param {string} stageName The name of the articulation stage.
   * @param {number} value The numeric value of this stage of the articulation.
   *
   * @private
   */
  setArticulationStage(stageName, value) {
    const stage = this._runtimeStagesByName[stageName];
    if (defined(stage)) {
      stage.currentValue = value;
    }
  }

  /**
   * Applies the chain of articulation stages to the transform of each node that
   * participates in the articulation. This only recomputes the node transforms
   * if any stage in the articulation has been modified.
   * <p>
   * Note that this will overwrite any existing transformations on participating
   * nodes.
   * </p>
   *
   * @private
   */
  apply() {
    if (!this._dirty) {
      return;
    }
    this._dirty = false;

    let articulationMatrix = Matrix4.clone(
      Matrix4.IDENTITY,
      scratchArticulationMatrix,
    );

    let i;
    const stages = this._runtimeStages;
    const stagesLength = stages.length;

    // Compute the result of the articulation stages...
    for (i = 0; i < stagesLength; i++) {
      const stage = stages[i];
      articulationMatrix = stage.applyStageToMatrix(articulationMatrix);
    }

    // ...then apply it to the transforms of the affected nodes.
    const nodes = this._runtimeNodes;
    const nodesLength = nodes.length;
    for (i = 0; i < nodesLength; i++) {
      const node = nodes[i];
      const transform = Matrix4.multiplyTransformation(
        node.originalTransform,
        articulationMatrix,
        scratchNodeMatrix,
      );
      node.transform = transform;
    }
  }

  /**
   * The internal articulation that this runtime articulation represents.
   *
   * @memberof ModelArticulation.prototype
   * @type {ModelComponents.Articulation}
   * @readonly
   *
   * @private
   */
  get articulation() {
    return this._articulation;
  }

  /**
   * The scene graph that this articulation belongs to.
   *
   * @memberof ModelArticulation.prototype
   * @type {ModelSceneGraph}
   * @readonly
   *
   * @private
   */
  get sceneGraph() {
    return this._sceneGraph;
  }

  /**
   * The name of this articulation.
   *
   * @memberof ModelArticulation.prototype
   * @type {string}
   * @readonly
   *
   * @private
   */
  get name() {
    return this._name;
  }

  /**
   * The runtime stages that belong to this articulation.
   *
   * @memberof ModelArticulation.prototype
   * @type {ModelArticulationStage[]}
   * @readonly
   *
   * @private
   */
  get runtimeStages() {
    return this._runtimeStages;
  }

  /**
   * The runtime nodes that are affected by this articulation.
   *
   * @memberof ModelArticulation.prototype
   * @type {ModelRuntimeNode[]}
   * @readonly
   *
   * @private
   */
  get runtimeNodes() {
    return this._runtimeNodes;
  }
}

function initialize(runtimeArticulation) {
  const articulation = runtimeArticulation.articulation;

  const stages = articulation.stages;
  const length = stages.length;

  const runtimeStages = runtimeArticulation._runtimeStages;
  const runtimeStagesByName = runtimeArticulation._runtimeStagesByName;
  for (let i = 0; i < length; i++) {
    const stage = stages[i];
    const runtimeStage = new ModelArticulationStage({
      stage: stage,
      runtimeArticulation: runtimeArticulation,
    });

    // Store the stages in an array to preserve the order in which
    // they appeared in the 3D model.
    runtimeStages.push(runtimeStage);

    // Store the stages in a dictionary for retrieval by name.
    const stageName = stage.name;
    runtimeStagesByName[stageName] = runtimeStage;
  }
}

const scratchArticulationMatrix = new Matrix4();
const scratchNodeMatrix = new Matrix4();

export default ModelArticulation;
