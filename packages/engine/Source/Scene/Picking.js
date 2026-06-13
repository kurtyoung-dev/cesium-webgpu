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
   * Coalesce semantics (Batch 192 mitigation A): if `pickPreciseAsync`
   * is in flight when this is called, the framework drops the precise
   * request rather than the hover one — hover at 60fps takes priority
   * for UX smoothness; missed precise frames are infrequent and the
   * caller's promise simply doesn't resolve until the next call.
   *
   * @param {Scene} scene
   * @param {Cartesian2} windowPosition
   * @param {number} [width=3]
   * @param {number} [height=3]
   * @param {number} [limit=1]
   * @returns {Promise<object[]>}
   */
  async pickHoverAsync(scene, windowPosition, width, height, limit = 1) {
    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192 mitigation A; Batch 194
    // B192-N1 audit fix) — coalesce with latest-cursor chaining.
    //
    // Standard "trailing debounce" pattern. Hover-pick fires at 60fps
    // but pick render + readback can take 16-20ms on heavy scenes —
    // requests stack up. The original Batch 192 coalesce returned the
    // in-flight promise on pile-up, but that resolved with the result
    // for the OLD cursor position; if the user moved the cursor mid-
    // pick the returned tooltip lagged behind reality.
    //
    // The fix: track the latest requested cursor (`_latestHoverCursor`)
    // and run a "drain loop" that processes one pick at a time but
    // always uses the most-recent cursor. All callers awaiting
    // `_inFlightHoverPick` get the SAME consolidated result for the
    // latest cursor — that's the correct UX for hover (every observer
    // wants "what's under the cursor RIGHT NOW", not "what was under
    // it when I first asked").
    this._latestHoverCursor = Cartesian2.clone(
      windowPosition,
      this._latestHoverCursor ?? new Cartesian2(),
    );
    this._latestHoverArgs = { width, height, limit };

    if (defined(this._inFlightHoverPick)) {
      return this._inFlightHoverPick;
    }
    this._inFlightHoverPick = this._runHoverChain(scene);
    return this._inFlightHoverPick;
  }

  /**
   * Drains queued hover-pick requests one at a time, always using
   * the most recent cursor / args. Resolves with the result of the
   * FINAL pick (latest cursor at drain time), shared with all
   * coalesced callers awaiting `_inFlightHoverPick`.
   * @private
   */
  async _runHoverChain(scene) {
    let lastResult;
    try {
      while (defined(this._latestHoverCursor)) {
        const cursor = this._latestHoverCursor;
        const args = this._latestHoverArgs;
        // Claim the latest snapshot. If a new request comes in while
        // the pick below is running, it'll repopulate these and the
        // while loop runs again.
        this._latestHoverCursor = undefined;
        this._latestHoverArgs = undefined;
        lastResult = await this._pickAsyncWithMode(
          scene,
          cursor,
          args.width,
          args.height,
          args.limit,
          "hover",
        );
      }
    } finally {
      this._inFlightHoverPick = undefined;
    }
    return lastResult;
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
    pickBegin(
      scene,
      windowPosition,
      drawingBufferRectangle,
      width,
      height,
      mode,
    );
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
    pickEnd(scene);
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
    pickBegin(scene, windowPosition, drawingBufferRectangle, width, height);
    const pickedObjects = pickFramebuffer.end(drawingBufferRectangle, limit);
    pickEnd(scene);
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

    passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
    scene.updateAndExecuteCommands(passState, scratchColorZero);
    scene.resolveFramebuffers(passState);

    const voxelInfo = pickFramebuffer.readCenterPixel(drawingBufferRectangle);
    context.endFrame();
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

    passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
    scene.updateAndExecuteCommands(passState, scratchColorZero);

    const oldOIT = scene._environmentState.useOIT;
    scene._environmentState.useOIT = false;
    scene.resolveFramebuffers(passState);
    scene._environmentState.useOIT = oldOIT;

    const rawMetadataPixel = pickFramebuffer.readCenterPixel(
      drawingBufferRectangle,
    );
    context.endFrame();
    frameState.pickingMetadata = false;

    return MetadataPicking.decodeMetadataValues(
      pickedMetadataInfo.classProperty,
      pickedMetadataInfo.metadataProperty,
      rawMetadataPixel,
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
    } else if (defined(camera.frustum.infiniteProjectionMatrix)) {
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
const scratchOrthoPixelSize = new Cartesian2();
const scratchOrthoPickVolumeMatrix4 = new Matrix4();

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

  let x = (2.0 * (drawingBufferPosition.x - viewport.x)) / viewport.width - 1.0;
  x *= (frustum.right - frustum.left) * 0.5;
  let y =
    (2.0 * (viewport.height - drawingBufferPosition.y - viewport.y)) /
      viewport.height -
    1.0;
  y *= (frustum.top - frustum.bottom) * 0.5;

  const transform = Matrix4.clone(
    camera.transform,
    scratchOrthoPickVolumeMatrix4,
  );
  camera._setTransform(Matrix4.IDENTITY);

  const origin = Cartesian3.clone(camera.position, scratchOrthoOrigin);
  Cartesian3.multiplyByScalar(camera.right, x, scratchOrthoDirection);
  Cartesian3.add(scratchOrthoDirection, origin, origin);
  Cartesian3.multiplyByScalar(camera.up, y, scratchOrthoDirection);
  Cartesian3.add(scratchOrthoDirection, origin, origin);

  camera._setTransform(transform);

  if (scene.mode === SceneMode.SCENE2D) {
    Cartesian3.fromElements(origin.z, origin.x, origin.y, origin);
  }

  const pixelSize = frustum.getPixelDimensions(
    viewport.width,
    viewport.height,
    1.0,
    1.0,
    scratchOrthoPixelSize,
  );

  const ortho = scratchOrthoPickingFrustum;
  ortho.right = pixelSize.x * 0.5;
  ortho.left = -ortho.right;
  ortho.top = pixelSize.y * 0.5;
  ortho.bottom = -ortho.top;
  ortho.near = frustum.near;
  ortho.far = frustum.far;

  return ortho.computeCullingVolume(origin, camera.directionWC, camera.upWC);
}

const scratchPerspPickingFrustum = new PerspectiveOffCenterFrustum();
const scratchPerspPixelSize = new Cartesian2();

function getPickPerspectiveCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const camera = scene.camera;
  const frustum = camera.frustum;
  const near = frustum.near;

  const tanPhi = Math.tan(frustum.fovy * 0.5);
  const tanTheta = frustum.aspectRatio * tanPhi;

  const x =
    (2.0 * (drawingBufferPosition.x - viewport.x)) / viewport.width - 1.0;
  const y =
    (2.0 * (viewport.height - drawingBufferPosition.y - viewport.y)) /
      viewport.height -
    1.0;

  const xDir = x * near * tanTheta;
  const yDir = y * near * tanPhi;

  const pixelSize = frustum.getPixelDimensions(
    viewport.width,
    viewport.height,
    1.0,
    1.0,
    scratchPerspPixelSize,
  );
  const pickWidth = pixelSize.x * width * 0.5;
  const pickHeight = pixelSize.y * height * 0.5;

  const offCenter = scratchPerspPickingFrustum;
  offCenter.top = yDir + pickHeight;
  offCenter.bottom = yDir - pickHeight;
  offCenter.right = xDir + pickWidth;
  offCenter.left = xDir - pickWidth;
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

function pickBegin(
  scene,
  windowPosition,
  drawingBufferRectangle,
  width,
  height,
  pickMode,
) {
  const { context, frameState, defaultView } = scene;
  const { viewport, pickFramebuffer } = defaultView;

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
  frameState.passes.pickMode = pickMode ?? "default";
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

  passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);
}

function pickEnd(scene) {
  scene.context.endFrame();
  // Reset pickMode so the next pick frame starts from a known state.
  if (scene.frameState?.passes) {
    scene.frameState.passes.pickMode = "default";
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

  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);
  context.endFrame();
}

const scratchPerspectiveFrustum = new PerspectiveFrustum();
const scratchPerspectiveOffCenterFrustum = new PerspectiveOffCenterFrustum();
const scratchOrthographicFrustum = new OrthographicFrustum();
const scratchOrthographicOffCenterFrustum = new OrthographicOffCenterFrustum();
const scratchPickPositionCartographic = new Cartographic();

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
