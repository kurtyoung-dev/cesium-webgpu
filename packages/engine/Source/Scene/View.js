import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian3 from "../Core/Cartesian3.js";
import CullingVolume from "../Core/CullingVolume.js";
import defined from "../Core/defined.js";
import getTimestamp from "../Core/getTimestamp.js";
import Interval from "../Core/Interval.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import Pass from "../Renderer/Pass.js";
import PassState from "../Renderer/PassState.js";
import Camera from "./Camera.js";
import EdgeFramebuffer from "./EdgeFramebuffer.js";
import PlanarFillIdFramebuffer from "./PlanarFillIdFramebuffer.js";
import { createEclipseGlobeShadow } from "./EclipseGlobeShadow.js";
import { createEclipseState } from "./EclipseState.js";
import { needsEnvironmentOnlyFrustum } from "./EnvironmentFrustumDemand.js";
import GBufferFramebuffer from "./GBufferFramebuffer.js";
import FrustumCommands from "./FrustumCommands.js";
import GlobeDepth from "./GlobeDepth.js";
import GlobeTranslucencyFramebuffer from "./GlobeTranslucencyFramebuffer.js";
import OIT from "./OIT.js";
import PickDepthFramebuffer from "./PickDepthFramebuffer.js";
import PickFramebuffer from "./PickFramebuffer.js";
import SceneFramebuffer from "./SceneFramebuffer.js";
import SceneMode from "./SceneMode.js";
import ShadowMap from "./ShadowMap.js";
import TranslucentTileClassification from "./TranslucentTileClassification.js";
import { createViewTemporalHistory } from "./ViewTemporalHistory.js";

// Pass-indexed shadow-caster eligibility. Missing entries are false, giving the
// PVS walk an O(1) pass test. Eligibility is combined with the frame shadow
// switch and the command's `castShadows` flag.
const isShadowedPass = [];
isShadowedPass[Pass.GLOBE] = true;
isShadowedPass[Pass.CESIUM_3D_TILE] = true;
isShadowedPass[Pass.OPAQUE] = true;
isShadowedPass[Pass.TRANSLUCENT] = true;

/**
 * @alias View
 * @private
 *
 * @param {Scene} scene
 * @param {Camera} camera
 * @param {BoundingRectangle} viewport
 * @param {object} [options]
 * @param {GraphicsContext} [options.graphicsContext] Optional per-view context.
 *   When provided, this view renders using a different context than the Scene's default.
 *   Enables multi-view scenarios: split-screen, multi-monitor, mixed backends.
 *   If not provided, falls back to the Scene's context.
 * @param {boolean} [options.useOffscreenCanvas=false] When true, creates the view's
 *   rendering context on an OffscreenCanvas in a WebWorker (background rendering).
 */
