import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import ShowGeometryInstanceAttribute from "../Core/ShowGeometryInstanceAttribute.js";
import Camera from "./Camera.js";
import Cesium3DTileFeature from "./Cesium3DTileFeature.js";
import Cesium3DTilePass from "./Cesium3DTilePass.js";
import Cesium3DTilePassState from "./Cesium3DTilePassState.js";
import MetadataPicking from "./MetadataPicking.js";
import {
  drawingBufferToFrustumCoordinates,
  pickFrustumHalfExtents,
} from "./PickFrustumMath.js";
import PickDepth from "./PickDepth.js";
import SceneMode from "./SceneMode.js";
import SceneTransforms from "./SceneTransforms.js";
import View from "./View.js";
import {
  updateMostDetailedRayPick,
  pickFromRay,
  drillPickFromRayHelper,
  deferPromiseUntilPostRender,
  launchMostDetailedRayPick,
  getRayForSampleHeight,
  getRayForClampToHeight,
  getHeightFromCartesian,
  sampleHeightMostDetailed,
  clampToHeightMostDetailed,
} from "./PickingRayHelpers.js";

const offscreenDefaultWidth = 0.1;

const pickTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.PICK,
});

/**
 * @private
 */
class Picking {
  constructor(scene) {
    this._mostDetailedRayPicks = [];
    this.pickRenderStateCache = {};
    this._pickPositionCache = {};
    this._pickPositionCacheDirty = false;

    // Hover requests use a two-slot scheduler: one physical pick in flight
    // and one latest-wins queued cursor. Cursor storage is allocated lazily so
    // scenes that never opt into hover picking pay no allocation cost.
    this._inFlightHoverPick = undefined;
    this._queuedHoverPick = undefined;
    this._activeHoverCursor = undefined;
    this._queuedHoverCursor = undefined;
    this._queuedHoverWidth = undefined;
    this._queuedHoverHeight = undefined;
    this._queuedHoverLimit = undefined;

    const pickOffscreenViewport = new BoundingRectangle(0, 0, 1, 1);
    const pickOffscreenCamera = new Camera(scene);
    pickOffscreenCamera.frustum = new OrthographicFrustum({
      width: offscreenDefaultWidth,
      aspectRatio: 1.0,
      near: 0.1,
    });

    this._pickOffscreenView = new View(
      scene,
      pickOffscreenCamera,
      pickOffscreenViewport,
    );
  }

  update() {
    this._pickPositionCacheDirty = true;
  }

  getPickDepth(scene, index) {
    const pickDepths = scene.view.pickDepths;
    let pickDepth = pickDepths[index];
    if (!defined(pickDepth)) {
      pickDepth = new PickDepth();
      pickDepths[index] = pickDepth;
    }
    return pickDepth;
  }

  /**
   * @see Picking#pick
   */
  async pickAsync(scene, windowPosition, width, height, limit = 1) {
    return this._pickAsyncWithMode(
      scene,
      windowPosition,
      width,
      height,
      limit,
      "default",
    );
  }

  /**
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option D / hover-pick
   * entry. Promised contract: "guaranteed stutter-free at 60fps hover".
   * Routes through `fragmentPickHoverMain` for BLEND primitives, which
   * uses Interleaved Gradient Noise to discard translucent fragments
   * stochastically (probability of survival = effective alpha). Result
   * is approximate per-frame but converges to perceptually-correct
   * over multi-frame hover motion.
   *
   * For OPAQUE / MASK alphaMode primitives this is identical to
   * `pickAsync` (the factory delegates to the regular pick pipeline).
   *
   * Coalesce semantics (Batch 192 mitigation A): there is at most one
   * physical hover pick in flight and one queued latest cursor. Callers in
   * the active cycle receive that physical result as soon as it completes;
   * callers arriving during the active cycle share the next cycle's promise.
   *
   * @param {Scene} scene
   * @param {Cartesian2} windowPosition
   * @param {number} [width=3]
   * @param {number} [height=3]
   * @param {number} [limit=1]
   * @returns {Promise<object|undefined>}
   */
  pickHoverAsync(scene, windowPosition, width, height, limit = 1) {
    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192 mitigation A; Batch 194
    // B192-N1 audit fix) — coalesce with a bounded two-slot scheduler.
    //
    // A trailing drain (wait for the cursor stream to become idle, then
    // publish one result) starves callers when pointer events arrive faster
    // than GPU readback. Instead, each completed physical pick publishes its
    // own result. Requests received during it share one queued promise whose
    // cursor and scalar arguments are overwritten in place with the latest
    // values. No request-rate-sized queue or per-call args object is created.
    if (!defined(this._inFlightHoverPick)) {
      this._activeHoverCursor = Cartesian2.clone(
        windowPosition,
        this._activeHoverCursor ?? new Cartesian2(),
      );
      return this._startHoverPick(
        scene,
        this._activeHoverCursor,
        width,
        height,
        limit,
      );
    }

    this._queuedHoverCursor = Cartesian2.clone(
      windowPosition,
      this._queuedHoverCursor ?? new Cartesian2(),
    );
    this._queuedHoverWidth = width;
    this._queuedHoverHeight = height;
    this._queuedHoverLimit = limit;

    if (!defined(this._queuedHoverPick)) {
      const predecessor = this._inFlightHoverPick;
      const startQueuedPick = () =>
        this._startQueuedHoverPick(scene, queuedPromise);
      const queuedPromise = predecessor.then(startQueuedPick, startQueuedPick);
      this._queuedHoverPick = queuedPromise;
      this._trackHoverPickCompletion(queuedPromise);
    }
    return this._queuedHoverPick;
  }

  /**
   * Starts the first physical pick in a hover cycle.
   * @private
   */
  _startHoverPick(scene, cursor, width, height, limit) {
    const promise = this._executeHoverPick(scene, cursor, width, height, limit);
    this._inFlightHoverPick = promise;
    this._trackHoverPickCompletion(promise);
    return promise;
  }

  /**
   * Claims the queued latest-cursor snapshot and starts its physical pick.
   * The queued promise assimilates the returned physical-pick promise, so all
   * callers associated with this cycle receive the same single-object result.
   * @private
   */
  _startQueuedHoverPick(scene, queuedPromise) {
    if (this._queuedHoverPick === queuedPromise) {
      this._queuedHoverPick = undefined;
    }

    const previousActiveCursor = this._activeHoverCursor;
    this._activeHoverCursor = this._queuedHoverCursor;
    this._queuedHoverCursor = previousActiveCursor;

    const width = this._queuedHoverWidth;
    const height = this._queuedHoverHeight;
    const limit = this._queuedHoverLimit;
    this._queuedHoverWidth = undefined;
    this._queuedHoverHeight = undefined;
    this._queuedHoverLimit = undefined;

    // Publish the cycle promise before starting the physical pick. A new
    // pointer event fired by synchronous pick setup therefore observes this
    // cycle as active and can only occupy the one queued slot behind it.
    this._inFlightHoverPick = queuedPromise;
    return this._executeHoverPick(
      scene,
      this._activeHoverCursor,
      width,
      height,
      limit,
    );
  }

