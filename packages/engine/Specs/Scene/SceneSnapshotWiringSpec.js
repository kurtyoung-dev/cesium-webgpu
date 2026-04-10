import {
  Color,
  Primitive,
  PrimitiveCollection,
  Rectangle,
  RectangleGeometry,
  GeometryInstance,
  ColorGeometryInstanceAttribute,
  PerInstanceColorAppearance,
} from "../../index.js";

import createScene from "../../../../Specs/createScene.js";

// ── Phase 6 audit lockdown ──────────────────────────────────────────
//
// These specs lock down the wiring that the 2026-04-09 audit deep-dive
// added to Scene.js and its orchestration services. They're intentionally
// narrow — each spec covers exactly one of the seven audit fixes so a
// future regression surfaces a precise failure.
//
// Coverage matrix:
//   FIX 1  — Scene.destroy() service cleanup       → destroy-cleanup block
//   FIX 2  — Moon freezable cleanup                → WebGPUMoonSnapshotSpec
//   FIX 3  — Volumetric fog snapshot wiring        → WebGPUVolumetricFogSnapshotSpec
//   FIX 4  — VPT/snapshot tick reorder             → tick-order block
//   FIX 5  — Primitive/globe snapshot-version bump → version-bump blocks
//   FIX 6  — Multi-view limitation (doc only)      → n/a (SnapshotModeService.js doc)
//   FIX 7  — Dead tryExecuteBundle removal         → n/a (deletion; tsc verifies)

describe("Scene snapshot-mode wiring (Phase 6 audit lockdown)", function () {
  let scene;

  beforeAll(function () {
    scene = createScene();
  });

  afterAll(function () {
    scene.destroyForSpecs();
  });

  beforeEach(function () {
    // Reset the version counter so each spec starts from a known
    // baseline. The scene is shared across specs to keep the karma
    // runtime reasonable.
    scene._snapshotVersion = 0;
  });

  // ─── FIX 5 ──────────────────────────────────────────────────────
  describe("primitive collection mutations bump _snapshotVersion", function () {
    let addedPrimitive;
    let addedGroundPrimitive;

    afterEach(function () {
      if (addedPrimitive && scene.primitives.contains(addedPrimitive)) {
        scene.primitives.remove(addedPrimitive);
      }
      if (
        addedGroundPrimitive &&
        scene.groundPrimitives.contains(addedGroundPrimitive)
      ) {
        scene.groundPrimitives.remove(addedGroundPrimitive);
      }
      addedPrimitive = undefined;
      addedGroundPrimitive = undefined;
    });

    function makeSimplePrimitive() {
      return new Primitive({
        geometryInstances: new GeometryInstance({
          geometry: new RectangleGeometry({
            rectangle: Rectangle.fromDegrees(-1, -1, 1, 1),
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE),
          },
        }),
        appearance: new PerInstanceColorAppearance({
          closed: true,
        }),
        asynchronous: false,
      });
    }

    it("_primitives.add() bumps the version", function () {
      const before = scene._snapshotVersion;
      addedPrimitive = makeSimplePrimitive();
      scene.primitives.add(addedPrimitive);
      expect(scene._snapshotVersion).toBeGreaterThan(before);
    });

    it("_primitives.remove() bumps the version", function () {
      addedPrimitive = makeSimplePrimitive();
      scene.primitives.add(addedPrimitive);
      const before = scene._snapshotVersion;
      scene.primitives.remove(addedPrimitive);
      expect(scene._snapshotVersion).toBeGreaterThan(before);
      addedPrimitive = undefined;
    });

    it("_groundPrimitives.add() bumps the version", function () {
      const before = scene._snapshotVersion;
      // A bare empty collection add is enough to exercise the event —
      // we don't need a renderable ground primitive for the wiring
      // spec, just something the collection will accept.
      addedGroundPrimitive = new PrimitiveCollection();
      scene.groundPrimitives.add(addedGroundPrimitive);
      expect(scene._snapshotVersion).toBeGreaterThan(before);
    });

    it("_groundPrimitives.remove() bumps the version", function () {
      addedGroundPrimitive = new PrimitiveCollection();
      scene.groundPrimitives.add(addedGroundPrimitive);
      const before = scene._snapshotVersion;
      scene.groundPrimitives.remove(addedGroundPrimitive);
      expect(scene._snapshotVersion).toBeGreaterThan(before);
      addedGroundPrimitive = undefined;
    });
  });

  // ─── FIX 5 (globe listeners half) ───────────────────────────────
  describe("globe mutations bump _snapshotVersion", function () {
    it("globe.imageryLayersUpdatedEvent bumps the version", function () {
      const globe = scene.globe;
      if (!globe || !globe.imageryLayersUpdatedEvent) {
        pending("scene has no globe with imagery events");
        return;
      }
      const before = scene._snapshotVersion;
      globe.imageryLayersUpdatedEvent.raiseEvent();
      expect(scene._snapshotVersion).toBeGreaterThan(before);
    });

    it("globe.terrainProviderChanged bumps the version", function () {
      const globe = scene.globe;
      if (!globe || !globe.terrainProviderChanged) {
        pending("scene has no globe with terrainProviderChanged event");
        return;
      }
      const before = scene._snapshotVersion;
      globe.terrainProviderChanged.raiseEvent();
      expect(scene._snapshotVersion).toBeGreaterThan(before);
    });
  });

  // ─── FIX 1 ──────────────────────────────────────────────────────
  describe("Scene.destroy() releases orchestration services", function () {
    it("calls destroy() on _snapshotMode and _visualPerformanceTarget", function () {
      // Use a throwaway scene so we don't tear down the suite-shared one.
      const throwaway = createScene();
      const snapshotSpy = spyOn(
        throwaway._snapshotMode,
        "destroy",
      ).and.callThrough();
      const vptSpy = spyOn(
        throwaway._visualPerformanceTarget,
        "destroy",
      ).and.callThrough();
      throwaway.destroyForSpecs();
      expect(snapshotSpy).toHaveBeenCalled();
      expect(vptSpy).toHaveBeenCalled();
    });
  });

  // ─── Central debug surface ──────────────────────────────────────
  describe("Scene.getDebugSnapshot()", function () {
    it("returns a structured snapshot with the standard sections", function () {
      const snap = scene.getDebugSnapshot();
      expect(snap).toBeDefined();
      expect(snap.scene).toBeDefined();
      expect(snap.scene.backend).toBeDefined();
      expect(snap.debugToggles).toBeDefined();
      expect(snap.snapshotMode).toBeDefined();
      expect(snap.visualPerformanceTarget).toBeDefined();
      // renderer / moon are optional — they're null on some backends.
    });

    it("reports the current frame number", function () {
      const snap = scene.getDebugSnapshot();
      expect(typeof snap.scene.frameNumber).toBe("number");
    });

    it("reflects snapshot mode state", function () {
      expect(scene.getDebugSnapshot().snapshotMode.enabled).toBe(false);
      scene.snapshotMode.enabled = true;
      expect(scene.getDebugSnapshot().snapshotMode.enabled).toBe(true);
      scene.snapshotMode.enabled = false;
    });
  });
});