class View {
  constructor(scene, camera, viewport, options) {
    options = options ?? {};

    /**
     * Reference to the owning scene (for context fallback).
     * @type {Scene}
     * @private
     */
    this._scene = scene;

    /**
     * Optional per-view GraphicsContext. When set, this view uses its own
     * rendering context instead of the Scene's default. Enables:
     * - Split-screen: WebGL left + WebGPU right (same scene graph)
     * - Multi-monitor: Different canvases, same or different backends
     * - Mixed rendering: WebGL main view + WebGPU compute
     *
     * @type {GraphicsContext|undefined}
     * @private
     */
    this._graphicsContext = options.graphicsContext ?? undefined;

    // Resolve effective context: per-view override or scene default
    const context = this._graphicsContext ?? scene.context;

    let globeDepth;
    if (context.depthTexture) {
      globeDepth = new GlobeDepth();
    }

    let oit;
    if (scene._useOIT && context.depthTexture) {
      // OIT is now supported for both WebGL and WebGPU
      // WebGPU uses WebGPUOIT.ts for weighted blended OIT
      oit = new OIT(context);
    }

    const passState = new PassState(context);
    passState.viewport = BoundingRectangle.clone(viewport);

    this.camera = camera;
    this._cameraClone = Camera.clone(camera);
    this._cameraStartFired = false;
    this._cameraMovedTime = undefined;

    // Previous-camera matrices belong to the logical View, not the shared
    // context's UniformState. Only Scene's successful presented-frame boundary
    // advances this allocation-stable record; pick/offscreen/pass cameras are
    // prepare-only readers.
    this._temporalHistory = createViewTemporalHistory();

    // Eclipse outputs are observer-camera-dependent, so their lifetime follows
    // the logical View rather than the Scene. Scene publishes the active View's
    // objects as short-lived FrameState aliases. Auxiliary pass cameras such as
    // shadow maps and environment-capture faces do not replace these objects.
    this._eclipseState = createEclipseState();
    this._eclipseSceneLightFactor = 1.0;
    this._eclipseHorizonTwilight = 0.0;
    this._eclipseGlobeShadow = createEclipseGlobeShadow();

    this.viewport = viewport;
    this.passState = passState;
    // Use context factory for backend-appropriate pick framebuffer.
    // WebGPU: context.createPickFramebuffer() returns WebGPUPickFramebuffer.
    // WebGL: returns null, falls back to PickFramebuffer.
    this.pickFramebuffer =
      context.createPickFramebuffer() ?? new PickFramebuffer(context);
    this.snapFramebuffer = undefined;
    this.pickDepthFramebuffer = new PickDepthFramebuffer();
    this.sceneFramebuffer = new SceneFramebuffer();
    this.edgeFramebuffer = new EdgeFramebuffer();
    this.planarFillIdFramebuffer = new PlanarFillIdFramebuffer();
    // Persistent per-view normal/roughness framebuffer. WebGPU allocates its
    // texture for the non-pick MRT attachment shape even when deferred-lighting
    // consumers are disabled. The frame-state flag controls consumers and the
    // non-MRT compute producer; MRT fragment outputs and allocation are
    // independent of it.
    this.gBufferFramebuffer = new GBufferFramebuffer();
    this.globeDepth = globeDepth;
    this.globeTranslucencyFramebuffer = new GlobeTranslucencyFramebuffer();
    this.oit = oit;
    this.translucentTileClassification = new TranslucentTileClassification(
      context,
    );
    /**
     * @type {PickDepth[]}
     */
    this.pickDepths = [];
    this.frustumCommandsList = [];
    this.debugFrustumStatistics = undefined;

    // Array of all commands that get rendered into frustums along with their near / far values.
    // Acts similar to a ManagedArray.
    this._commandExtents = [];

    // Per-frame shadow-caster sublist collected during the PVS walk and
    // published to `frameState.shadowState.casterCommands`. It is persistent
    // and reset by length to avoid reallocating. Camera-invisible casters remain
    // in this list because they can cast into view; the shadow executor later
    // light- and cascade-culls the list.
    this._shadowCasters = [];
    // Used only when an optional pre-PVS camera visibility filter is active.
    // It deduplicates the shadow-only side channel against commands that
    // survived into the ordinary PVS walk.
    this._shadowCasterSeen = new Set();
  }

  /**
   * The per-view GraphicsContext override.
   * When set, this view uses its own rendering context instead of the Scene's default.
   * @type {GraphicsContext|undefined}
   */
  get graphicsContext() {
    return this._graphicsContext;
  }

  set graphicsContext(value) {
    this._graphicsContext = value;
  }

  /**
   * The effective GraphicsContext for this view — either the per-view override
   * or the Scene's default context. This is the context that should be used
   * for all rendering operations on this view.
   *
   * Use this instead of `scene.context` when you have a View reference,
   * to correctly support multi-context/multi-view scenarios.
   *
   * @type {GraphicsContext}
   * @readonly
   */
  get effectiveContext() {
    return this._graphicsContext ?? this._scene.context;
  }

  /**
   * The owning scene.
   * @type {Scene}
   * @readonly
   * @private
   */
  get scene() {
    return this._scene;
  }

  /**
   * Check if the camera position or direction has changed.
   *
   * @param {Scene} scene
   * @returns {boolean} <code>true</code> if the camera has been updated
   *
   * @private
   */
  checkForCameraUpdates(scene) {
    const camera = this.camera;
    const cameraClone = this._cameraClone;
    if (!cameraEqual(camera, cameraClone, CesiumMath.EPSILON15)) {
      if (!this._cameraStartFired) {
        camera.moveStart.raiseEvent();
        this._cameraStartFired = true;
      }
      this._cameraMovedTime = getTimestamp();
      Camera.clone(camera, cameraClone);

      return true;
    }

    if (
      this._cameraStartFired &&
      getTimestamp() - this._cameraMovedTime > scene.cameraEventWaitTime
    ) {
      camera.moveEnd.raiseEvent();
      this._cameraStartFired = false;
    }

    return false;
  }