  /**
   * Executes one physical hover pick and narrows the internal drill-pick array
   * to Scene.pickHoverAsync's documented object-or-undefined result.
   * @private
   */
  _executeHoverPick(scene, cursor, width, height, limit) {
    let pickedObjectsPromise;
    try {
      pickedObjectsPromise = this._pickAsyncWithMode(
        scene,
        cursor,
        width,
        height,
        limit,
        "hover",
      );
    } catch (error) {
      pickedObjectsPromise = Promise.reject(error);
    }
    return Promise.resolve(pickedObjectsPromise).then(
      (pickedObjects) => pickedObjects?.[0],
    );
  }

  /**
   * Clears the active slot after a cycle settles unless another cycle is
   * already queued behind it. Both fulfillment and rejection take this path.
   * @private
   */
  _trackHoverPickCompletion(promise) {
    const complete = () => {
      if (
        this._inFlightHoverPick === promise &&
        !defined(this._queuedHoverPick)
      ) {
        this._inFlightHoverPick = undefined;
      }
    };
    promise.then(complete, complete);
  }

  /**
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C / precise pick
   * entry. Promised contract: "deterministic geometrically-closest
   * translucent fragment wins". Routes BLEND primitives through a
   * 2-pass pipeline pair (depth pre-pass + depth-EQUAL color pass)
   * sharing one render-pass setup so depth + stencil persist between
   * passes. OPAQUE / MASK alphaMode primitives go through the regular
   * single-pass pick pipeline.
   *
   * Cost: ~2× translucent rasterization on BLEND primitives that
   * intersect the pick rect. Click-pick frequency makes this cost
   * invisible to UX. Calling this on every hover frame is NOT
   * supported and may stutter at 60fps on heavy scenes — use
   * `pickHoverAsync` for continuous hover-pick.
   *
   * Coalesce + defer (Batch 192 mitigations A + B):
   * - If a previous `pickPreciseAsync` for this scene is still in
   *   flight, the new request is queued (one outstanding precise pick
   *   at a time per scene).
   * - If the current frame's GPU work is already heavy (tracked via
   *   `_lastFrameGpuMs`), the precise pick render is deferred to the
   *   next frame to avoid stutter. Latency increases by one frame
   *   (~16ms) but no stutter.
   *
   * @param {Scene} scene
   * @param {Cartesian2} windowPosition
   * @param {number} [width=3]
   * @param {number} [height=3]
   * @param {number} [limit=1]
   * @returns {Promise<object[]>}
   */
  async pickPreciseAsync(scene, windowPosition, width, height, limit = 1) {
    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) mitigation A — coalesce.
    // One outstanding precise pick at a time per scene. If a click
    // fires while another precise pick is mid-readback, the new
    // request waits for the prior one to complete then runs. Avoids
    // pile-up on rapid clicks.
    if (defined(this._inFlightPrecisePick)) {
      await this._inFlightPrecisePick.catch(() => {});
    }

    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192 mitigation B; activated
    // by Batch 197 B192-N2 timestamp-query wiring) — defer to next
    // frame when GPU work is heavy.
    //
    // Reads `context.performanceManager.frameTimings.totalGpuMs` —
    // populated by the WebGPU timestamp profiler when active. The
    // first `Scene.pickPreciseAsync` call on a scene auto-enables
    // timestamp profiling (see Scene.pickPreciseAsync); the perf-
    // manager's own gating on `device.features.has('timestamp-query')`
    // falls through to a 0 reading on devices that don't support it,
    // in which case defer never fires (no stutter avoidance possible
    // without timing info, but no false-positive defer either).
    //
    // Threshold (12ms) chosen so a 14ms-frame heavy scene still has
    // 4ms+ for pick. Click-pick tolerates 16-33ms latency; stutter is
    // unacceptable.
    const heavyMs = 12;
    const ctx = scene.context;
    const lastFrameMs = ctx?._performanceManager?.frameTimings?.totalGpuMs ?? 0;
    if (lastFrameMs > heavyMs) {
      await new Promise((resolve) => {
        scene.frameState?.afterRender?.push(resolve);
      });
    }

