import { WebGPUVolumetricFogRenderer } from "../../../Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.js";
import SnapshotModeService from "../../../Source/Services/SnapshotModeService.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUVolumetricFogRenderer.update() needs a real GPUDevice to run
// its compute passes, but the snapshot freezable contract, the
// statistics getter, and the counter bumps are all independent of
// the device. These specs drive those surfaces directly via the
// `asFreezable()` helper so they run in any environment without
// WebGPU hardware.

function makeRenderer() {
  // `update()` is never called in these specs — we only touch the
  // freezable contract + getStatistics(). The fake device is just a
  // sentinel that lets `new WebGPUVolumetricFogRenderer(fakeDevice)`
  // run without crashing.
  return new WebGPUVolumetricFogRenderer(/** @type {any} */ ({}));
}

describe("Renderer/WebGPU/WebGPUVolumetricFogRenderer snapshot contract", function () {
  describe("asFreezable()", function () {
    it("returns a SnapshotFreezable-shaped object with the canonical name", function () {
      const renderer = makeRenderer();
      const freezable = renderer.asFreezable();
      expect(freezable.name).toBe("webgpu-volumetric-fog");
      expect(typeof freezable.freeze).toBe("function");
      expect(typeof freezable.thaw).toBe("function");
      expect(typeof freezable.isFrozen).toBe("function");
    });

    it("freeze() flips the internal frozen flag", function () {
      const renderer = makeRenderer();
      const f = renderer.asFreezable();
      expect(f.isFrozen()).toBe(false);
      f.freeze();
      expect(f.isFrozen()).toBe(true);
      expect(renderer.getStatistics().frozen).toBe(true);
    });

    it("thaw() clears the internal frozen flag", function () {
      const renderer = makeRenderer();
      const f = renderer.asFreezable();
      f.freeze();
      f.thaw();
      expect(f.isFrozen()).toBe(false);
      expect(renderer.getStatistics().frozen).toBe(false);
    });

    it("is idempotent under repeated freeze/thaw calls", function () {
      const renderer = makeRenderer();
      const f = renderer.asFreezable();
      f.freeze();
      f.freeze();
      expect(f.isFrozen()).toBe(true);
      f.thaw();
      f.thaw();
      expect(f.isFrozen()).toBe(false);
    });
  });

  describe("integration with SnapshotModeService", function () {
    it("can be registered as a freezable and responds to enter/exit", function () {
      const renderer = makeRenderer();
      const svc = new SnapshotModeService();
      svc.registerFreezable("webgpu-volumetric-fog", renderer.asFreezable());
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
      expect(renderer.getStatistics().frozen).toBe(false);
      svc.enter(fakeScene);
      expect(renderer.getStatistics().frozen).toBe(true);
      svc.exit(fakeScene);
      expect(renderer.getStatistics().frozen).toBe(false);
    });
  });

  describe("getStatistics()", function () {
    it("returns a permissive shape on a fresh renderer", function () {
      const renderer = makeRenderer();
      const stats = renderer.getStatistics();
      expect(stats.enabled).toBe(false);
      expect(stats.frozen).toBe(false);
      expect(stats.snapshotRegistered).toBe(false);
      expect(stats.destroyed).toBe(false);
      expect(stats.resolutionKey).toBeNull();
      expect(stats.dimensions).toBeNull();
      expect(stats.updatesDispatched).toBe(0);
      expect(stats.updatesSkippedFrozen).toBe(0);
      expect(stats.composites).toBe(0);
    });
  });
});