  createPotentiallyVisibleSet(scene) {
    const { frameState } = scene;
    const { camera, commandList, shadowState } = frameState;
    const { positionWC, directionWC, frustum } = camera;

    const computeList = scene._computeCommandList;
    const overlayList = scene._overlayCommandList;

    if (scene.debugShowFrustums) {
      this.debugFrustumStatistics = {
        totalCommands: 0,
        commandsInFrustums: {},
      };
    }

    const frustumCommandsList = this.frustumCommandsList;
    for (let n = 0; n < frustumCommandsList.length; ++n) {
      for (let p = 0; p < Pass.NUMBER_OF_PASSES; ++p) {
        frustumCommandsList[n].indices[p] = 0;
      }
    }

    computeList.length = 0;
    overlayList.length = 0;
    // Reset the shadow-caster sublist by length so the backing array is reused.
    // Every PVS entry starts empty, preventing a non-shadowed or second 2D-wrap
    // run from leaking stale casters.
    const shadowCasters = this._shadowCasters;
    shadowCasters.length = 0;

    const commandExtents = this._commandExtents;
    const commandExtentCapacity = commandExtents.length;
    let commandExtentCount = 0;

    let near = +Number.MAX_VALUE;
    let far = -Number.MAX_VALUE;
    // Track bounding-volume-less environment commands so an environment-only
    // view can still receive a frustum below.
    let sawEnvironmentNoBV = false;

    const { shadowsEnabled } = shadowState;
    const prePvsShadowCasters = shadowState.prePvsCasterCommands;
    const mergePrePvsShadowCasters =
      shadowsEnabled &&
      defined(prePvsShadowCasters) &&
      prePvsShadowCasters.length > 0;
    const shadowCasterSeen = this._shadowCasterSeen;
    shadowCasterSeen.clear();
    let shadowNear = +Number.MAX_VALUE;
    let shadowFar = -Number.MAX_VALUE;
    let shadowClosestObjectSize = Number.MAX_VALUE;

    const occluder =
      frameState.mode === SceneMode.SCENE3D ? frameState.occluder : undefined;

    // get user culling volume minus the far plane.
    let { cullingVolume } = frameState;
    const planes = scratchCullingVolume.planes;
    for (let k = 0; k < 5; ++k) {
      planes[k] = cullingVolume.planes[k];
    }
    cullingVolume = scratchCullingVolume;

    for (let i = 0; i < commandList.length; ++i) {
      const command = commandList[i];
      const { pass, boundingVolume } = command;

      if (pass === Pass.COMPUTE) {
        computeList.push(command);
      } else if (pass === Pass.OVERLAY) {
        overlayList.push(command);
      } else {
        let commandNear;
        let commandFar;

        // A command enters the caster sublist only when shadows are enabled,
        // `castShadows` is true, and its pass is shadow-eligible. This prevents
        // caster collection when shadows are disabled.
        const isCaster =
          shadowsEnabled &&
          command.castShadows === true &&
          isShadowedPass[pass] === true;
        if (isCaster && mergePrePvsShadowCasters) {
          shadowCasterSeen.add(command);
        }

        if (defined(boundingVolume)) {
          if (!scene.isVisible(cullingVolume, command, occluder)) {
            // A camera-invisible object behind or beside the camera can still
            // cast a shadow into view, so collect it before this `continue`.
            // This branch never reaches `insertIntoBin`; prepare its derived
            // shadow command here so the WebGL cast dispatch can execute it.
            if (isCaster) {
              scene.updateDerivedCommands(command);
              shadowCasters.push(command);
            }
            continue;
          }

          // A camera-visible caster reaches `insertIntoBin` through the extent
          // loop below, which prepares its derived commands. Collect it here
          // without preparing it twice; globe casters are re-dirtied every
          // frame, so duplicate preparation would rebuild their cast commands.
          if (isCaster) {
            shadowCasters.push(command);
          }

          const nearFarInterval = boundingVolume.computePlaneDistances(
            positionWC,
            directionWC,
            scratchNearFarInterval,
          );
          commandNear = nearFarInterval.start;
          commandFar = nearFarInterval.stop;
          near = Math.min(near, commandNear);
          far = Math.max(far, commandFar);

          // Compute a tight near and far plane for commands that receive shadows. This helps compute
          // good splits for cascaded shadow maps. Ignore commands that exceed the maximum distance.
          // When moving the camera low LOD globe tiles begin to load, whose bounding volumes
          // throw off the near/far fitting for the shadow map. Only update for globe tiles that the
          // camera isn't inside.
          if (
            shadowsEnabled &&
            command.receiveShadows &&
            commandNear < ShadowMap.MAXIMUM_DISTANCE &&
            !(pass === Pass.GLOBE && commandNear < -100.0 && commandFar > 100.0)
          ) {
            // Get the smallest bounding volume the camera is near. This is used to place more shadow detail near the object.
            const size = commandFar - commandNear;
            if (pass !== Pass.GLOBE && commandNear < 100.0) {
              shadowClosestObjectSize = Math.min(shadowClosestObjectSize, size);
            }
            shadowNear = Math.min(shadowNear, commandNear);
            shadowFar = Math.max(shadowFar, commandFar);
          }
        } else if (command instanceof ClearCommand) {
          // Clear commands don't need a bounding volume - just add the clear to all frustums.
          commandNear = frustum.near;
          commandFar = frustum.far;
        } else {
          // If command has no bounding volume we need to use the camera's
          // worst-case near and far planes to avoid clipping something important.
          commandNear = frustum.near;
          commandFar = frustum.far;
          // Bounding-volume-less environment commands still bin against the
          // camera range and execute in the farthest frustum, but they do not
          // widen the scene near/far accumulators. Under log depth the worst-case
          // [0.1, 1e10] camera span has ratio 1e11 and creates two frustums;
          // widening for directional effects would leave an empty far band that
          // pays the full per-frustum setup cost. WebGL core environment does
          // not enter `commandList` and already uses a content-fit frustum.
          if (pass !== Pass.ENVIRONMENT) {
            near = Math.min(near, commandNear);
            far = Math.max(far, commandFar);
          } else {
            sawEnvironmentNoBV = true;
          }

          // A caster without a bounding volume still reaches `insertIntoBin`,
          // so collect it without preparing it here. Light-frustum visibility
          // treats a missing bounding volume as visible, conservatively keeping
          // the caster in every applicable cascade.
          if (isCaster) {
            shadowCasters.push(command);
          }
        }

        let extent = commandExtents[commandExtentCount];
        if (!defined(extent)) {
          extent = commandExtents[commandExtentCount] = new CommandExtent();
        }
        extent.command = command;
        extent.near = commandNear;
        extent.far = commandFar;
        commandExtentCount++;
      }
    }

    if (mergePrePvsShadowCasters) {
      mergeShadowOnlyCasterCandidates(
        scene,
        prePvsShadowCasters,
        shadowCasters,
        shadowCasterSeen,
      );
    }
    prePvsShadowCasters.length = 0;
    shadowCasterSeen.clear();

    if (shadowsEnabled) {
      shadowNear = Math.min(Math.max(shadowNear, frustum.near), frustum.far);
      shadowFar = Math.max(Math.min(shadowFar, frustum.far), shadowNear);
      // Use the computed near and far for shadows
      shadowState.nearPlane = shadowNear;
      shadowState.farPlane = shadowFar;
      shadowState.closestObjectSize = shadowClosestObjectSize;
      // Publish the caster sublist so `executeShadowMapCastCommands` can avoid
      // re-scanning the full command list for each shadow map.
      shadowState.casterCommands = shadowCasters;
    } else {
      // Clear the publication so a later mid-frame shadow toggle cannot read a
      // stale sublist as this frame's casters.
      shadowState.casterCommands = undefined;
    }

    if (needsEnvironmentOnlyFrustum(near, far, sawEnvironmentNoBV, scene)) {
      // An environment-only view leaves the near/far accumulators at their
      // sentinels. Restore the camera window so at least one frustum exists;
      // otherwise the clamps collapse the range and the environment frame is
      // dropped. The shared predicate checks injected environment state as well
      // as bounding-volume-less commands because return-only renderers never
      // enter `commandList`. That injected-state branch is inert without an
      // alternate scene renderer, and frames with geometry short-circuit the
      // lookup.
      near = frustum.near;
      far = frustum.far;
    }

    updateFrustums(this, scene, near, far);

    for (let c = 0; c < commandExtentCount; c++) {
      insertIntoBin(this, scene, commandExtents[c]);
    }

    // Dereference old commands
    if (commandExtentCount < commandExtentCapacity) {
      for (let c = commandExtentCount; c < commandExtentCapacity; c++) {
        const commandExtent = commandExtents[c];
        if (!defined(commandExtent.command)) {
          // If the command is undefined, it's assumed that all
          // subsequent commmands were set to undefined as well,
          // so no need to loop over them all
          break;
        }
        commandExtent.command = undefined;
      }
    }

    const numFrustums = frustumCommandsList.length;
    const { frustumSplits } = frameState;
    frustumSplits.length = numFrustums + 1;
    for (let j = 0; j < numFrustums; ++j) {
      frustumSplits[j] = frustumCommandsList[j].near;
      if (j === numFrustums - 1) {
        frustumSplits[j + 1] = frustumCommandsList[j].far;
      }
    }
  }