    const promise = this._pickAsyncWithMode(
      scene,
      windowPosition,
      width,
      height,
      limit,
      "precise",
    );
    this._inFlightPrecisePick = promise;
    promise.finally(() => {
      if (this._inFlightPrecisePick === promise) {
        this._inFlightPrecisePick = undefined;
      }
    });
    return promise;
  }

  /**
   * Shared async-pick implementation. Splits out the per-mode routing
   * + scratchRectangle alloc + endFrame ordering so the three public
   * entries stay thin wrappers.
   *
   * @private
   */
  async _pickAsyncWithMode(scene, windowPosition, width, height, limit, mode) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { frameState, defaultView } = scene;
    const { pickFramebuffer } = defaultView;
    // Batch 187 (B184-D1 audit fix) — per-call rectangle instance.
    const drawingBufferRectangle = new BoundingRectangle();
    let pickError = noPickFrameError;
    try {
      pickBegin(scene, windowPosition, drawingBufferRectangle, width, height, {
        pickMode: mode,
      });
    } catch (error) {
      pickError = error;
    }
    // Batch 191 (B187-D1 audit fix) — pickEnd MUST run BEFORE
    // pickFramebuffer.endAsync() on WebGPU. `endAsync` synchronously
    // creates a NEW command encoder, queues `copyTextureToBuffer`, and
    // calls `device.queue.submit([encoder.finish()])` BEFORE returning
    // its Promise. `pickEnd → endFrame()` is what submits the pick
    // render's `_currentCommandEncoder`. If `pickEnd` runs AFTER
    // `endAsync`, the readback encoder is submitted to the queue
    // first, GPU executes it against an empty/stale colorTexture, and
    // `mapAsync` resolves with prior-frame data.
    //
    // The Batch 187 attempt at this fix moved pickEnd "before the
    // await" but didn't account for `endAsync`'s synchronous body
    // running the submit before the await. The correct sequence:
    //   pickBegin → pickEnd (submits pick render) → endAsync (queues
    //   readback after pick render in submission order) → await.
    completePickFrame(scene, pickError);
    let pickedObjectsPromise;
    if (defined(pickFramebuffer.endAsync)) {
      pickedObjectsPromise = pickFramebuffer.endAsync(
        drawingBufferRectangle,
        frameState,
        limit,
      );
    } else {
      pickedObjectsPromise = Promise.resolve(
        pickFramebuffer.end(drawingBufferRectangle, limit),
      );
      oneTimeWarning(
        "picking-async-fallback",
        "Fallback to synchronous picking because async operation requires WebGL2 or a context that supports it.",
      );
    }
    return pickedObjectsPromise;
  }

  pick(scene, windowPosition, width, height, limit = 1) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { defaultView } = scene;
    const { pickFramebuffer } = defaultView;
    const drawingBufferRectangle = scratchRectangle;
    let pickedObjects;
    let pickError = noPickFrameError;
    try {
      pickBegin(scene, windowPosition, drawingBufferRectangle, width, height);
      // WebGL must read while its pick framebuffer is still bound. WebGPU's
      // synchronous API starts its cached readback here for the same legacy
      // ordering, then completePickFrame submits/finalizes the mini-frame.
      pickedObjects = pickFramebuffer.end(drawingBufferRectangle, limit);
    } catch (error) {
      pickError = error;
    }
    completePickFrame(scene, pickError);
    return pickedObjects;
  }

  pickVoxelCoordinate(scene, windowPosition, width, height) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { context, frameState, defaultView } = scene;
    const { viewport, pickFramebuffer } = defaultView;

    scene.view = defaultView;
    viewport.x = 0;
    viewport.y = 0;
    viewport.width = context.drawingBufferWidth;
    viewport.height = context.drawingBufferHeight;

    let passState = defaultView.passState;
    passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    const drawingBufferRectangle = computePickingDrawingBufferRectangle(
      context.drawingBufferHeight,
      drawingBufferPosition,
      width,
      height,
      scratchRectangle,
    );

    scene.jobScheduler.disableThisFrame();
    scene.updateFrameState();
    frameState.cullingVolume = getPickCullingVolume(
      scene,
      drawingBufferPosition,
      drawingBufferRectangle.width,
      drawingBufferRectangle.height,
      viewport,
    );
    frameState.invertClassification = false;
    frameState.passes.pickVoxel = true;
    frameState.tilesetPassState = pickTilesetPassState;

    context.uniformState.update(frameState);
    scene.updateEnvironment();

    let pickError = noPickFrameError;
    try {
      passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
      scene.updateAndExecuteCommands(passState, scratchColorZero);
      scene.resolveFramebuffers(passState);
    } catch (error) {
      pickError = error;
    }

    // endFrame() MUST run before readCenterPixel() on WebGPU: it submits the
    // voxel pass's command encoder to the queue. readCenterPixel arms its own
    // copyTextureToBuffer readback (NEW-PICK-METADATA-READBACK); if it ran
    // first the readback would be submitted ahead of the voxel render and
    // decode a stale/cleared pixel (the same submission-order hazard the async
    // pick path documents in _pickAsyncWithMode). On WebGL, endFrame() only
    // unbinds the default framebuffer — the pick FBO content persists and
    // readCenterPixel re-binds it explicitly — so the reorder is a no-op there.
    completePickFrame(scene, pickError);
    const voxelInfo = pickFramebuffer.readCenterPixel(drawingBufferRectangle);
    return voxelInfo;
  }

  /**
   * @private
   */
  pickMetadata(scene, windowPosition, pickedMetadataInfo) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("windowPosition", windowPosition);
    Check.typeOf.object("pickedMetadataInfo", pickedMetadataInfo);
    //>>includeEnd('debug');

    const { context, frameState, defaultView } = scene;
    const { viewport, pickFramebuffer } = defaultView;

    scene.view = defaultView;
    viewport.x = 0;
    viewport.y = 0;
    viewport.width = context.drawingBufferWidth;
    viewport.height = context.drawingBufferHeight;

    let passState = defaultView.passState;
    passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    const drawingBufferRectangle = computePickingDrawingBufferRectangle(
      context.drawingBufferHeight,
      drawingBufferPosition,
      1.0,
      1.0,
      scratchRectangle,
    );

    scene.jobScheduler.disableThisFrame();
    scene.updateFrameState();
    frameState.cullingVolume = getPickCullingVolume(
      scene,
      drawingBufferPosition,
      drawingBufferRectangle.width,
      drawingBufferRectangle.height,
      viewport,
    );
    frameState.invertClassification = false;
    frameState.passes.pick = true;
    frameState.tilesetPassState = pickTilesetPassState;

    frameState.pickingMetadata = true;
    frameState.pickedMetadataInfo = pickedMetadataInfo;
    context.uniformState.update(frameState);
    scene.updateEnvironment();

    let pickError = noPickFrameError;
    try {
      passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
      scene.updateAndExecuteCommands(passState, scratchColorZero);

      const oldOIT = scene._environmentState.useOIT;
      try {
        scene._environmentState.useOIT = false;
        scene.resolveFramebuffers(passState);
      } finally {
        scene._environmentState.useOIT = oldOIT;
      }
    } catch (error) {
      pickError = error;
    }

    // endFrame() before readCenterPixel() — submits the metadata pass so the
    // WebGPU center-pixel readback (NEW-PICK-METADATA-READBACK) copies the
    // just-rendered pixel rather than a stale one. No-op ordering on WebGL
    // (see pickVoxelCoordinate for the full rationale).
    try {
      completePickFrame(scene, pickError);
    } finally {
      frameState.pickingMetadata = false;
    }
    const rawMetadataPixel = pickFramebuffer.readCenterPixel(
      drawingBufferRectangle,
    );

    return MetadataPicking.decodeMetadataValues(
      pickedMetadataInfo.classProperty,
      pickedMetadataInfo.metadataProperty,
      rawMetadataPixel,
    );
  }

  /**
   * If the object under `windowPosition` is a GPU-resident compute-instance,
   * return that instance's world position; otherwise undefined
   * (NEW-COMPUTE-INSTANCE-PICKPOSITION). Stays domain-agnostic by duck-typing
   * the pick record — a `{ collection, instanceIndex }` whose collection
   * exposes `getInstanceWorldPosition(index, result)` — so no
   * ComputeInstanceCollection import is needed here.
   * @private
   */
  _pickComputeInstancePosition(scene, windowPosition, result) {
    // Gate: only run the extra object-pick when a pickable compute-instance
    // collection actually rendered recently (it frame-stamps the context in
    // ComputeInstanceCollection.update). Otherwise this would run a full pick
    // pass on EVERY pickPosition query — disrupting the globe depth-buffer
    // pickPosition path (the pick pass + endFrame clobber the shared depth
    // state the async getDepth readback depends on) and wasting a render.
    const context = scene.context;
    const stamp = context?._pickableComputeInstanceFrame;
    const frameNumber = scene.frameState?.frameNumber ?? 0;
    if (!defined(stamp) || frameNumber - stamp > 2) {
      return undefined;
    }

    // Picking.pick returns the array of picked records (Scene.pick unwraps
    // `[0]`); take the front record.
    const picked = this.pick(scene, windowPosition, 1, 1)[0];
    if (
      !defined(picked) ||
      !defined(picked.collection) ||
      typeof picked.instanceIndex !== "number" ||
      typeof picked.collection.getInstanceWorldPosition !== "function"
    ) {
      return undefined;
    }
    return picked.collection.getInstanceWorldPosition(
      picked.instanceIndex,
      result,
    );
  }

  pickPositionWorldCoordinates(scene, windowPosition, result) {
    if (!scene.useDepthPicking) {
      return undefined;
    }

    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    if (!scene.context.depthTexture) {
      throw new DeveloperError(
        "Picking from the depth buffer is not supported. Check pickPositionSupported.",
      );
    }
    //>>includeEnd('debug');

    const cacheKey = windowPosition.toString();

    if (this._pickPositionCacheDirty) {
      this._pickPositionCache = {};
      this._pickPositionCacheDirty = false;
    } else if (Object.hasOwn(this._pickPositionCache, cacheKey)) {
      return Cartesian3.clone(this._pickPositionCache[cacheKey], result);
    }

    // GPU-resident instance pickPosition (NEW-COMPUTE-INSTANCE-PICKPOSITION).
    // A ComputeInstanceCollection's positions live only in a GPU storage buffer
    // (WebGPU) or are CPU-computed by its cpuKernel (WebGL2), so the depth
    // reconstruction below — which unprojects the scene depth at the cursor —
    // can't give the instance's OWN position (a dot is sub-pixel; its center
    // rarely coincides with the sampled depth, and on WebGPU the translucent
    // dots don't even write depth). Instead, pick the object under the cursor;
    // if it is one of these instances, ask its collection to reconstruct the
    // instance's world position directly. Duck-typed (collection exposes
    // getInstanceWorldPosition + a numeric instanceIndex) so Picking stays
    // domain-agnostic and avoids a hard ComputeInstanceCollection import.
    const instancePosition = this._pickComputeInstancePosition(
      scene,
      windowPosition,
      result,
    );
    if (defined(instancePosition)) {
      this._pickPositionCache[cacheKey] = Cartesian3.clone(instancePosition);
      return instancePosition;
    }

    const { context, frameState, camera, defaultView } = scene;
    const { uniformState } = context;

    scene.view = defaultView;

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    if (scene.pickTranslucentDepth) {
      renderTranslucentDepthForPick(scene, drawingBufferPosition);
    } else {
      scene.updateFrameState();
      uniformState.update(frameState);
      scene.updateEnvironment();
    }
    drawingBufferPosition.y =
      scene.drawingBufferHeight - drawingBufferPosition.y;

    let frustum;
    if (defined(camera.frustum.fov)) {
      frustum = camera.frustum.clone(scratchPerspectiveFrustum);
    } else if (
      typeof camera.frustum.getInfiniteProjectionMatrix === "function"
    ) {
      frustum = camera.frustum.clone(scratchPerspectiveOffCenterFrustum);
    } else if (defined(camera.frustum.width)) {
      frustum = camera.frustum.clone(scratchOrthographicFrustum);
    } else {
      frustum = camera.frustum.clone(scratchOrthographicOffCenterFrustum);
    }

    const { frustumCommandsList } = defaultView;
    const numFrustums = frustumCommandsList.length;

    // Unproject a depth value into world coordinates using the given frustum
    const unprojectDepth = (depthValue, frustumIndex) => {
      if (!defined(depthValue) || depthValue <= 0.0 || depthValue >= 1.0) {
        return undefined;
      }
      const renderedFrustum = frustumCommandsList[frustumIndex];
      let height2D;
      if (scene.mode === SceneMode.SCENE2D) {
        height2D = camera.position.z;
        camera.position.z = height2D - renderedFrustum.near + 1.0;
        frustum.far = Math.max(1.0, renderedFrustum.far - renderedFrustum.near);
        frustum.near = 1.0;
        uniformState.update(frameState);
        uniformState.updateFrustum(frustum);
      } else {
        frustum.near =
          renderedFrustum.near *
          (frustumIndex !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
        frustum.far = renderedFrustum.far;
        uniformState.updateFrustum(frustum);
      }

      const worldPos = SceneTransforms.drawingBufferToWorldCoordinates(
        scene,
        drawingBufferPosition,
        depthValue,
        result,
      );

      if (scene.mode === SceneMode.SCENE2D) {
        camera.position.z = height2D;
        uniformState.update(frameState);
      }

      // Guard against NaN results
      if (
        defined(worldPos) &&
        !isNaN(worldPos.x) &&
        !isNaN(worldPos.y) &&
        !isNaN(worldPos.z)
      ) {
        this._pickPositionCache[cacheKey] = Cartesian3.clone(worldPos);
        return worldPos;
      }
      return undefined;
    };

    // NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION (Batch 252) — full-frustum log
    // reconstruction for contexts without synchronous readback (WebGPU).
    // ALL frustum slices there share ONE packed depth texture
    // (WebGPUSceneRendererFrustumLoop's pick-depth copy of
    // `globeDepth.globeDepthTexture`), and every depth producer encodes it
    // LOGARITHMICALLY against the FULL camera frustum (Batches 249-251), not
    // against per-slice near/far. Running the per-slice loop below against
    // that texture is what produced the ~85,000 km antipode garbage of
    // Batch 221. Instead: keep the cloned camera frustum's own near/far (the
    // encode frustum — `scene.camera` is the persistent camera the WebGPU
    // frustum loop encodes against) and let the `useLogDepth` branch of
    // SceneTransforms.drawingBufferToWorldCoordinates reverse the log encode
    // against `uniformState.currentFrustum`.
    //
    // The depth value is PickDepth's one-frame-stale async sync-cache
    // (number|undefined — all consumers here are synchronous): the first
    // query at a location returns undefined (callers fall back to ray
    // picking, the pre-Batch-252 SAFE state) and arms the readback;
    // subsequent queries converge within 1-2 frames.
    if (!context.supportsSynchronousReadback) {
      if (
        numFrustums === 0 ||
        !frameState.useLogDepth ||
        !context.pickDepthFullFrustumLogEncode
      ) {
        // Without the full-frustum log encode (kill switch off, or an
        // orthographic/2D camera where useLogDepth is false) the shared
        // packed texture holds per-slice hyperbolic depth, which has NO
        // consistent single-texture reconstruction — keep the SAFE
        // undefined → ray-pick fallback rather than a garbage position.
        this._pickPositionCache[cacheKey] = undefined;
        return undefined;
      }

      // Index 0 — every PickDepth instance receives the same shared packed
      // texture; index 0 is updated every rendered frame.
      const pickDepth = this.getPickDepth(scene, 0);
      const depthValue = pickDepth.getDepth(
        context,
        drawingBufferPosition.x,
        drawingBufferPosition.y,
      );
      if (!defined(depthValue) || depthValue <= 0.0 || depthValue >= 1.0) {
        this._pickPositionCache[cacheKey] = undefined;
        return undefined;
      }

      // `frustum` is the untouched clone of the persistent camera frustum,
      // so its near/far ARE the encode frustum. updateFrustum publishes its
      // projection + near/far + log2FarDepthFromNearPlusOne, which is
      // exactly what drawingBufferToWorldCoordinates consumes for the
      // log-depth reversal and the unproject.
      uniformState.updateFrustum(frustum);
      const worldPos = SceneTransforms.drawingBufferToWorldCoordinates(
        scene,
        drawingBufferPosition,
        depthValue,
        result,
      );
      if (
        defined(worldPos) &&
        !isNaN(worldPos.x) &&
        !isNaN(worldPos.y) &&
        !isNaN(worldPos.z)
      ) {
        this._pickPositionCache[cacheKey] = Cartesian3.clone(worldPos);
        return worldPos;
      }
      this._pickPositionCache[cacheKey] = undefined;
      return undefined;
    }

    for (let i = 0; i < numFrustums; ++i) {
      const pickDepth = this.getPickDepth(scene, i);
      const depthOrPromise = pickDepth.getDepth(
        context,
        drawingBufferPosition.x,
        drawingBufferPosition.y,
      );

      // If getDepth returned a Promise, propagate it so callers can .then()
      if (
        defined(depthOrPromise) &&
        typeof depthOrPromise.then === "function"
      ) {
        return depthOrPromise.then((depthValue) =>
          unprojectDepth(depthValue, i),
        );
      }

      // Sync path (WebGL): process immediately
      const syncResult = unprojectDepth(depthOrPromise, i);
      if (defined(syncResult)) {
        return syncResult;
      }
    }

    this._pickPositionCache[cacheKey] = undefined;
    return undefined;
  }

  pickPosition(scene, windowPosition, result) {
    result = this.pickPositionWorldCoordinates(scene, windowPosition, result);
    if (defined(result) && scene.mode !== SceneMode.SCENE3D) {
      Cartesian3.fromElements(result.y, result.z, result.x, result);
      const projection = scene.mapProjection;
      const ellipsoid = projection.ellipsoid;
      const cart = projection.unproject(
        result,
        scratchPickPositionCartographic,
      );
      ellipsoid.cartographicToCartesian(cart, result);
    }
    return result;
  }

  drillPick(scene, windowPosition, limit, width, height) {
    // AUDIT_2026_05_02 B.6 — drillPick on WebGPU returns stale prior-frame
    // results. WebGPUPickFramebuffer.end() always returns the PREVIOUS
    // frame's pixels (async readback by design); this loop calls pick()
    // synchronously and the per-iteration `setShow(false)` between
    // iterations doesn't get a chance to render before the next pick.
    // The result is either all instances of the same feature, or empty
    // after 1-2 iterations. Surface a one-time warning pointing users
    // at the async API (Batch 184).
    //>>includeStart('debug', pragmas.debug);
    if (scene?._context?.isWebGPU) {
      oneTimeWarning(
        "WebGPU.drillPick.staleResults",
        "Scene.drillPick is unreliable on WebGPU because the pick " +
          "framebuffer readback is asynchronous (returns previous " +
          "frame's pixels). Each drill iteration may see the same " +
          "feature repeatedly or return empty. Use Scene.drillPickAsync " +
          "for correct results on both backends.",
      );
    }
    //>>includeEnd('debug');
    const pickCallback = (limit) => {
      const pickedObjects = this.pick(
        scene,
        windowPosition,
        width,
        height,
        limit,
      );
      return pickedObjects.map((object) => ({
        object: object,
        position: undefined,
        exclude: false,
      }));
    };
    const objects = drillPick(pickCallback, limit);
    return objects.map((element) => element.object);
  }

  /**
   * Async variant of {@link Picking#drillPick}. Awaits each iteration's
   * pick before mutating `show` state on the picked primitives, so the
   * drill loop sees a fresh pick render every iteration on both
   * backends. Required for correct drill behavior on WebGPU (the sync
   * path returns prior-frame pixels — AUDIT_2026_05_02 B.6).
   *
   * @param {Scene} scene
   * @param {Cartesian2} windowPosition
   * @param {number} [limit]
   * @param {number} [width]
   * @param {number} [height]
   * @returns {Promise<object[]>}
   * @private
   */
  async drillPickAsync(scene, windowPosition, limit, width, height) {
    const pickCallback = async (limit) => {
      const pickedObjects = await this.pickAsync(
        scene,
        windowPosition,
        width,
        height,
        limit,
      );
      return pickedObjects.map((object) => ({
        object: object,
        position: undefined,
        exclude: false,
      }));
    };
    const objects = await drillPickAsync(pickCallback, limit);
    return objects.map((element) => element.object);
  }

  updateMostDetailedRayPicks(scene) {
    const rayPicks = this._mostDetailedRayPicks;
    for (let i = 0; i < rayPicks.length; ++i) {
      if (updateMostDetailedRayPick(this, scene, rayPicks[i])) {
        rayPicks.splice(i--, 1);
      }
    }
  }

  pickFromRay(scene, ray, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    return pickFromRay(this, scene, ray, objectsToExclude, width, false, false);
  }

  drillPickFromRay(scene, ray, limit, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    return drillPickFromRayHelper(
      this,
      scene,
      ray,
      limit,
      objectsToExclude,
      width,
      false,
      false,
    );
  }

  pickFromRayMostDetailed(scene, ray, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    const that = this;
    ray = Ray.clone(ray);
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    return deferPromiseUntilPostRender(
      scene,
      launchMostDetailedRayPick(
        that,
        scene,
        ray,
        objectsToExclude,
        width,
        function () {
          return pickFromRay(
            that,
            scene,
            ray,
            objectsToExclude,
            width,
            false,
            true,
          );
        },
      ),
    );
  }

  drillPickFromRayMostDetailed(scene, ray, limit, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    const that = this;
    ray = Ray.clone(ray);
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    return deferPromiseUntilPostRender(
      scene,
      launchMostDetailedRayPick(
        that,
        scene,
        ray,
        objectsToExclude,
        width,
        function () {
          return drillPickFromRayHelper(
            that,
            scene,
            ray,
            limit,
            objectsToExclude,
            width,
            false,
            true,
          );
        },
      ),
    );
  }

  sampleHeight(scene, position, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("position", position);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError("sampleHeight is only supported in 3D mode.");
    }
    if (!scene.sampleHeightSupported) {
      throw new DeveloperError(
        "sampleHeight requires depth texture support. Check sampleHeightSupported.",
      );
    }
    //>>includeEnd('debug');

    // NEW-PICK-RAY-ASYNC (Phase 6) — on asynchronous-readback backends
    // (WebGPU) the offscreen ray-render depth path cannot recover a position
    // (the offscreen pick view's PickDepth instances never receive the packed
    // globe-depth texture, and that texture is LOG-encoded against the MAIN
    // camera frustum, not the offscreen one). Instead reuse the main scene's
    // already-rendered depth via the Batch-252 pickPosition reconstruction:
    // project the cartographic position into the live view, sample the surface
    // under that pixel, and return its height. Same one-frame-stale sync-cache
    // contract as pickPosition (cold query → undefined + arms readback →
    // converges in 1-2 frames).
    if (!scene.context.supportsSynchronousReadback) {
      const surface = this._reconstructHeightSurfaceWebGPU(scene, position);
      if (defined(surface)) {
        return getHeightFromCartesian(scene, surface);
      }
      return undefined;
    }

    const ray = getRayForSampleHeight(scene, position);
    const pickResult = pickFromRay(
      this,
      scene,
      ray,
      objectsToExclude,
      width,
      true,
      false,
    );
    if (defined(pickResult)) {
      return getHeightFromCartesian(scene, pickResult.position);
    }
  }

  clampToHeight(scene, cartesian, objectsToExclude, width, result) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("cartesian", cartesian);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError("clampToHeight is only supported in 3D mode.");
    }
    if (!scene.clampToHeightSupported) {
      throw new DeveloperError(
        "clampToHeight requires depth texture support. Check clampToHeightSupported.",
      );
    }
    //>>includeEnd('debug');

    // NEW-PICK-RAY-ASYNC (Phase 6) — see sampleHeight above. Same main-scene
    // depth reuse; clampToHeight returns the reconstructed surface Cartesian3
    // directly instead of just its height.
    if (!scene.context.supportsSynchronousReadback) {
      const surface = this._reconstructHeightSurfaceWebGPU(scene, cartesian);
      if (defined(surface)) {
        return Cartesian3.clone(surface, result);
      }
      return undefined;
    }

    const ray = getRayForClampToHeight(scene, cartesian);
    const pickResult = pickFromRay(
      this,
      scene,
      ray,
      objectsToExclude,
      width,
      true,
      false,
    );
    if (defined(pickResult)) {
      return Cartesian3.clone(pickResult.position, result);
    }
  }

  /**
   * NEW-PICK-RAY-ASYNC (Phase 6) — WebGPU implementation of the
   * sampleHeight / clampToHeight surface lookup. Reuses the main scene's
   * already-rendered depth (the same packed log-depth texture pickPosition
   * reads since Batch 252) rather than an offscreen ray render, which the
   * async-readback backend cannot support.
   *
   * Given a target world/cartographic position, project it into the live
   * camera view and reconstruct the rendered surface (globe/tileset) under
   * that pixel via {@link Picking#pickPositionWorldCoordinates}. The returned
   * surface lies on the camera ray through the projected pixel — for a
   * position currently visible in the view this is the globe/tileset height
   * at (approximately) that location. Inherits pickPosition's one-frame-stale
   * sync cache: the first query at a new screen location returns
   * <code>undefined</code> (and arms the async readback) and converges within
   * 1-2 rendered frames.
   *
   * Returns <code>undefined</code> when the target is off-screen / behind the
   * camera, or while the depth readback is still cold.
   *
   * @param {Scene} scene
   * @param {Cartographic|Cartesian3} target Cartographic (sampleHeight) or
   *   Cartesian3 (clampToHeight) position to look up the surface beneath.
   * @returns {Cartesian3|undefined} The reconstructed surface position, or
   *   undefined.
   * @private
   */
  _reconstructHeightSurfaceWebGPU(scene, target) {
    // Normalize to a world-space Cartesian3 anchor on the ellipsoid surface.
    const ellipsoid = scene.ellipsoid;
    let anchor;
    if (target instanceof Cartographic) {
      // sampleHeight passes a Cartographic; ignore its (often unknown) height
      // and anchor on the ellipsoid surface so the projection is stable.
      const carto = Cartographic.clone(
        target,
        scratchReconstructHeightCartographic,
      );
      carto.height = 0.0;
      anchor = Cartographic.toCartesian(
        carto,
        ellipsoid,
        scratchReconstructHeightAnchor,
      );
    } else {
      anchor = Cartesian3.clone(target, scratchReconstructHeightAnchor);
    }

    const windowPosition = SceneTransforms.worldToWindowCoordinates(
      scene,
      anchor,
      scratchReconstructHeightWindow,
    );
    if (!defined(windowPosition)) {
      // Behind the camera / near the ellipsoid center — no on-screen pixel.
      return undefined;
    }
    // Reject positions outside the canvas: pickPosition would read an
    // unrelated edge pixel and return a misleading surface.
    if (
      windowPosition.x < 0 ||
      windowPosition.y < 0 ||
      windowPosition.x > scene.canvas.clientWidth ||
      windowPosition.y > scene.canvas.clientHeight
    ) {
      return undefined;
    }

    return this.pickPositionWorldCoordinates(scene, windowPosition);
  }

  sampleHeightMostDetailed(scene, positions, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("positions", positions);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "sampleHeightMostDetailed is only supported in 3D mode.",
      );
    }
    if (!scene.sampleHeightSupported) {
      throw new DeveloperError(
        "sampleHeightMostDetailed requires depth texture support. Check sampleHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    const length = positions.length;
    const promises = new Array(length);
    for (let i = 0; i < length; ++i) {
      promises[i] = sampleHeightMostDetailed(
        this,
        scene,
        positions[i],
        objectsToExclude,
        width,
      );
    }
    return deferPromiseUntilPostRender(
      scene,
      Promise.all(promises).then(function (heights) {
        const length = heights.length;
        for (let i = 0; i < length; ++i) {
          positions[i].height = heights[i];
        }
        return positions;
      }),
    );
  }

  clampToHeightMostDetailed(scene, cartesians, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("cartesians", cartesians);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "clampToHeightMostDetailed is only supported in 3D mode.",
      );
    }
    if (!scene.clampToHeightSupported) {
      throw new DeveloperError(
        "clampToHeightMostDetailed requires depth texture support. Check clampToHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    const length = cartesians.length;
    const promises = new Array(length);
    for (let i = 0; i < length; ++i) {
      promises[i] = clampToHeightMostDetailed(
        this,
        scene,
        cartesians[i],
        objectsToExclude,
        width,
        cartesians[i],
      );
    }
    return deferPromiseUntilPostRender(
      scene,
      Promise.all(promises).then(function (clampedCartesians) {
        const length = clampedCartesians.length;
        for (let i = 0; i < length; ++i) {
          cartesians[i] = clampedCartesians[i];
        }
        return cartesians;
      }),
    );
  }

  destroy() {
    this._pickOffscreenView =
      this._pickOffscreenView && this._pickOffscreenView.destroy();
  }
}

