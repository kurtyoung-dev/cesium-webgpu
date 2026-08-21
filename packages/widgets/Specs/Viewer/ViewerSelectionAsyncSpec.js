import {
  Cartesian2,
  Cartesian3,
  ConstantPositionProperty,
  Entity,
  ScreenSpaceEventType,
} from "@cesium/engine";

import createViewer from "../createViewer.js";

// Click-driven selection and tracking resolve asynchronously, which makes two
// properties load-bearing:
//
//   1. A pick that could not be answered must never clear what the user
//      already selected or tracked. Only an answered pick that found nothing
//      may clear. A backend whose pick buffer is read back asynchronously
//      declines a synchronous pick exactly while the view is moving, so
//      treating a decline as a miss deselects on a click during post-drag
//      inertia and stops tracking on a double click of the tracked entity.
//   2. Because the answer arrives later than the click, two clicks can resolve
//      out of order. The newest request wins regardless of which pick returns
//      first.
//
// Each property is asserted together with a control that proves the assertion
// is discriminating: the clearing path still works, and the value withheld by
// the ordering guard was one the viewer would otherwise have installed.

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (innerResolve, innerReject) {
    resolve = innerResolve;
    reject = innerReject;
  });
  return {
    promise: promise,
    resolve: resolve,
    reject: reject,
  };
}

// A macrotask boundary is strictly later than every microtask queued by the
// pick chain, so one turn of this is enough to settle a resolved pick no matter
// how many awaits it passes through.
function settlePicks() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

function positionedEntity() {
  const entity = new Entity();
  entity.position = new ConstantPositionProperty(
    new Cartesian3(123456, 123456, 123456),
  );
  return entity;
}

function pickedObjectFor(entity) {
  return { id: entity, primitive: {} };
}

function fireClick(viewer, eventType) {
  const action =
    viewer.cesiumWidget.screenSpaceEventHandler.getInputAction(eventType);
  expect(action).toBeDefined();
  action({ position: new Cartesian2(1, 1) });
}

function leftClick(viewer) {
  fireClick(viewer, ScreenSpaceEventType.LEFT_CLICK);
}

