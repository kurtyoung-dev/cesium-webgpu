import {
  createMoonFreezable,
  getWebGPUMoonStatistics,
} from "../../../Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js";
import SnapshotModeService from "../../../Source/Services/SnapshotModeService.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// The moon's WebGPU path lives in a free function + cache closure
// rather than a class. Its freezable contract is defined by
// `createMoonFreezable(cache)` which returns a SnapshotFreezable
// bound to that cache object. These specs drive the contract
// directly on a fake cache so no GPU device is needed.

function makeFakeCache(overrides = {}) {
  return {
    _frozen: false,
    _snapshotRegistered: false,
    _snapshotService: undefined,
    ...overrides,
  };
}

describe("Renderer/WebGPU/WebGPUEnvironmentRenderer moon snapshot contract", function () {
  describe("createMoonFreezable()", function () {
    it("returns a SnapshotFreezable-shaped object with the canonical name", function () {
      const cache = makeFakeCache();
      const f = createMoonFreezable(cache);
      expect(f.name).toBe("moon-renderer");
      expect(typeof f.freeze).toBe("function");
      expect(typeof f.thaw).toBe("function");
      expect(typeof f.isFrozen).toBe("function");
    });

    it("freeze() sets cache._frozen = true", function () {
      const cache = makeFakeCache();
      const f = createMoonFreezable(cache);
      expect(cache._frozen).toBe(false);
      f.freeze();
      expect(cache._frozen).toBe(true);
      expect(f.isFrozen()).toBe(true);
    });

    it("thaw() clears cache._frozen", function () {
      const cache = makeFakeCache({ _frozen: true });
      const f = createMoonFreezable(cache);
      f.thaw();
      expect(cache._frozen).toBe(false);
      expect(f.isFrozen()).toBe(false);
    });

    it("binds to the cache reference, not its current state", function () {
      // Late mutations to the cache are visible through the freezable.
      const cache = makeFakeCache();
      const f = createMoonFreezable(cache);
      cache._frozen = true;
      expect(f.isFrozen()).toBe(true);
      cache._frozen = false;
      expect(f.isFrozen()).toBe(false);
    });
  });

  describe("integration with SnapshotModeService", function () {
    it("late-arrival registration during an active snapshot freezes immediately", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      const fakeScene = {
        _snapshotVersion: 0,
        _frameState: { frameNumber: 0 },
        camera: {
          positionWC: { x: 0, y: 0, z: 0 },
          directionWC: { x: 1, y: 0, z: 0 },
          upWC: { x: 0, y: 0, z: 1 },
        },
      };
      svc.enter(fakeScene);
      // Moon's first frame arrives mid-snapshot — its freezable must
      // freeze immediately so the very first writeBuffer is skipped.
      const cache = makeFakeCache();
      svc.registerFreezable("moon-renderer", createMoonFreezable(cache));
      expect(cache._frozen).toBe(true);
    });

    it("unregisterFreezable removes the moon registration cleanly", function () {
      const svc = new SnapshotModeService();
      const cache = makeFakeCache();
      svc.registerFreezable("moon-renderer", createMoonFreezable(cache));
      expect(svc.freezableCount).toBe(1);
      const removed = svc.unregisterFreezable("moon-renderer");
      expect(removed).toBe(true);
      expect(svc.freezableCount).toBe(0);
      // Post-unregister freeze/thaw cycles must NOT touch the cache.
      svc.enabled = true;
      svc.enter({
        _snapshotVersion: 0,
        _frameState: { frameNumber: 0 },
        camera: {
          positionWC: { x: 0, y: 0, z: 0 },
          directionWC: { x: 1, y: 0, z: 0 },
          upWC: { x: 0, y: 0, z: 1 },
        },
      });
      expect(cache._frozen).toBe(false);
    });
  });

  describe("getWebGPUMoonStatistics()", function () {
    it("returns null for a moon with no WebGPU cache yet", function () {
      const moon = {};
      expect(getWebGPUMoonStatistics(moon)).toBeNull();
    });

    it("reports cache readiness flags and unpacks the uniform tail", function () {
      // Simulate a post-update cache with the moon tail uniforms set
      // to the same offsets `_packMoonUniforms` uses (64..75).
      const uniformData = new Float32Array(85);
      uniformData[64] = 0.5;
      uniformData[65] = 0.0;
      uniformData[66] = 0.866;
      uniformData[67] = 0.73; // phaseFraction
      uniformData[68] = 1.0; // earthshineOn
      uniformData[69] = 1.0; // useLogDepth
      uniformData[70] = 5.0; // shininess
      uniformData[71] = 0.3; // specularStrength
      uniformData[76] = 0.9;
      uniformData[77] = 0.8;
      uniformData[78] = 0.7;
      uniformData[80] = 0.1;
      uniformData[81] = 0.2;
      uniformData[82] = 0.3;
      const moon = {
        _webgpuCache: {
          pipeline: {},
          bindGroup: {},
          moonTexture: {},
          moonTextureUrl: "moon.jpg",
          _bundleStale: false,
          _snapshotRegistered: true,
          _frozen: false,
          uniformData,
        },
      };
      const stats = getWebGPUMoonStatistics(moon);
      expect(stats).not.toBeNull();
      expect(stats.backend).toBe("webgpu");
      expect(stats.pipelineReady).toBe(true);
      expect(stats.bindGroupReady).toBe(true);
      expect(stats.moonTextureLoaded).toBe(true);
      expect(stats.moonTextureUrl).toBe("moon.jpg");
      expect(stats.bundleStale).toBe(false);
      expect(stats.snapshotRegistered).toBe(true);
      expect(stats.frozen).toBe(false);
      // moonDirectionWC is read straight out of a Float32Array, so the
      // values are the float32-truncated round-trip of the doubles packed
      // above (z: 0.866 reads back as 0.8659999966621399). Use the same
      // toBeCloseTo tolerance the phaseFraction/specularStrength checks
      // below use rather than exact toEqual on float32 round-trips.
      expect(stats.moonDirectionWC.x).toBeCloseTo(0.5, 5);
      expect(stats.moonDirectionWC.y).toBeCloseTo(0.0, 5);
      expect(stats.moonDirectionWC.z).toBeCloseTo(0.866, 5);
      expect(stats.phaseFraction).toBeCloseTo(0.73, 5);
      expect(stats.earthshineOn).toBe(true);
      expect(stats.useLogDepth).toBe(true);
      expect(stats.shininess).toBe(5.0);
      expect(stats.specularStrength).toBeCloseTo(0.3, 5);
      expect(Object.isFrozen(stats)).toBe(true);
      expect(Object.isFrozen(stats.moonDirectionWC)).toBe(true);
      expect(Object.isFrozen(stats.atmosphereExtinction)).toBe(true);
      expect(Object.isFrozen(stats.atmosphereInscatter)).toBe(true);
      expect(Object.isFrozen(stats.sourceCache)).toBe(true);
    });

    it("reports flat staged/current lifecycle identities and scalar counters", function () {
      const pairA = '["moon-a.jpg","normal-a.png"]';
      const pairB = '["moon-b.jpg","normal-b.png"]';
      const gpuCandidate = { label: "must not escape" };
      const lifecycle = {
        cacheSerial: 7,
        resourceGeneration: 4,
        retired: false,
        channels: {
          albedo: {
            requestSerial: 3,
            state: "candidate-ready",
            desiredUrl: "moon-b.jpg",
            desiredPairKey: pairB,
            demanded: true,
            request: undefined,
            staged: {
              identity: { exactUrl: "moon-b.jpg", effectivePair: pairB },
              candidate: { value: gpuCandidate },
            },
            currentIdentity: {
              exactUrl: "moon-a.jpg",
              effectivePair: pairA,
            },
            gpuRealizations: 2,
            successfulUploads: 2,
            publications: 1,
            staleCandidateDestroys: 1,
            failedCandidateDestroys: 0,
            cancellations: 1,
            lastCancellationReason: "superseded",
          },
          normal: {
            requestSerial: 2,
            state: "source-pending",
            desiredUrl: "normal-b.png",
            desiredPairKey: pairB,
            demanded: true,
            request: {
              identity: { exactUrl: "normal-b.png", effectivePair: pairB },
            },
            staged: undefined,
            currentIdentity: undefined,
            gpuRealizations: 1,
            successfulUploads: 0,
            publications: 0,
            staleCandidateDestroys: 0,
            failedCandidateDestroys: 1,
            cancellations: 0,
            lastCancellationReason: undefined,
          },
        },
      };
      const moon = {
        _webgpuCache: {
          _moonTextureLifecycle: lifecycle,
          moonTexture: {},
          normalTexture: {},
          normalPlaceholderTexture: {},
        },
      };

      const stats = getWebGPUMoonStatistics(moon);
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.moonTextureLoaded).toBe(true);
      expect(stats.moonTextureUrl).toBe("moon-a.jpg");
      expect(stats.albedoDesiredUrl).toBe("moon-b.jpg");
      expect(stats.albedoEffectivePair).toBe(pairB);
      expect(stats.albedoCurrentUrl).toBe("moon-a.jpg");
      expect(stats.albedoCurrentPair).toBe(pairA);
      expect(stats.albedoPendingUrl).toBe("moon-b.jpg");
      expect(stats.albedoPendingPair).toBe(pairB);
      expect(stats.albedoCandidateReady).toBe(true);
      expect(stats.albedoGpuRealizations).toBe(2);
      expect(stats.albedoSuccessfulUploads).toBe(2);
      expect(stats.albedoPublications).toBe(1);
      expect(stats.albedoStaleCandidateDestroys).toBe(1);
      expect(stats.normalPendingUrl).toBe("normal-b.png");
      expect(stats.normalPendingPair).toBe(pairB);
      expect(stats.normalFailedCandidateDestroys).toBe(1);
      expect(Object.values(stats)).not.toContain(gpuCandidate);
      expect(stats.sourceCache.entries.every((entry) => !entry.source)).toBe(
        true,
      );
    });
  });
});