// ---- File-scoped helpers (culling volumes) ----

const scratchOrthoPickingFrustum = new OrthographicOffCenterFrustum();
const scratchOrthoOrigin = new Cartesian3();
const scratchOrthoDirection = new Cartesian3();
const scratchOrthoPickVolumeMatrix4 = new Matrix4();
const scratchPickFrustumCoordinates = new Cartesian2();
const scratchPickFrustumHalfExtents = new Cartesian2();

function getPickOrthographicCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const camera = scene.camera;
  let frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  if (defined(offCenterFrustum)) {
    frustum = offCenterFrustum;
  }

  const frustumCoordinates = drawingBufferToFrustumCoordinates(
    drawingBufferPosition.x,
    scene.context.drawingBufferHeight - drawingBufferPosition.y,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    frustum.left,
    frustum.right,
    frustum.bottom,
    frustum.top,
    scratchPickFrustumCoordinates,
  );
  const halfExtents = pickFrustumHalfExtents(
    frustum.left,
    frustum.right,
    frustum.bottom,
    frustum.top,
    viewport.width,
    viewport.height,
    width,
    height,
    scratchPickFrustumHalfExtents,
  );

  const transform = Matrix4.clone(
    camera.transform,
    scratchOrthoPickVolumeMatrix4,
  );
  camera._setTransform(Matrix4.IDENTITY);

  const origin = Cartesian3.clone(camera.position, scratchOrthoOrigin);
  Cartesian3.multiplyByScalar(
    camera.right,
    frustumCoordinates.x,
    scratchOrthoDirection,
  );
  Cartesian3.add(scratchOrthoDirection, origin, origin);
  Cartesian3.multiplyByScalar(
    camera.up,
    frustumCoordinates.y,
    scratchOrthoDirection,
  );
  Cartesian3.add(scratchOrthoDirection, origin, origin);

  camera._setTransform(transform);

  if (scene.mode === SceneMode.SCENE2D) {
    Cartesian3.fromElements(origin.z, origin.x, origin.y, origin);
  }

  const ortho = scratchOrthoPickingFrustum;
  ortho.right = halfExtents.x;
  ortho.left = -ortho.right;
  ortho.top = halfExtents.y;
  ortho.bottom = -ortho.top;
  ortho.near = frustum.near;
  ortho.far = frustum.far;

  return ortho.computeCullingVolume(origin, camera.directionWC, camera.upWC);
}