  destroy() {
    this.pickFramebuffer =
      this.pickFramebuffer && this.pickFramebuffer.destroy();
    this.snapFramebuffer =
      this.snapFramebuffer && this.snapFramebuffer.destroy();
    this.pickDepthFramebuffer =
      this.pickDepthFramebuffer && this.pickDepthFramebuffer.destroy();
    this.sceneFramebuffer =
      this.sceneFramebuffer && this.sceneFramebuffer.destroy();
    this.edgeFramebuffer =
      this.edgeFramebuffer && this.edgeFramebuffer.destroy();
    this.planarFillIdFramebuffer =
      this.planarFillIdFramebuffer && this.planarFillIdFramebuffer.destroy();
    this.gBufferFramebuffer =
      this.gBufferFramebuffer && this.gBufferFramebuffer.destroy();
    this.globeDepth = this.globeDepth && this.globeDepth.destroy();
    this.oit = this.oit && this.oit.destroy();
    this.translucentTileClassification =
      this.translucentTileClassification &&
      this.translucentTileClassification.destroy();
    this.globeTranslucencyFramebuffer =
      this.globeTranslucencyFramebuffer &&
      this.globeTranslucencyFramebuffer.destroy();

    const pickDepths = this.pickDepths;
    for (let i = 0; i < pickDepths.length; ++i) {
      pickDepths[i].destroy();
    }
  }
}

