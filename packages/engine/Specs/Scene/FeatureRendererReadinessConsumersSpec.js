import GaussianSplatPrimitive from "../../Source/Scene/GaussianSplatPrimitive.js";
import PointCloud from "../../Source/Scene/PointCloud.js";
import PointCloudEyeDomeLighting from "../../Source/Scene/PointCloudEyeDomeLighting.js";
import VoxelPrimitive from "../../Source/Scene/VoxelPrimitive.js";

describe("Scene/FeatureRendererReadinessConsumers", function () {
  function makeFrameState(kind) {
    return {
      context: {
        getFeatureRendererReadiness: function () {
          return {
            kind: kind,
            generation: 7,
            promise: Promise.resolve(undefined),
            error: new Error("stable loader failure"),
          };
        },
      },
      pixelRatio: 1,
    };
  }

  for (const kind of ["loading", "failed"]) {
    it(`FAR-103 does not enter PointCloud's legacy path while ${kind}`, function () {
      const pointCloud = Object.create(PointCloud.prototype);
      expect(function () {
        pointCloud.update(makeFrameState(kind));
      }).not.toThrow();
    });

    it(`FAR-103 does not enter GaussianSplat's legacy path while ${kind}`, function () {
      const primitive = Object.create(GaussianSplatPrimitive.prototype);
      expect(function () {
        primitive.update(makeFrameState(kind));
      }).not.toThrow();
    });

    it(`FAR-103 does not enter VoxelPrimitive's legacy path while ${kind}`, function () {
      const primitive = Object.create(VoxelPrimitive.prototype);
      expect(function () {
        primitive.update(makeFrameState(kind));
      }).not.toThrow();
    });

    it(`FAR-103 does not enter point-cloud EDL's legacy path while ${kind}`, function () {
      const processor = Object.create(PointCloudEyeDomeLighting.prototype);
      expect(function () {
        processor.update(
          makeFrameState(kind),
          0,
          {
            eyeDomeLightingStrength: 1,
            eyeDomeLightingRadius: 1,
          },
          undefined,
        );
      }).not.toThrow();
    });
  }
});