const scratchPerspPickingFrustum = new PerspectiveOffCenterFrustum();

function getPickPerspectiveCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const camera = scene.camera;
  const cameraFrustum = camera.frustum;
  const offCenterFrustum = cameraFrustum.offCenterFrustum;
  const frustum = defined(offCenterFrustum) ? offCenterFrustum : cameraFrustum;
  const near = frustum.near;
  const frustumCoordinates = drawingBufferToFrustumCoordinates(
    drawingBufferPosition.x,
    scene.context.drawingBufferHeight - drawingBufferPosition.y,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    frustum.left,
    frustum.right,
    frustum.bottom,
    frustum.top,
    scratchPickFrustumCoordinates,
  );
  const halfExtents = pickFrustumHalfExtents(
    frustum.left,
    frustum.right,
    frustum.bottom,
    frustum.top,
    viewport.width,
    viewport.height,
    width,
    height,
    scratchPickFrustumHalfExtents,
  );

  const offCenter = scratchPerspPickingFrustum;
  offCenter.top = frustumCoordinates.y + halfExtents.y;
  offCenter.bottom = frustumCoordinates.y - halfExtents.y;
  offCenter.right = frustumCoordinates.x + halfExtents.x;
  offCenter.left = frustumCoordinates.x - halfExtents.x;
  offCenter.near = near;
  offCenter.far = frustum.far;

  return offCenter.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
}

function getPickCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const frustum = scene.camera.frustum;
  if (
    frustum instanceof OrthographicFrustum ||
    frustum instanceof OrthographicOffCenterFrustum
  ) {
    return getPickOrthographicCullingVolume(
      scene,
      drawingBufferPosition,
      width,
      height,
      viewport,
    );
  }
  return getPickPerspectiveCullingVolume(
    scene,
    drawingBufferPosition,
    width,
    height,
    viewport,
  );
}

// ---- Pick begin/end ----

const scratchRectangle = new BoundingRectangle(0.0, 0.0, 3.0, 3.0);
const scratchPosition = new Cartesian2();
const scratchColorZero = new Color(0.0, 0.0, 0.0, 0.0);
const noPickFrameError = Symbol("no pick frame error");

function computePickingDrawingBufferRectangle(
  drawingBufferHeight,
  position,
  width,
  height,
  result,
) {
  result.width = width ?? 3.0;
  result.height = height ?? result.width;
  result.x = position.x - (result.width - 1.0) * 0.5;
  result.y = drawingBufferHeight - position.y - (result.height - 1.0) * 0.5;
  return result;
}

/**
 * Setup needed before picking.
 *
 * Exported for use by Snapping, which performs the same offscreen pick render
 * but targets the snap framebuffer and flags the pass as a snapping pass.
 *
 * @param {Scene} scene
 * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
 * @param {BoundingRectangle} drawingBufferRectangle The output drawing buffer recangle.
 * @param {number} [width=3] Width of the pick rectangle.
 * @param {number} [height=3] Height of the pick rectangle.
 * @param {object} [options] Object with the following properties:
 * @param {PickFramebuffer|SnapFramebuffer} [options.framebuffer] The framebuffer to render into. Defaults to the view's pick framebuffer.
 * @param {boolean} [options.snap=false] If <code>true</code>, mark the pass as a snapping pass (sets <code>frameState.passes.snap</code>).
 * @param {"default"|"hover"|"precise"} [options.pickMode="default"] Selects the
 *        C-R9-MODEL-PICK-TRANSLUCENT pick variant (sets <code>frameState.passes.pickMode</code>).
 *
 * @private
 */