// File-scoped helpers below — class at top per CesiumJS coding guide

function CommandExtent() {
  this.command = undefined;
  this.near = undefined;
  this.far = undefined;
}

const scratchPosition0 = new Cartesian3();
const scratchPosition1 = new Cartesian3();

/**
 * Check if two cameras have the same view.
 * @private
 */
function cameraEqual(camera0, camera1, epsilon) {
  const maximumPositionComponent = Math.max(
    Cartesian3.maximumComponent(
      Cartesian3.abs(camera0.position, scratchPosition0),
    ),
    Cartesian3.maximumComponent(
      Cartesian3.abs(camera1.position, scratchPosition1),
    ),
  );
  const scalar = 1 / Math.max(1, maximumPositionComponent);
  Cartesian3.multiplyByScalar(camera0.position, scalar, scratchPosition0);
  Cartesian3.multiplyByScalar(camera1.position, scalar, scratchPosition1);
  return (
    Cartesian3.equalsEpsilon(scratchPosition0, scratchPosition1, epsilon) &&
    Cartesian3.equalsEpsilon(camera0.direction, camera1.direction, epsilon) &&
    Cartesian3.equalsEpsilon(camera0.up, camera1.up, epsilon) &&
    Cartesian3.equalsEpsilon(camera0.right, camera1.right, epsilon) &&
    Matrix4.equalsEpsilon(camera0.transform, camera1.transform, epsilon) &&
    camera0.frustum.equalsEpsilon(camera1.frustum, epsilon)
  );
}

/**
 * Split the depth range of the scene into multiple frustums.
 * @private
 */
