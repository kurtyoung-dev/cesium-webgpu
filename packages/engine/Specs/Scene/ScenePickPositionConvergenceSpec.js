import {
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  defined,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  SceneTransforms,
} from "../../index.js";

import createCanvas from "../../../../Specs/createCanvas.js";
import createSceneAsync from "../../../../Specs/createSceneAsync.js";
import {
  describeRequiresWebGPU,
  recordWebGPUAdapterTier,
} from "../../../../Specs/webgpuPolicy.js";

const CANVAS_SIZE = 32;
const SAMPLE_OFFSET = 6;
const WARMUP_FRAME_LIMIT = 16;

// The readback normally converges in one or two frames. Eight iterations leave
// scheduling headroom while keeping a stalled request-render scene bounded.
const CONVERGENCE_FRAME_LIMIT = 8;
const GPU_SETTLE_DELAY = 16;

function yieldForGpuWork() {
  return new Promise((resolve) => setTimeout(resolve, GPU_SETTLE_DELAY));
}

describeRequiresWebGPU(
  "Scene/pickPosition request-render convergence on WebGPU",
  function () {
    let scene;
    let depthPrimitive;
    let centerPosition;
    let warmupSettled = false;

    beforeAll(async function () {
      scene = await createSceneAsync({
        canvas: createCanvas(CANVAS_SIZE, CANVAS_SIZE),
      });
      recordWebGPUAdapterTier(scene.context.adapter?.info);

      scene.logarithmicDepthBuffer = true;
      const cameraOrigin = new Cartesian3(7_000_000.0, 0.0, 0.0);
      scene.camera.setView({
        destination: cameraOrigin,
        orientation: {
          direction: Cartesian3.UNIT_Y,
          up: Cartesian3.UNIT_Z,
        },
      });
      scene.camera.frustum.near = 1.0;
      scene.camera.frustum.far = 100_000_000.0;

      depthPrimitive = scene.primitives.add(
        new Primitive({
          geometryInstances: new GeometryInstance({
            geometry: BoxGeometry.fromDimensions({
              vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
              // 600 km: at the 700 km near face the box spans ~±12 of the 16
              // half-canvas pixels (60-degree fov), so every SAMPLE_OFFSET pixel
              // hits geometry while the canvas corners genuinely miss — the
              // resolved-miss spec needs a pixel with no depth. A 1,000 km box
              // covers the entire canvas and has no miss pixel at all.
              dimensions: new Cartesian3(600_000.0, 600_000.0, 600_000.0),
            }),
            modelMatrix: Matrix4.fromTranslation(
              new Cartesian3(cameraOrigin.x, 1_000_000.0, cameraOrigin.z),
            ),
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE),
            },
          }),
          appearance: new PerInstanceColorAppearance({
            closed: true,
            translucent: false,
          }),
          asynchronous: false,
        }),
      );

      // Two idle frames ensure a resolved first-use pipeline is drawn once.
      // No pick query runs during warmup, so the depth readback remains cold.
      let consecutiveSettledFrames = 0;
      for (let i = 0; i < WARMUP_FRAME_LIMIT; i++) {
        scene.renderForSpecs();
        await yieldForGpuWork();

        if (
          depthPrimitive.ready &&
          scene.context.asyncResources.pendingForegroundCount === 0
        ) {
          consecutiveSettledFrames++;
          if (consecutiveSettledFrames === 2) {
            warmupSettled = true;
            break;
          }
        } else {
          consecutiveSettledFrames = 0;
        }
      }

      if (!warmupSettled) {
        throw new Error(
          `WebGPU pickPosition warmup expired after ${WARMUP_FRAME_LIMIT} frames: pendingForegroundCount=${scene.context.asyncResources.pendingForegroundCount}, depthPrimitive.ready=${depthPrimitive.ready}`,
        );
      }

      // Prime the async pick-depth readback once before the specs run. In the
      // Karma harness nothing presents frames through requestAnimationFrame,
      // and Chromium defers delivery of the FIRST GPU queue-completion signal
      // (mapAsync AND onSubmittedWorkDone) by ~0.5-1s wall-clock regardless of
      // how many frames render; once one completion is delivered, subsequent
      // readbacks settle in 1-3 ms. The specs assert bounded-frame convergence
      // of the readback CYCLE, not the harness one-time completion-delivery
      // latency, so pay that latency here at a pixel more than the 4-px cache
      // tolerance away from every pixel the specs query.
      const primePosition = new Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight / 4,
      );
      const PRIME_WALL_CLOCK_LIMIT = 60; // x 50 ms = 3 s
      let primed = false;
      for (let i = 0; i < PRIME_WALL_CLOCK_LIMIT; i++) {
        scene.renderForSpecs();
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (defined(scene.pickPosition(primePosition))) {
          primed = true;
          break;
        }
      }
      if (!primed) {
        throw new Error(
          "WebGPU pick-depth readback never settled within the 3 s priming budget",
        );
      }

      scene.requestRenderMode = true;
      scene.maximumRenderTimeChange = Number.POSITIVE_INFINITY;
      centerPosition = new Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight / 2,
      );
    });

    afterAll(function () {
      if (defined(scene) && !scene.isDestroyed()) {
        scene.destroyForSpecs();
      }
    });

    function positionWithOffset(x) {
      return new Cartesian2(centerPosition.x + x, centerPosition.y);
    }

    async function convergePickPosition(windowPosition) {
      const frameNumberBefore = scene.frameState.frameNumber;
      let renderedFrames = 0;
      let position = scene.pickPosition(windowPosition);

      while (!defined(position) && renderedFrames < CONVERGENCE_FRAME_LIMIT) {
        scene.renderForSpecs();
        renderedFrames++;
        await yieldForGpuWork();
        position = scene.pickPosition(windowPosition);
      }

      return {
        position,
        renderedFrames,
        frameNumberDelta: scene.frameState.frameNumber - frameNumberBefore,
      };
    }

    it("converges to a Cartesian3 across a bounded number of requested frames", async function () {
      expect(scene.context.isWebGPU).toBe(true);
      expect(scene.requestRenderMode).toBe(true);
      expect(warmupSettled).toBe(true);
      expect(scene.pickPositionSupported).toBe(true);
      expect(scene.context.supportsSynchronousReadback).toBe(false);
      expect(scene.frameState.useLogDepth).toBe(true);
      expect(scene.context.pickDepthFullFrustumLogEncode).toBe(true);
      expect(depthPrimitive.ready).toBe(true);

      const requestRender = spyOn(scene, "requestRender").and.callThrough();
      const convergence = await convergePickPosition(centerPosition);

      expect(requestRender.calls.count()).toBeGreaterThanOrEqual(1);
      // Load-bearing: readback self-resolves, so only this identity proves the request produced a frame.
      expect(convergence.frameNumberDelta).toBe(convergence.renderedFrames);
      expect(convergence.position).toBeInstanceOf(Cartesian3);
      expect(
        defined(convergence.position) &&
          Number.isFinite(convergence.position.x) &&
          Number.isFinite(convergence.position.y) &&
          Number.isFinite(convergence.position.z),
      ).toBe(true);
    });

    it("keeps repeated queries stable within the same frame", function () {
      const windowPosition = positionWithOffset(-SAMPLE_OFFSET);
      const requestRender = spyOn(scene, "requestRender").and.callThrough();
      const transformWindowToDrawingBuffer = spyOn(
        SceneTransforms,
        "transformWindowToDrawingBuffer",
      ).and.callThrough();
      const frameNumber = scene.frameState.frameNumber;
      let first;
      let second;
      let requestCountAfterFirst;
      let transformCountAfterFirst;

      expect(function () {
        first = scene.pickPosition(windowPosition);
        requestCountAfterFirst = requestRender.calls.count();
        transformCountAfterFirst = transformWindowToDrawingBuffer.calls.count();
        second = scene.pickPosition(windowPosition);
      }).not.toThrow();

      expect(scene.frameState.frameNumber).toBe(frameNumber);
      expect(transformCountAfterFirst).toBe(1);
      expect(requestRender.calls.count()).toBe(requestCountAfterFirst);
      expect(transformWindowToDrawingBuffer.calls.count()).toBe(
        transformCountAfterFirst,
      );
      expect(defined(second)).toBe(defined(first));
      if (defined(first)) {
        expect(second).toEqual(first);
      } else {
        expect(second).toBeUndefined();
      }
    });

    it("stops requesting renders after a defined result", async function () {
      const windowPosition = positionWithOffset(SAMPLE_OFFSET);
      const convergence = await convergePickPosition(windowPosition);
      expect(convergence.position).toBeInstanceOf(Cartesian3);

      // Advance once so this query cannot be satisfied by the within-frame memo.
      scene.requestRender();
      scene.renderForSpecs();
      await yieldForGpuWork();

      const requestRender = spyOn(scene, "requestRender").and.callThrough();
      const transformWindowToDrawingBuffer = spyOn(
        SceneTransforms,
        "transformWindowToDrawingBuffer",
      ).and.callThrough();
      const frameNumber = scene.frameState.frameNumber;
      const repeated = scene.pickPosition(windowPosition);

      expect(repeated).toBeInstanceOf(Cartesian3);
      expect(transformWindowToDrawingBuffer).toHaveBeenCalledTimes(1);
      expect(requestRender).not.toHaveBeenCalled();

      scene.renderForSpecs();
      expect(scene.frameState.frameNumber).toBe(frameNumber);
    });

    it("stops requesting renders after a resolved missing depth", async function () {
      const windowPosition = new Cartesian2(0.0, 0.0);
      const convergence = await convergePickPosition(windowPosition);
      expect(convergence.position).toBeUndefined();

      // Advance once so this query cannot be satisfied by the within-frame memo.
      scene.requestRender();
      scene.renderForSpecs();
      await yieldForGpuWork();

      const requestRender = spyOn(scene, "requestRender").and.callThrough();
      const transformWindowToDrawingBuffer = spyOn(
        SceneTransforms,
        "transformWindowToDrawingBuffer",
      ).and.callThrough();
      const frameNumber = scene.frameState.frameNumber;
      const repeated = scene.pickPosition(windowPosition);

      expect(repeated).toBeUndefined();
      expect(transformWindowToDrawingBuffer).toHaveBeenCalledTimes(1);
      expect(requestRender).not.toHaveBeenCalled();

      scene.renderForSpecs();
      expect(scene.frameState.frameNumber).toBe(frameNumber);
    });
  },
);
