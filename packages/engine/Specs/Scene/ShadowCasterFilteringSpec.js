import BoundingSphere from "../../Source/Core/BoundingSphere.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Pass from "../../Source/Renderer/Pass.js";
import OcclusionCulling from "../../Source/Scene/OcclusionCulling.js";
import SceneOctree from "../../Source/Scene/SceneOctree.js";
import ShadowMode from "../../Source/Scene/ShadowMode.js";
import { mergeShadowOnlyCasterCandidates } from "../../Source/Scene/View.js";
import {
  collectPrePvsShadowCasters,
  updateAndRenderPrimitives,
} from "../../Source/Scene/ViewportExecutor.js";

describe("Scene shadow-caster pre-PVS filtering", function () {
  function createCommand(options) {
    return {
      boundingVolume: new BoundingSphere(Cartesian3.ZERO, 1.0),
      pass: options.pass ?? Pass.OPAQUE,
      castShadows: options.castShadows ?? false,
    };
  }

  it("keeps active casters eligible for camera-only octree culling", function () {
    const octree = new SceneOctree({
      enabled: true,
      minCommandsForOctree: 1,
    });
    const opaqueCaster = createCommand({ castShadows: true });
    const translucentCaster = createCommand({
      castShadows: true,
      pass: Pass.TRANSLUCENT,
    });

    const result = octree.build([opaqueCaster, translucentCaster], 1);

    expect(result.useOctree).toBe(true);
    expect(result.octreeCommands).toBe(2);
    expect(result.bypassCommands.length).toBe(0);
  });

  it("captures active casters in a shadow-only pre-PVS side channel", function () {
    const shadowState = {
      shadowsEnabled: true,
      prePvsCasterCommands: [],
      prePvsCasterCommandSet: new Set(),
    };
    const opaqueCaster = createCommand({ castShadows: true });
    const translucentCaster = createCommand({
      castShadows: true,
      pass: Pass.TRANSLUCENT,
    });
    const nonCaster = createCommand({ castShadows: false });
    const overlay = createCommand({
      castShadows: true,
      pass: Pass.OVERLAY,
    });

    const result = collectPrePvsShadowCasters(
      [opaqueCaster, nonCaster, translucentCaster, opaqueCaster, overlay],
      shadowState,
      true,
    );

    expect(result).toBe(shadowState.prePvsCasterCommands);
    expect(result).toEqual([opaqueCaster, translucentCaster]);
  });

  it("does zero candidate work when shadows or camera filters are inactive", function () {
    const stale = createCommand({ castShadows: true });
    const shadowState = {
      shadowsEnabled: false,
      prePvsCasterCommands: [stale],
      prePvsCasterCommandSet: new Set([stale]),
    };
    const caster = createCommand({ castShadows: true });

    expect(collectPrePvsShadowCasters([caster], shadowState, true)).toEqual([]);

    shadowState.shadowsEnabled = true;
    shadowState.prePvsCasterCommands.push(stale);
    expect(collectPrePvsShadowCasters([caster], shadowState, false)).toEqual(
      [],
    );
  });

  it("keeps RECEIVE_ONLY and DISABLED commands cullable", function () {
    const receiveOnly = createCommand({
      castShadows: ShadowMode.castShadows(ShadowMode.RECEIVE_ONLY),
    });
    const disabled = createCommand({
      castShadows: ShadowMode.castShadows(ShadowMode.DISABLED),
    });

    const culling = new OcclusionCulling({ enabled: true, maxCommands: 2 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(0);
    const occlusionResult = culling.testCommands([receiveOnly, disabled]);

    expect(occlusionResult.visible.length).toBe(0);
    expect(occlusionResult.occluded).toEqual([receiveOnly, disabled]);
  });

  it("allows camera Hi-Z to reject casters without losing the side channel", function () {
    const culling = new OcclusionCulling({ enabled: true, maxCommands: 8 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(0);
    const casters = [
      Pass.GLOBE,
      Pass.CESIUM_3D_TILE,
      Pass.OPAQUE,
      Pass.TRANSLUCENT,
    ].map(function (pass) {
      return createCommand({ castShadows: true, pass: pass });
    });
    const shadowState = {
      shadowsEnabled: true,
      prePvsCasterCommands: [],
      prePvsCasterCommandSet: new Set(),
    };
    collectPrePvsShadowCasters(casters, shadowState, true);

    const result = culling.testCommands(casters);

    expect(result.visible.length).toBe(0);
    expect(result.occluded).toEqual(casters);
    expect(shadowState.prePvsCasterCommands).toEqual(casters);
  });

  it("merges filtered casters in original order without camera re-admission", function () {
    const first = createCommand({ castShadows: true });
    const filtered = createCommand({ castShadows: true });
    const last = createCommand({
      castShadows: true,
      pass: Pass.TRANSLUCENT,
    });
    const invalidated = createCommand({ castShadows: true });
    invalidated.castShadows = false;
    const candidates = [first, filtered, last, invalidated];
    const shadowCasters = [last, first];
    const seen = new Set([first, last]);
    const scene = {
      updateDerivedCommands: jasmine.createSpy("updateDerivedCommands"),
    };

    const result = mergeShadowOnlyCasterCandidates(
      scene,
      candidates,
      shadowCasters,
      seen,
    );

    expect(result).toBe(shadowCasters);
    expect(shadowCasters).toEqual([first, filtered, last]);
    expect(scene.updateDerivedCommands).toHaveBeenCalledTimes(1);
    expect(scene.updateDerivedCommands).toHaveBeenCalledWith(filtered);
  });

  it("C11-187 conservatively retains commands beyond SOA capacity", function () {
    const culling = new OcclusionCulling({ enabled: true, maxCommands: 1 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(0);
    const represented = createCommand({ castShadows: false });
    const tailCaster = createCommand({ castShadows: true });

    const result = culling.testCommands([represented, tailCaster]);

    expect(result.visible).toEqual([tailCaster]);
    expect(result.occluded).toEqual([represented]);
  });

  it("C11-187 conservatively retains unrepresentable volumes", function () {
    const culling = new OcclusionCulling({ enabled: true, maxCommands: 2 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(0);
    const caster = createCommand({ castShadows: true });
    caster.boundingVolume = {
      center: Cartesian3.ZERO,
      radius: Number.NaN,
    };

    const result = culling.testCommands([caster]);

    expect(result.visible).toEqual([caster]);
    expect(result.occluded.length).toBe(0);
  });

  it("C11-187 rejects non-finite, f32-overflowed, and non-positive spheres", function () {
    const culling = new OcclusionCulling({ enabled: true, maxCommands: 6 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(0);

    const nonFiniteCenter = createCommand({ castShadows: true });
    nonFiniteCenter.boundingVolume = {
      center: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
      radius: 1,
    };
    const overflowedCenter = createCommand({ castShadows: true });
    overflowedCenter.boundingVolume = {
      center: { x: Number.MAX_VALUE, y: 0, z: 0 },
      radius: 1,
    };
    const zeroRadius = createCommand({ castShadows: true });
    zeroRadius.boundingVolume = { center: Cartesian3.ZERO, radius: 0 };
    const negativeRadius = createCommand({ castShadows: true });
    negativeRadius.boundingVolume = { center: Cartesian3.ZERO, radius: -1 };
    const overflowedRadius = createCommand({ castShadows: true });
    overflowedRadius.boundingVolume = {
      center: Cartesian3.ZERO,
      radius: Number.MAX_VALUE,
    };
    const represented = createCommand({ castShadows: false });

    const result = culling.testCommands([
      nonFiniteCenter,
      overflowedCenter,
      zeroRadius,
      negativeRadius,
      overflowedRadius,
      represented,
    ]);

    expect(result.visible).toEqual([
      nonFiniteCenter,
      overflowedCenter,
      zeroRadius,
      negativeRadius,
      overflowedRadius,
    ]);
    expect(result.occluded).toEqual([represented]);
  });

  it("C11-187 preserves order around interleaved pass-through commands", function () {
    const culling = new OcclusionCulling({ enabled: true, maxCommands: 4 });
    culling.resultsReady = true;
    culling._soaLayout.visibility.fill(1);
    const first = createCommand({ castShadows: false });
    const unrepresented = createCommand({ castShadows: false });
    unrepresented.boundingVolume = undefined;
    const third = createCommand({ castShadows: false });
    const occluded = createCommand({ castShadows: false });
    culling._soaLayout.visibility[2] = 0;

    const result = culling.testCommands([
      first,
      unrepresented,
      third,
      occluded,
    ]);

    expect(result.visible).toEqual([first, unrepresented, third]);
    expect(result.occluded).toEqual([occluded]);
  });

  it("flushes shadow receive refreshes on the active viewport context", function () {
    const frameContext = {
      flushShadowReceiveUniformRefreshes:
        jasmine.createSpy("frameContextFlush"),
    };
    const sceneContext = {
      flushShadowReceiveUniformRefreshes:
        jasmine.createSpy("sceneContextFlush"),
    };
    const scene = {
      _frameState: {
        context: frameContext,
        edgeVisibilityRequested: false,
        passes: { pick: false, pickVoxel: false },
        shadowMaps: [],
        shadowState: {
          shadowsEnabled: false,
          lastDirtyTime: 0,
          shadowMaps: [],
          lightShadowMaps: [],
          lightShadowsEnabled: false,
        },
      },
      _groundPrimitives: { update: jasmine.createSpy("groundUpdate") },
      _primitives: { update: jasmine.createSpy("primitiveUpdate") },
      _enableEdgeVisibility: false,
      debugShowFrustumPlanes: false,
      _debugShowFrustumPlanes: false,
      context: sceneContext,
      mode: 3,
      _globe: undefined,
    };

    updateAndRenderPrimitives(scene);

    expect(frameContext.flushShadowReceiveUniformRefreshes).toHaveBeenCalled();
    expect(
      sceneContext.flushShadowReceiveUniformRefreshes,
    ).not.toHaveBeenCalled();
  });
});