export function pickBegin(
  scene,
  windowPosition,
  drawingBufferRectangle,
  width,
  height,
  options,
) {
  const { context, frameState, defaultView } = scene;
  const { viewport, pickFramebuffer } = defaultView;
  const framebuffer = options?.framebuffer ?? pickFramebuffer;

  scene.view = defaultView;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = context.drawingBufferWidth;
  viewport.height = context.drawingBufferHeight;

  let passState = defaultView.passState;
  passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

  const drawingBufferPosition = SceneTransforms.transformWindowToDrawingBuffer(
    scene,
    windowPosition,
    scratchPosition,
  );
  computePickingDrawingBufferRectangle(
    context.drawingBufferHeight,
    drawingBufferPosition,
    width,
    height,
    drawingBufferRectangle,
  );

  scene.jobScheduler.disableThisFrame();
  scene.updateFrameState();
  frameState.cullingVolume = getPickCullingVolume(
    scene,
    drawingBufferPosition,
    drawingBufferRectangle.width,
    drawingBufferRectangle.height,
    viewport,
  );
  frameState.invertClassification = false;
  frameState.passes.pick = true;
  // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — pick variant routing.
  // Default to "default" (B186 first-slice behavior); callers passing
  // "hover" or "precise" opt into the second-slice variants. Cleared
  // in pickEnd so subsequent default-pick frames don't carry stale mode.
  frameState.passes.pickMode = options?.pickMode ?? "default";
  frameState.passes.snap = options?.snap ?? false;
  frameState.tilesetPassState = pickTilesetPassState;

  // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) mitigation E — pick-rect
  // screen-space cull tightening. The `getPickCullingVolume` call
  // above already tightens the camera frustum to the screen-space
  // pick rectangle. The scene's frustum-loop partition reads
  // `frameState.cullingVolume` and excludes any command whose
  // bounding sphere doesn't intersect the tightened volume — which
  // for a 3×3 pick rect at the cursor means most commands skip BOTH
  // pass 1 and pass 2 of the precise pick (and the dither pass of
  // hover pick). For typical Cesium scenes (thousands of tiles), this
  // drops the pick-time render cost by ~90-95% even before we get to
  // per-pipeline render-pass overhead. Pure infrastructure reuse — no
  // additional code needed for Batch 192.

  context.uniformState.update(frameState);
  scene.updateEnvironment();

  passState = framebuffer.begin(drawingBufferRectangle, viewport);
  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);
}

