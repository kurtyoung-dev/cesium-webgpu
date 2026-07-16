import {
  Cartesian2,
  Cartesian3,
  ClippingPlane,
  Matrix4,
  VoxelBoundsCollection,
} from "../../index.js";

import createContext from "../../../../Specs/createContext.js";

describe(
  "Scene/VoxelBoundsCollection",
  function () {
    let context;

    beforeAll(function () {
      context = createContext();
    });

    afterAll(function () {
      context.destroyForSpecs();
    });

    function makeCollection() {
      return new VoxelBoundsCollection({
        planes: [
          new ClippingPlane(Cartesian3.UNIT_X, 1.0),
          new ClippingPlane(Cartesian3.UNIT_Y, 2.0),
        ],
      });
    }

    it("update creates the packed-planes texture sized from the context maximum texture size", function () {
      // Regression guard for the dropped maximumTextureSize argument
      // (C8-30 / item 64 voxel-limit cluster): update() called
      // computeTextureResolution(pixelsNeeded, scratch) with the scratch
      // Cartesian2 in the maximumTextureSize slot and result undefined,
      // throwing before any texture was created.
      const collection = makeCollection();
      const frameState = { context: context };

      expect(function () {
        collection.update(frameState, Matrix4.IDENTITY);
      }).not.toThrow();

      const texture = collection.texture;
      expect(texture).toBeDefined();
      expect(texture.width).toEqual(
        Math.min(collection.length, context.limits.maximumTextureSize),
      );
      // Twice the required height is allocated to avoid frequent reallocation.
      expect(texture.height).toEqual(
        2 * Math.ceil(collection.length / texture.width),
      );

      // A second update with unchanged planes reuses the texture.
      collection.update(frameState, Matrix4.IDENTITY);
      expect(collection.texture).toBe(texture);

      collection.destroy();
      expect(collection.isDestroyed()).toEqual(true);
    });

    it("getTextureResolution clamps to the context maximum texture size", function () {
      const collection = makeCollection();
      const result = new Cartesian2();
      const resolution = VoxelBoundsCollection.getTextureResolution(
        collection,
        context,
        result,
      );
      expect(resolution).toBe(result);
      expect(resolution.x).toEqual(
        Math.min(collection.length, context.limits.maximumTextureSize),
      );
      expect(resolution.y).toBeGreaterThanOrEqual(1);
    });

    it("update with no planes creates no texture", function () {
      const collection = new VoxelBoundsCollection();
      collection.update({ context: context }, Matrix4.IDENTITY);
      expect(collection.texture).toBeUndefined();
      collection.destroy();
    });
  },
  "WebGL",
);