function leftDoubleClick(viewer) {
  fireClick(viewer, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}

describe(
  "Widgets/Viewer/Viewer asynchronous selection",
  function () {
    // No globe means Scene.imageryLayers is undefined and there is no tileset
    // to fall back to, so an answered miss stays a miss instead of turning
    // into an imagery-layer feature request whose result would land later.
    function viewerOptions() {
      return {
        globe: false,
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        projectionPicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        selectionIndicator: false,
        infoBox: false,
        useDefaultRenderLoop: false,
      };
    }

    let container;
    let viewer;

    beforeEach(function () {
      container = document.createElement("div");
      container.id = "container";
      container.style.width = "1px";
      container.style.height = "1px";
      container.style.overflow = "hidden";
      container.style.position = "relative";
      document.body.appendChild(container);
    });

    afterEach(function () {
      if (viewer && !viewer.isDestroyed()) {
        viewer = viewer.destroy();
      }
      viewer = undefined;
      document.body.removeChild(container);
    });

    it("picks asynchronously so a decline is never mistaken for a miss", function () {
      viewer = createViewer(container, viewerOptions());
      const pickAsync = spyOn(viewer.scene, "pickAsync").and.returnValue(
        Promise.resolve(undefined),
      );
      // A synchronous pick must not be reachable from either handler: it is the
      // path that cannot answer during camera motion.
      const pick = spyOn(viewer.scene, "pick").and.returnValue(undefined);

      leftClick(viewer);
      leftDoubleClick(viewer);

      expect(pickAsync.calls.count()).toBe(2);
      expect(pick).not.toHaveBeenCalled();
    });

    describe("selectedEntity", function () {
      it("selects the entity an answered click found", async function () {
        viewer = createViewer(container, viewerOptions());
        const entity = positionedEntity();
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.resolve(pickedObjectFor(entity)),
        );

        leftClick(viewer);
        await settlePicks();

        expect(viewer.selectedEntity).toBe(entity);
      });

      // Control for the two tests below: the clearing path is live, so a test
      // that observes an intact selection is observing the guard and not a
      // viewer that never clears.
      it("clears the selection when an answered click found nothing", async function () {
        viewer = createViewer(container, viewerOptions());
        const entity = positionedEntity();
        viewer.selectedEntity = entity;
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.resolve(undefined),
        );

        leftClick(viewer);
        await settlePicks();

        expect(viewer.selectedEntity).toBeUndefined();
      });

      it("keeps the selection when the click could not be answered", async function () {
        viewer = createViewer(container, viewerOptions());
        const consoleError = spyOn(console, "error");
        const entity = positionedEntity();
        viewer.selectedEntity = entity;
        const failure = new Error("pick could not be answered");
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.reject(failure),
        );

        leftClick(viewer);
        await settlePicks();

        expect(viewer.selectedEntity).toBe(entity);
        // The selection survives, but the failure is a real one and must still
        // be reported rather than swallowed.
        expect(consoleError).toHaveBeenCalledWith(failure);
      });

      it("does not fire the selection indicator's depart animation on an unanswered click", async function () {
        const options = viewerOptions();
        options.selectionIndicator = true;
        viewer = createViewer(container, options);
        spyOn(console, "error");

        const entity = positionedEntity();
        viewer.selectedEntity = entity;

        const viewModel = viewer.selectionIndicator.viewModel;
        const animateDepart = spyOn(viewModel, "animateDepart");

        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.reject(new Error("pick could not be answered")),
        );

        leftClick(viewer);
        await settlePicks();

        expect(viewer.selectedEntity).toBe(entity);
        expect(animateDepart).not.toHaveBeenCalled();
      });

      it("does not install a stale selection when clicks resolve out of order", async function () {
        viewer = createViewer(container, viewerOptions());
        const first = makeDeferred();
        const second = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValues(
          first.promise,
          second.promise,
        );

        const staleEntity = positionedEntity();
        const currentEntity = positionedEntity();

        leftClick(viewer);
        leftClick(viewer);

        second.resolve(pickedObjectFor(currentEntity));
        await settlePicks();
        expect(viewer.selectedEntity).toBe(currentEntity);

        // The superseded pick answers late. Chaining would let it win; the
        // sequence guard drops it.
        first.resolve(pickedObjectFor(staleEntity));
        await settlePicks();
        expect(viewer.selectedEntity).toBe(currentEntity);
      });

      // Control for the test above: the value the ordering guard withheld is
      // one this viewer would otherwise have installed, so that assertion is
      // not passing because the picked object was unusable.
      it("would have installed the stale click's entity had it not been superseded", async function () {
        viewer = createViewer(container, viewerOptions());
        const first = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValue(first.promise);

        const staleEntity = positionedEntity();

        leftClick(viewer);
        first.resolve(pickedObjectFor(staleEntity));
        await settlePicks();

        expect(viewer.selectedEntity).toBe(staleEntity);
      });

      it("does not let a superseded miss clear a newer selection", async function () {
        viewer = createViewer(container, viewerOptions());
        const first = makeDeferred();
        const second = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValues(
          first.promise,
          second.promise,
        );

        const currentEntity = positionedEntity();

        leftClick(viewer);
        leftClick(viewer);

        second.resolve(pickedObjectFor(currentEntity));
        await settlePicks();
        expect(viewer.selectedEntity).toBe(currentEntity);

        first.resolve(undefined);
        await settlePicks();
        expect(viewer.selectedEntity).toBe(currentEntity);
      });

      it("writes nothing when the pick resolves after the viewer is destroyed", async function () {
        viewer = createViewer(container, viewerOptions());
        const consoleError = spyOn(console, "error");
        const pending = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValue(pending.promise);

        leftClick(viewer);
        const destroyed = viewer;
        viewer = viewer.destroy();

        pending.resolve(pickedObjectFor(positionedEntity()));
        await settlePicks();

        expect(destroyed.isDestroyed()).toBe(true);
        expect(destroyed.selectedEntity).toBeUndefined();
        expect(consoleError).not.toHaveBeenCalled();
      });
    });

    describe("trackedEntity", function () {
      it("tracks the entity an answered double click found", async function () {
        viewer = createViewer(container, viewerOptions());
        const entity = positionedEntity();
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.resolve(pickedObjectFor(entity)),
        );

        leftDoubleClick(viewer);
        await settlePicks();

        expect(viewer.trackedEntity).toBe(entity);
      });

      // Control: tracking is still cleared by an answered miss, so an intact
      // tracked entity below is the guard and not a viewer that never clears.
      it("stops tracking when an answered double click found nothing", async function () {
        viewer = createViewer(container, viewerOptions());
        const entity = positionedEntity();
        viewer.trackedEntity = entity;
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.resolve(undefined),
        );

        leftDoubleClick(viewer);
        await settlePicks();

        expect(viewer.trackedEntity).toBeUndefined();
      });

      it("keeps tracking when the double click could not be answered", async function () {
        viewer = createViewer(container, viewerOptions());
        const consoleError = spyOn(console, "error");
        const entity = positionedEntity();
        viewer.trackedEntity = entity;
        const failure = new Error("pick could not be answered");
        spyOn(viewer.scene, "pickAsync").and.returnValue(
          Promise.reject(failure),
        );

        leftDoubleClick(viewer);
        await settlePicks();

        // Tracking guarantees camera motion, which is the very condition that
        // makes a pick unanswerable, so this is the feature's default case.
        expect(viewer.trackedEntity).toBe(entity);
        expect(consoleError).toHaveBeenCalledWith(failure);
      });

      it("does not install a stale tracked entity when double clicks resolve out of order", async function () {
        viewer = createViewer(container, viewerOptions());
        const first = makeDeferred();
        const second = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValues(
          first.promise,
          second.promise,
        );

        const staleEntity = positionedEntity();
        const currentEntity = positionedEntity();

        leftDoubleClick(viewer);
        leftDoubleClick(viewer);

        second.resolve(pickedObjectFor(currentEntity));
        await settlePicks();
        expect(viewer.trackedEntity).toBe(currentEntity);

        first.resolve(pickedObjectFor(staleEntity));
        await settlePicks();
        expect(viewer.trackedEntity).toBe(currentEntity);
      });

      it("does not let a superseded miss stop tracking", async function () {
        viewer = createViewer(container, viewerOptions());
        const first = makeDeferred();
        const second = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValues(
          first.promise,
          second.promise,
        );

        const currentEntity = positionedEntity();

        leftDoubleClick(viewer);
        leftDoubleClick(viewer);

        second.resolve(pickedObjectFor(currentEntity));
        await settlePicks();
        expect(viewer.trackedEntity).toBe(currentEntity);

        first.resolve(undefined);
        await settlePicks();
        expect(viewer.trackedEntity).toBe(currentEntity);
      });

      it("a select pick and a track pick do not supersede one another", async function () {
        viewer = createViewer(container, viewerOptions());
        const selectPick = makeDeferred();
        const trackPick = makeDeferred();
        spyOn(viewer.scene, "pickAsync").and.returnValues(
          selectPick.promise,
          trackPick.promise,
        );

        const selected = positionedEntity();
        const tracked = positionedEntity();

        leftClick(viewer);
        leftDoubleClick(viewer);

        trackPick.resolve(pickedObjectFor(tracked));
        await settlePicks();
        selectPick.resolve(pickedObjectFor(selected));
        await settlePicks();

        expect(viewer.trackedEntity).toBe(tracked);
        expect(viewer.selectedEntity).toBe(selected);
      });
    });
  },
  "WebGL",
);
