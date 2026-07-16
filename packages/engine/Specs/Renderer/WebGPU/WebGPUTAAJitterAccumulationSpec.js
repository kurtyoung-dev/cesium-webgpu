import ClipSpaceConvention from "../../../Source/Core/ClipSpaceConvention.js";
import PerspectiveFrustum from "../../../Source/Core/PerspectiveFrustum.js";
import {
  WebGPUTAAEffect,
  applyProjectionJitterToScratch,
} from "../../../Source/Renderer/WebGPU/WebGPUTAAEffect.js";
import { WebGPUSceneRenderer } from "../../../Source/Renderer/WebGPU/WebGPUSceneRenderer.js";

describe("Renderer/WebGPU TAA jitter contract", function () {
  const width = 1920;
  const height = 1080;

  it("keeps projection NDC and resolve UV offsets explicit", function () {
    const taa = new WebGPUTAAEffect();

    for (let frame = 0; frame < 32; frame++) {
      const jitter = taa.computeJitter(frame, width, height);
      expect(jitter.projectionNdcX).toBe(jitter.resolveUvX * 2.0);
      expect(jitter.projectionNdcY).toBe(jitter.resolveUvY * 2.0);
      expect(taa.projectionJitterNdcX).toBe(jitter.projectionNdcX);
      expect(taa.projectionJitterNdcY).toBe(jitter.projectionNdcY);
      expect(taa.resolveJitterUvX).toBe(jitter.resolveUvX);
      expect(taa.resolveJitterUvY).toBe(jitter.resolveUvY);
      expect(Math.abs(jitter.projectionNdcX)).toBeLessThanOrEqual(1 / width);
      expect(Math.abs(jitter.projectionNdcY)).toBeLessThanOrEqual(1 / height);
    }
  });

  it("applies the WebGPU UV-sign conversion to perspective projections", function () {
    // Column-major perspective matrix: row3 is [0, 0, -1, 0].
    const projection = [
      1.2, 0, 0, 0, 0, 1.7, 0, 0, 0.25, -0.125, -1, -1, 0, 0, -2, 0,
    ];
    const base = projection.slice();
    const ndcX = 0.002;
    const ndcY = -0.004;

    applyProjectionJitterToScratch(projection, ndcX, ndcY);

    // X adds at [8], while Y subtracts at [9]. In framebuffer UV space both
    // raster shifts are undone by subtracting (ndc / 2) in the resolve.
    expect(projection[8]).toBe(base[8] + ndcX);
    expect(projection[9]).toBe(base[9] - ndcY);
    for (const i of [0, 1, 4, 5, 10, 11, 12, 13, 14, 15]) {
      expect(projection[i]).toBe(base[i]);
    }
  });

  it("uses homogeneous translation for orthographic projections", function () {
    // Column-major orthographic matrix: row3 is [0, 0, 0, 1].
    const projection = [
      0.5, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, -0.01, 0, 0.2, -0.3, -1.0, 1,
    ];
    const base = projection.slice();
    const ndcX = 0.002;
    const ndcY = -0.004;

    applyProjectionJitterToScratch(projection, ndcX, ndcY);

    expect(projection[12]).toBe(base[12] - ndcX);
    expect(projection[13]).toBe(base[13] + ndcY);
    expect(projection[8]).toBe(base[8]);
    expect(projection[9]).toBe(base[9]);
  });

  it("jitters only a reusable scratch frustum and restores it exactly", function () {
    const frustum = new PerspectiveFrustum({
      fov: 1.0,
      aspectRatio: 1.5,
      near: 1.0,
      far: 1000.0,
    });
    const cameraProjectionBefore = Array.from(
      frustum.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
    );
    const expectedBand = frustum.clone();
    expectedBand.near = 10.0;
    expectedBand.far = 100.0;

    const taa = new WebGPUTAAEffect();
    const renderer = new WebGPUSceneRenderer();
    let capturedProjection;
    const uniformState = {
      updateFrustum: function (workingFrustum) {
        capturedProjection = Array.from(
          workingFrustum.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
        );
        // Exercise the infinite-projection branch too; the renderer must
        // restore this cached matrix after UniformState has consumed it.
        workingFrustum.getInfiniteProjectionMatrix(ClipSpaceConvention.WEBGPU);
      },
    };
    const scene = {
      taaEnabled: true,
      _snapshotMode: { isFrozen: false },
      _alternateSceneRenderer: { _postProcess: { taaEffect: taa } },
      _frameState: {
        camera: { frustum },
        context: { clipSpaceConvention: ClipSpaceConvention.WEBGPU },
        passes: { render: true, pick: false },
      },
    };

    for (let frame = 0; frame < 120; frame++) {
      const jitter = taa.computeJitter(frame, width, height);
      const expectedProjection = Array.from(
        expectedBand.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
      );
      applyProjectionJitterToScratch(
        expectedProjection,
        jitter.projectionNdcX,
        jitter.projectionNdcY,
      );

      renderer._updateFrustumUniforms(uniformState, 10.0, 100.0, scene);
      expect(capturedProjection).toEqual(expectedProjection);
      expect(
        Array.from(frustum.getProjectionMatrix(ClipSpaceConvention.WEBGPU)),
      ).toEqual(cameraProjectionBefore);

      const scratch = renderer._frustumScratch;
      expect(
        Array.from(scratch.getProjectionMatrix(ClipSpaceConvention.WEBGPU)),
      ).toEqual(
        Array.from(
          expectedBand.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
        ),
      );
    }

    // Auxiliary pick/depth frames must use a deterministic unjittered
    // projection and must not inherit the last visible TAA sample offset.
    scene._frameState.passes.render = false;
    scene._frameState.passes.pick = true;
    renderer._updateFrustumUniforms(uniformState, 10.0, 100.0, scene);
    expect(capturedProjection).toEqual(
      Array.from(expectedBand.getProjectionMatrix(ClipSpaceConvention.WEBGPU)),
    );
  });

  it("freeze/reset produces an unjittered projection and zero resolve offset", function () {
    const taa = new WebGPUTAAEffect();
    taa.computeJitter(7, width, height);
    taa.resetJitter();
    expect(taa.projectionJitterNdcX).toBe(0);
    expect(taa.projectionJitterNdcY).toBe(0);
    expect(taa.resolveJitterUvX).toBe(0);
    expect(taa.resolveJitterUvY).toBe(0);

    const frustum = new PerspectiveFrustum({
      fov: 1.0,
      aspectRatio: 1.5,
      near: 1.0,
      far: 1000.0,
    });
    const expectedBand = frustum.clone();
    expectedBand.near = 10.0;
    expectedBand.far = 100.0;
    let capturedProjection;
    const renderer = new WebGPUSceneRenderer();
    renderer._updateFrustumUniforms(
      {
        updateFrustum: function (workingFrustum) {
          capturedProjection = Array.from(
            workingFrustum.getProjectionMatrix(ClipSpaceConvention.WEBGPU),
          );
        },
      },
      10.0,
      100.0,
      {
        taaEnabled: true,
        _snapshotMode: { isFrozen: true },
        _alternateSceneRenderer: { _postProcess: { taaEffect: taa } },
        _frameState: {
          camera: { frustum },
          context: { clipSpaceConvention: ClipSpaceConvention.WEBGPU },
          passes: { render: true, pick: false },
        },
      },
    );

    expect(capturedProjection).toEqual(
      Array.from(expectedBand.getProjectionMatrix(ClipSpaceConvention.WEBGPU)),
    );
  });
});