function updateFrustums(view, scene, near, far) {
  const { frameState } = scene;
  const { camera, useLogDepth } = frameState;
  const farToNearRatio = useLogDepth
    ? scene.logarithmicDepthFarToNearRatio
    : scene.farToNearRatio;
  const is2D = scene.mode === SceneMode.SCENE2D;
  const nearToFarDistance2D = scene.nearToFarDistance2D;

  // Extend the far plane slightly further to prevent geometry clipping against the far plane.
  far *= 1.0 + CesiumMath.EPSILON2;

  // The computed near plane must be between the user defined near and far planes.
  // The computed far plane must between the user defined far and computed near.
  // This will handle the case where the computed near plane is further than the user defined far plane.
  near = Math.min(Math.max(near, camera.frustum.near), camera.frustum.far);
  far = Math.max(Math.min(far, camera.frustum.far), near);

  let numFrustums;
  if (is2D) {
    // The multifrustum for 2D is uniformly distributed. To avoid z-fighting in 2D,
    // the camera is moved to just before the frustum and the frustum depth is scaled
    // to be in [1.0, nearToFarDistance2D].
    far = Math.min(far, camera.position.z + scene.nearToFarDistance2D);
    near = Math.min(near, far);
    numFrustums = Math.ceil(
      Math.max(1.0, far - near) / scene.nearToFarDistance2D,
    );
  } else {
    // The multifrustum for 3D/CV is non-uniformly distributed.
    numFrustums = Math.ceil(Math.log(far / near) / Math.log(farToNearRatio));
  }

  const { frustumCommandsList } = view;
  frustumCommandsList.length = numFrustums;
  for (let m = 0; m < numFrustums; ++m) {
    let curNear;
    let curFar;

    if (is2D) {
      curNear = Math.min(
        far - nearToFarDistance2D,
        near + m * nearToFarDistance2D,
      );
      curFar = Math.min(far, curNear + nearToFarDistance2D);
    } else {
      curNear = Math.max(near, Math.pow(farToNearRatio, m) * near);
      curFar = Math.min(far, farToNearRatio * curNear);
    }
    if (!defined(frustumCommandsList[m])) {
      frustumCommandsList[m] = new FrustumCommands(curNear, curFar);
    } else {
      frustumCommandsList[m].near = curNear;
      frustumCommandsList[m].far = curFar;
    }
  }
}

/**
 * Insert a command into the appropriate FrustumCommands.
 * @private
 */
function insertIntoBin(view, scene, commandExtent) {
  const { command, near, far } = commandExtent;

  if (scene.debugShowFrustums) {
    command.debugOverlappingFrustums = 0;
  }

  const { frustumCommandsList } = view;

  for (let i = 0; i < frustumCommandsList.length; ++i) {
    const frustumCommands = frustumCommandsList[i];

    if (near > frustumCommands.far) {
      continue;
    }

    if (far < frustumCommands.near) {
      break;
    }

    const pass = command.pass;
    const index = frustumCommands.indices[pass]++;
    frustumCommands.commands[pass][index] = command;

    if (scene.debugShowFrustums) {
      command.debugOverlappingFrustums |= 1 << i;
    }

    if (command.executeInClosestFrustum) {
      break;
    }
  }

  if (scene.debugShowFrustums) {
    const { debugFrustumStatistics } = view;
    const { debugOverlappingFrustums } = command;
    const cf = debugFrustumStatistics.commandsInFrustums;
    cf[debugOverlappingFrustums] = defined(cf[debugOverlappingFrustums])
      ? cf[debugOverlappingFrustums] + 1
      : 1;
    ++debugFrustumStatistics.totalCommands;
  }

  // This is the camera-visible binning path. Off-camera shadow casters also
  // update derived commands, but must not precompile an unused color variant.
  if (!scene._alternateSceneRenderer && command.isWebGPUDrawCommand !== true) {
    scene.updateDerivedCommands(command, true);
  } else {
    // WebGPU still needs the backend-neutral derived-command bookkeeping, but
    // must never enter the WebGL final-program scheduler.
    scene.updateDerivedCommands(command);
  }
}

const scratchCullingVolume = new CullingVolume();
const scratchNearFarInterval = new Interval();

/**
 * Merge candidates removed by camera-only filters into the shadow-caster
 * sublist. Commands already observed by View are skipped; missing commands get
 * their WebGL cast derivative prepared but are never inserted into camera bins.
 *
 * @param {Scene} scene The owning scene.
 * @param {DrawCommand[]} candidates Pre-filter caster references.
 * @param {DrawCommand[]} shadowCasters Destination shadow list.
 * @param {Set<DrawCommand>} seen Commands that survived to View's PVS walk.
 * @returns {DrawCommand[]} The destination list.
 * @private
 */
function mergeShadowOnlyCasterCandidates(
  scene,
  candidates,
  shadowCasters,
  seen,
) {
  // The pre-filter snapshot is the stable ordering authority whenever the
  // side channel is active. Rebuild the destination in that order instead of
  // appending filtered candidates after octree/Hi-Z survivors.
  shadowCasters.length = 0;
  for (let i = 0; i < candidates.length; i++) {
    const command = candidates[i];
    if (command.castShadows !== true || isShadowedPass[command.pass] !== true) {
      continue;
    }
    if (!seen.has(command)) {
      scene.updateDerivedCommands(command);
    }
    shadowCasters.push(command);
    seen.add(command);
  }
  return shadowCasters;
}

export { insertIntoBin, mergeShadowOnlyCasterCandidates };
export default View;
