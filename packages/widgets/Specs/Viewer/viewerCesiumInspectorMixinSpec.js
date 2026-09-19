import { viewerCesiumInspectorMixin } from "../../index.js";

import createViewer from "../createViewer.js";

describe(
  "Widgets/Viewer/viewerCesiumInspectorMixin",
  function () {
    let container;
    let viewer;
    beforeEach(function () {
      container = document.createElement("div");
      container.id = "container";
      container.style.display = "none";
      document.body.appendChild(container);
    });

    afterEach(function () {
      if (viewer && !viewer.isDestroyed()) {
        viewer = viewer.destroy();
      }

      document.body.removeChild(container);
    });

    it("mixin adds the inspector to the viewer's container", function () {
      viewer = createViewer(container);
      viewer.extend(viewerCesiumInspectorMixin);

      const inspector = viewer.cesiumInspector;
      expect(inspector).toBeDefined();
      expect(inspector.container.parentNode).toBe(viewer.container);
    });

    it("destroying the viewer destroys the inspector and removes its panel", function () {
      viewer = createViewer(container);
      viewer.extend(viewerCesiumInspectorMixin);

      const inspector = viewer.cesiumInspector;
      const panel = inspector.container;

      viewer.destroy();

      expect(inspector.isDestroyed()).toBe(true);
      expect(panel.parentNode).toBeNull();
      expect(container.contains(panel)).toBe(false);
    });

    it("throws if viewer is undefined", function () {
      expect(function () {
        return viewerCesiumInspectorMixin(undefined);
      }).toThrowDeveloperError();
    });
  },
  "WebGL",
);