/**
 * Teardown needed after picking.
 *
 * Exported for use by Snapping, which drives the same offscreen pick frame.
 *
 * @param {Scene} scene
 *
 * @private
 */
export function pickEnd(scene) {
  try {
    scene.context.endFrame();
  } finally {
    // Reset the pass flags so the next pick frame starts from a known state
    // even if device loss or command-buffer validation makes finalization throw.
    if (scene.frameState?.passes) {
      scene.frameState.passes.pickMode = "default";
      scene.frameState.passes.snap = false;
    }
  }
}

function completePickFrame(scene, primaryError = noPickFrameError) {
  let cleanupError = noPickFrameError;
  try {
    pickEnd(scene);
  } catch (error) {
    cleanupError = error;
  }

  // A cleanup failure is useful only when it is the sole failure. Preserve
  // the render/readback exception that actually caused the mini-frame abort.
  if (primaryError !== noPickFrameError) {
    throw primaryError;
  }
  if (cleanupError !== noPickFrameError) {
    throw cleanupError;
  }
}

// ---- Translucent depth for pick position ----

function renderTranslucentDepthForPick(scene, drawingBufferPosition) {
  const { defaultView, context, frameState, environmentState } = scene;
  const { viewport, pickDepthFramebuffer } = defaultView;

  scene.view = defaultView;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = context.drawingBufferWidth;
  viewport.height = context.drawingBufferHeight;

  let passState = defaultView.passState;
  passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

  scene.clearPasses(frameState.passes);
  frameState.passes.pick = true;
  frameState.passes.depth = true;
  frameState.cullingVolume = getPickCullingVolume(
    scene,
    drawingBufferPosition,
    1,
    1,
    viewport,
  );
  frameState.tilesetPassState = pickTilesetPassState;

  scene.updateEnvironment();
  environmentState.renderTranslucentDepthForPick = true;
  passState = pickDepthFramebuffer.update(
    context,
    drawingBufferPosition,
    viewport,
  );

  let pickError = noPickFrameError;
  try {
    scene.updateAndExecuteCommands(passState, scratchColorZero);
    scene.resolveFramebuffers(passState);
  } catch (error) {
    pickError = error;
  }
  completePickFrame(scene, pickError);
}

const scratchPerspectiveFrustum = new PerspectiveFrustum();
const scratchPerspectiveOffCenterFrustum = new PerspectiveOffCenterFrustum();
const scratchOrthographicFrustum = new OrthographicFrustum();
const scratchOrthographicOffCenterFrustum = new OrthographicOffCenterFrustum();
const scratchPickPositionCartographic = new Cartographic();

// NEW-PICK-RAY-ASYNC (Phase 6) — scratch for _reconstructHeightSurfaceWebGPU.
const scratchReconstructHeightCartographic = new Cartographic();
const scratchReconstructHeightAnchor = new Cartesian3();
const scratchReconstructHeightWindow = new Cartesian2();

// ---- Screen-space drill pick ----

function addDrillPickedResults(
  pickedResults,
  limit,
  results,
  pickedPrimitives,
  pickedAttributes,
  pickedFeatures,
) {
  for (const pickedResult of pickedResults) {
    const object = pickedResult.object;
    const position = pickedResult.position;
    const exclude = pickedResult.exclude;

    if (defined(position) && !defined(object)) {
      results.push(pickedResult);
      return true;
    }
    if (!defined(object) || !defined(object.primitive)) {
      return true;
    }
    if (!exclude) {
      results.push(pickedResult);
      if (results.length >= limit) {
        return true;
      }
    }

    const primitive = object.primitive;
    let hasShowAttribute = false;

    if (typeof primitive.getGeometryInstanceAttributes === "function") {
      if (defined(object.id)) {
        const attributes = primitive.getGeometryInstanceAttributes(object.id);
        if (defined(attributes) && defined(attributes.show)) {
          hasShowAttribute = true;
          attributes.show = ShowGeometryInstanceAttribute.toValue(
            false,
            attributes.show,
          );
          pickedAttributes.push(attributes);
        }
      }
    }
    if (object instanceof Cesium3DTileFeature) {
      hasShowAttribute = true;
      object.show = false;
      pickedFeatures.push(object);
    }
    if (!hasShowAttribute) {
      primitive.show = false;
      pickedPrimitives.push(primitive);
    }
  }
}

function drillPick(pickCallback, limit) {
  const results = [];
  const pickedPrimitives = [];
  const pickedAttributes = [];
  const pickedFeatures = [];
  if (!defined(limit)) {
    limit = Number.MAX_VALUE;
  }

  let pickedResults = pickCallback(limit);
  while (defined(pickedResults) && pickedResults.length > 0) {
    const complete = addDrillPickedResults(
      pickedResults,
      limit,
      results,
      pickedPrimitives,
      pickedAttributes,
      pickedFeatures,
    );
    if (complete) {
      break;
    }
    pickedResults = pickCallback(limit - results.length);
  }

  for (let i = 0; i < pickedPrimitives.length; ++i) {
    pickedPrimitives[i].show = true;
  }
  for (let i = 0; i < pickedAttributes.length; ++i) {
    pickedAttributes[i].show = ShowGeometryInstanceAttribute.toValue(
      true,
      pickedAttributes[i].show,
    );
  }
  for (let i = 0; i < pickedFeatures.length; ++i) {
    pickedFeatures[i].show = true;
  }
  return results;
}

// Batch 184 (NEW-DRILLPICK-ASYNC) — async sibling of `drillPick`. The
// pickCallback returns a Promise; iterations are awaited so each one
// sees a fresh pick render rather than the in-flight previous frame
// (the failure mode that made the sync path unreliable on WebGPU).
async function drillPickAsync(pickCallback, limit) {
  const results = [];
  const pickedPrimitives = [];
  const pickedAttributes = [];
  const pickedFeatures = [];
  if (!defined(limit)) {
    limit = Number.MAX_VALUE;
  }

  let pickedResults = await pickCallback(limit);
  while (defined(pickedResults) && pickedResults.length > 0) {
    const complete = addDrillPickedResults(
      pickedResults,
      limit,
      results,
      pickedPrimitives,
      pickedAttributes,
      pickedFeatures,
    );
    if (complete) {
      break;
    }
    pickedResults = await pickCallback(limit - results.length);
  }

  for (let i = 0; i < pickedPrimitives.length; ++i) {
    pickedPrimitives[i].show = true;
  }
  for (let i = 0; i < pickedAttributes.length; ++i) {
    pickedAttributes[i].show = ShowGeometryInstanceAttribute.toValue(
      true,
      pickedAttributes[i].show,
    );
  }
  for (let i = 0; i < pickedFeatures.length; ++i) {
    pickedFeatures[i].show = true;
  }
  return results;
}

export default Picking;
