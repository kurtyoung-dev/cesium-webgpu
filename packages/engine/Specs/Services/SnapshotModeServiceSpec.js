import SnapshotModeService from "../../Source/Services/SnapshotModeService.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// SnapshotModeService is intentionally backend-neutral and reads only
// `scene._snapshotVersion`, `scene._frameState.frameNumber`, and the
// camera position/direction/up. We mock the bare minimum so the specs
// don't pull in real Cesium scene scaffolding.

function makeMockScene(overrides = {}) {
  return {
    _snapshotVersion: 0,
    _frameState: { frameNumber: 0 },
    camera: {
      positionWC: new Cartesian3(0, 0, 0),
      directionWC: new Cartesian3(1, 0, 0),
      upWC: new Cartesian3(0, 0, 1),
    },
    ...overrides,
  };
}

function makeMockFreezable() {
  const calls = { freeze: 0, thaw: 0 };
  const f = {
    freeze: () => {
      calls.freeze++;
    },
    thaw: () => {
      calls.thaw++;
    },
  };
  return { freezable: f, calls };
}

describe("Services/SnapshotModeService", function () {
  describe("enabled flag", function () {
    it("defaults to false", function () {
      const svc = new SnapshotModeService();
      expect(svc.enabled).toBe(false);
    });

    it("can be toggled on and off", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      expect(svc.enabled).toBe(true);
      svc.enabled = false;
      expect(svc.enabled).toBe(false);
    });

    it("disabling while frozen auto-thaws", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      expect(svc.isFrozen).toBe(true);
      expect(calls.freeze).toBe(1);
      svc.enabled = false;
      expect(svc.isFrozen).toBe(false);
      expect(calls.thaw).toBe(1);
    });
  });

  describe("freezable registry", function () {
    it("registers and unregisters freezables", function () {
      const svc = new SnapshotModeService();
      const { freezable } = makeMockFreezable();
      svc.registerFreezable("a", freezable);
      expect(svc.freezableCount).toBe(1);
      const removed = svc.unregisterFreezable("a");
      expect(removed).toBe(true);
      expect(svc.freezableCount).toBe(0);
    });

    it("late registrants joining a frozen snapshot freeze immediately", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.enter(makeMockScene());
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("late", freezable);
      expect(calls.freeze).toBe(1);
    });
  });

  describe("enter / exit", function () {
    it("calls freeze() on every freezable when entering", function () {
      const svc = new SnapshotModeService();
      const a = makeMockFreezable();
      const b = makeMockFreezable();
      svc.registerFreezable("a", a.freezable);
      svc.registerFreezable("b", b.freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      expect(a.calls.freeze).toBe(1);
      expect(b.calls.freeze).toBe(1);
    });

    it("captures the snapshot version baseline at enter time", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      const scene = makeMockScene({ _snapshotVersion: 42 });
      svc.enter(scene);
      expect(svc.baselineSnapshotVersion).toBe(42);
    });

    it("enter while not enabled is a no-op", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enter(makeMockScene());
      expect(svc.isFrozen).toBe(false);
      expect(calls.freeze).toBe(0);
    });

    it("enter is idempotent — second call is a no-op", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      svc.enter(makeMockScene());
      expect(calls.freeze).toBe(1);
    });

    it("exit calls thaw() on every freezable", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      svc.exit(makeMockScene());
      expect(calls.thaw).toBe(1);
      expect(svc.isFrozen).toBe(false);
    });
  });

  describe("snapshotVersion auto-thaw (tick)", function () {
    it("auto-thaws when snapshot version advances past the baseline", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      const scene = makeMockScene({ _snapshotVersion: 1 });
      svc.enter(scene);
      // Bump version
      scene._snapshotVersion = 2;
      svc.tick(scene);
      expect(svc.isFrozen).toBe(false);
      expect(calls.thaw).toBe(1);
      expect(svc.getStatistics().autoThawCount).toBe(1);
      expect(svc.getStatistics().lastThawReason).toContain("snapshotVersion");
    });

    it("does not thaw when version is unchanged", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      const scene = makeMockScene({ _snapshotVersion: 1 });
      svc.enter(scene);
      svc.tick(scene);
      svc.tick(scene);
      expect(svc.isFrozen).toBe(true);
      expect(calls.thaw).toBe(0);
    });
  });

  describe("camera-delta auto-thaw (Phase 6B)", function () {
    it("does not thaw when camera is stationary", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      const scene = makeMockScene();
      svc.enter(scene);
      svc.tickCamera(scene);
      expect(svc.isFrozen).toBe(true);
    });

    it("auto-thaws when camera position exceeds threshold", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.cameraDeltaPositionThreshold = 0.5;
      const scene = makeMockScene();
      svc.enter(scene);
      // Move camera 1m
      scene.camera.positionWC = new Cartesian3(1, 0, 0);
      svc.tickCamera(scene);
      expect(svc.isFrozen).toBe(false);
      expect(svc.getStatistics().cameraThawCount).toBe(1);
      expect(svc.getStatistics().lastThawReason).toContain("position delta");
    });

    it("auto-thaws when camera direction exceeds rotation threshold", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.cameraDeltaRotationThreshold = 0.01; // ~0.57 degrees
      const scene = makeMockScene();
      svc.enter(scene);
      // Rotate forward direction by ~10 degrees (well past threshold)
      const angle = (10 * Math.PI) / 180;
      scene.camera.directionWC = new Cartesian3(
        Math.cos(angle),
        Math.sin(angle),
        0,
      );
      svc.tickCamera(scene);
      expect(svc.isFrozen).toBe(false);
      expect(svc.getStatistics().cameraThawCount).toBe(1);
      expect(svc.getStatistics().lastThawReason).toContain("direction angle");
    });

    it("auto-thaws on pure roll (up vector change without direction change)", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.cameraDeltaRotationThreshold = 0.01;
      const scene = makeMockScene();
      svc.enter(scene);
      // Roll the up vector by ~30 degrees while keeping direction the same
      const angle = (30 * Math.PI) / 180;
      scene.camera.upWC = new Cartesian3(0, Math.sin(angle), Math.cos(angle));
      svc.tickCamera(scene);
      expect(svc.isFrozen).toBe(false);
      expect(svc.getStatistics().lastThawReason).toContain("up angle");
    });

    it("respects sub-threshold camera jitter", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.cameraDeltaPositionThreshold = 1.0;
      const scene = makeMockScene();
      svc.enter(scene);
      // Tiny 0.1m jitter — should NOT thaw
      scene.camera.positionWC = new Cartesian3(0.1, 0, 0);
      svc.tickCamera(scene);
      expect(svc.isFrozen).toBe(true);
      expect(svc.getStatistics().cameraThawCount).toBe(0);
    });
  });

  describe("markDirty (Phase 6C)", function () {
    it("auto-thaws with the supplied reason", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      svc.markDirty("test reason");
      expect(svc.isFrozen).toBe(false);
      expect(calls.thaw).toBe(1);
      expect(svc.getStatistics().lastThawReason).toBe("test reason");
      expect(svc.getStatistics().manualThawCount).toBe(1);
    });

    it("is a no-op when not currently frozen", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      // Not in snapshot mode
      svc.markDirty("anything");
      expect(svc.getStatistics().manualThawCount).toBe(0);
    });

    it("uses a default reason when one is not supplied", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.enter(makeMockScene());
      svc.markDirty();
      expect(svc.getStatistics().lastThawReason).toContain("markDirty");
    });
  });

  describe("notifyFrame + auto-enter (requestRenderMode coordination)", function () {
    it("idle frames are tracked even when auto-enter is disabled", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      // autoEnterIdleFrames defaults to 0 → auto-enter disabled
      const scene = makeMockScene();
      svc.notifyFrame(scene, false); // idle
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
      expect(svc.getStatistics().autoEnterCount).toBe(0);
    });

    it("auto-enters after the configured idle threshold", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.autoEnterIdleFrames = 5;
      const scene = makeMockScene();
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
      // 5th idle frame triggers entry
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(true);
      expect(svc.getStatistics().autoEnterCount).toBe(1);
      expect(svc.getStatistics().lastAutoEnterReason).toContain(
        "consecutive idle frames",
      );
    });

    it("a render frame resets the idle counter", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.autoEnterIdleFrames = 5;
      const scene = makeMockScene();
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, true); // render — counter resets
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
    });

    it("does not auto-enter when not enabled", function () {
      const svc = new SnapshotModeService();
      // Service disabled
      svc.autoEnterIdleFrames = 2;
      const scene = makeMockScene();
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
      expect(svc.getStatistics().autoEnterCount).toBe(0);
    });

    it("setting autoEnterIdleFrames=0 resets the idle counter", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.autoEnterIdleFrames = 5;
      const scene = makeMockScene();
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      // Disable auto-enter mid-stream
      svc.autoEnterIdleFrames = 0;
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
    });

    it("after a thaw the idle counter resets so auto-entry doesn't fire on the next idle frame", function () {
      const svc = new SnapshotModeService();
      svc.enabled = true;
      svc.autoEnterIdleFrames = 3;
      const scene = makeMockScene();
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(true);
      // External thaw via markDirty
      svc.markDirty("explicit");
      expect(svc.isFrozen).toBe(false);
      // The very next idle frame should NOT auto-enter
      svc.notifyFrame(scene, false);
      expect(svc.isFrozen).toBe(false);
    });
  });

  describe("destroy", function () {
    it("releases registered freezables", function () {
      const svc = new SnapshotModeService();
      const { freezable } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.destroy();
      expect(svc.freezableCount).toBe(0);
    });

    it("auto-thaws if currently frozen", function () {
      const svc = new SnapshotModeService();
      const { freezable, calls } = makeMockFreezable();
      svc.registerFreezable("test", freezable);
      svc.enabled = true;
      svc.enter(makeMockScene());
      svc.destroy();
      expect(calls.thaw).toBe(1);
    });
  });
});
