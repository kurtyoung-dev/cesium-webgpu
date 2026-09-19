import { viewerCesium3DTilesInspectorMixin } from "../../index.js";

import createViewer from "../createViewer.js";

describe(
  "Widgets/Viewer/viewerCesium3DTilesInspectorMixin",
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
      viewer.extend(viewerCesium3DTilesInspectorMixin);

      const inspector = viewer.cesium3DTilesInspector;
      expect(inspector).toBeDefined();
      expect(inspector.container.parentNode).toBe(viewer.container);
    });

    it("destroying the viewer destroys the inspector and removes its panel", function () {
      viewer = createViewer(container);
      viewer.extend(viewerCesium3DTilesInspectorMixin);

      const inspector = viewer.cesium3DTilesInspector;
      const panel = inspector.container;

      viewer.destroy();

      expect(inspector.isDestroyed()).toBe(true);
      expect(panel.parentNode).toBeNull();
      expect(container.contains(panel)).toBe(false);
    });

    it("throws if viewer is undefined", function () {
      expect(function () {
        return viewerCesium3DTilesInspectorMixin(undefined);
      }).toThrowDeveloperError();
    });
  },
  "WebGL",
);
