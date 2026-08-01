import BoundingSphere from "../../Source/Core/BoundingSphere.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import CullingVolume from "../../Source/Core/CullingVolume.js";
import Intersect from "../../Source/Core/Intersect.js";
import Matrix4 from "../../Source/Core/Matrix4.js";
import { executeShadowMapCastCommands } from "../../Source/Scene/SceneRenderer.js";
import { computeOmnidirectional } from "../../Source/Scene/ShadowMapComputations.js";

describe("Scene point-shadow face culling", function () {
  function createCamera() {
    return {
      positionWC: new Cartesian3(),
      positionCartographic: {},
      directionWC: new Cartesian3(),
      upWC: new Cartesian3(),
      rightWC: new Cartesian3(),
      viewMatrix: new Matrix4(),
      inverseViewMatrix: new Matrix4(),
      frustum: undefined,
    };
  }

  function createPointShadowMap() {
    const passes = new Array(6);
    for (let i = 0; i < passes.length; ++i) {
      passes[i] = {
        camera: createCamera(),
        commandList: [],
        cullingVolume: undefined,
      };
    }

    return {
      _pointLightRadius: 100.0,
      _pointLightFrustum: undefined,
      _shadowMapCamera: {
        positionWC: new Cartesian3(0.0, 0.0, 0.0),
      },
      _passes: passes,
      shadowMapCullingVolume: new CullingVolume(),
      isPointLight: true,
      passes: passes,
      outOfView: false,
    };
  }

  const frameState = {
    mapProjection: {
      ellipsoid: {
        cartesianToCartographic: function (position, result) {
          return result;
        },
      },
    },
  };

  function populatePasses(shadowMap, casters) {
    const context = {
      executeShadowMapCastCommands: jasmine
        .createSpy("executeShadowMapCastCommands")
        .and.returnValue(true),
    };
    const scene = {
      _context: context,
      frameState: {
        shadowState: {
          shadowsEnabled: true,
          shadowMaps: [shadowMap],
          casterCommands: casters,
        },
      },
      isVisible: function (cullingVolume, command) {
        return (
          cullingVolume.computeVisibility(command.boundingVolume) !==
          Intersect.OUTSIDE
        );
      },
    };

    executeShadowMapCastCommands(scene);
  }

  it("reuses the shared point frustum and pass-owned culling volumes", function () {
    const shadowMap = createPointShadowMap();

    computeOmnidirectional(shadowMap, frameState);

    const frustum = shadowMap._pointLightFrustum;
    const cullingVolumes = shadowMap.passes.map(function (pass) {
      expect(pass.camera.frustum).toBe(frustum);
      return pass.cullingVolume;
    });
    expect(new Set(cullingVolumes).size).toBe(6);
    expect(cullingVolumes[0].planes[0]).not.toBe(cullingVolumes[1].planes[0]);

    computeOmnidirectional(shadowMap, frameState);

    expect(shadowMap._pointLightFrustum).toBe(frustum);
    for (let i = 0; i < shadowMap.passes.length; ++i) {
      expect(shadowMap.passes[i].camera.frustum).toBe(frustum);
      expect(shadowMap.passes[i].cullingVolume).toBe(cullingVolumes[i]);
    }
  });

  it("keeps a +X-only caster out of unrelated point-shadow faces", function () {
    const shadowMap = createPointShadowMap();
    computeOmnidirectional(shadowMap, frameState);
    const caster = {
      boundingVolume: new BoundingSphere(new Cartesian3(10.0, 0.0, 0.0), 0.25),
      cull: true,
    };

    populatePasses(shadowMap, [caster]);

    expect(
      shadowMap.passes.map(function (pass) {
        return pass.commandList.includes(caster);
      }),
    ).toEqual([false, false, false, true, false, false]);
  });

  it("retains a seam-spanning caster in both adjacent faces", function () {
    const shadowMap = createPointShadowMap();
    computeOmnidirectional(shadowMap, frameState);
    const caster = {
      boundingVolume: new BoundingSphere(new Cartesian3(10.0, 10.0, 0.0), 1.0),
      cull: true,
    };

    populatePasses(shadowMap, [caster]);

    expect(shadowMap.passes[3].commandList).toContain(caster);
    expect(shadowMap.passes[4].commandList).toContain(caster);
  });
});
