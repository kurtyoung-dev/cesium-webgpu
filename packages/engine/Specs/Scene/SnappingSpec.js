import {
  BoundingRectangle,
  Cartesian2,
  Cartesian3,
  EdgeDisplayMode,
  PerspectiveOffCenterFrustum,
  Snapping,
} from "../../index.js";

import createScene from "../../../../Specs/createScene.js";
import createCanvas from "../../../../Specs/createCanvas.js";
import loadAndZoomToModelAsync from "./Model/loadAndZoomToModelAsync.js";

describe("Scene/Snapping", function () {
  const selectBestHit = Snapping._selectBestHit;
  const snapHitToWorld = Snapping._snapHitToWorld;
  const captureSnapView = Snapping._captureSnapView;
  const snapHitToScreenPosition = Snapping._snapHitToScreenPosition;

  function surfaceHit(x, y, depth, object) {
    return { object: object ?? {}, isEdge: false, depth: depth, x: x, y: y };
  }

  function edgeHit(x, y, depth, object) {
    return { object: object ?? {}, isEdge: true, depth: depth, x: x, y: y };
  }

  describe("selectBestHit", function () {
    it("returns a lone surface hit", function () {
      const hit = surfaceHit(1.0, 2.0, 10.0);
      expect(selectBestHit([hit])).toBe(hit);
    });

    it("prefers an edge over a closer surface at the same depth", function () {
      const surface = surfaceHit(0.0, 0.0, 10.0);
      const edge = edgeHit(4.0, 0.0, 10.0);
      expect(selectBestHit([surface, edge])).toBe(edge);
    });

    it("selects the edge closest to the cursor", function () {
      const nearEdge = edgeHit(1.0, 1.0, 10.0);
      const farEdge = edgeHit(5.0, 0.0, 10.0);
      expect(selectBestHit([farEdge, nearEdge])).toBe(nearEdge);
    });

    it("selects the surface closest to the cursor when there are no edges", function () {
      const nearSurface = surfaceHit(0.0, 1.0, 10.0);
      const farSurface = surfaceHit(3.0, 3.0, 5.0);
      expect(selectBestHit([farSurface, nearSurface])).toBe(nearSurface);
    });

    it("does not snap through a surface under the cursor to a much deeper edge", function () {
      // Regression test: a far edge poking through a gap in a nearer
      // silhouette sits at the crosshair; the nearer surface must win.
      const nearSurface = surfaceHit(0.0, 0.0, 13.7);
      const farEdge = edgeHit(0.0, 0.0, 655.0);
      expect(selectBestHit([nearSurface, farEdge])).toBe(nearSurface);
    });

    it("keeps an edge that lies on the occluding surface", function () {
      const surface = surfaceHit(0.0, 0.0, 10.0);
      const edge = edgeHit(2.0, 0.0, 10.5);
      expect(selectBestHit([surface, edge])).toBe(edge);
    });

    it("keeps an edge at exactly the occluder depth", function () {
      const surface = surfaceHit(0.0, 0.0, 10.0);
      const edge = edgeHit(3.0, 0.0, 10.0);
      expect(selectBestHit([surface, edge])).toBe(edge);
    });

    it("allows snapping to a deep edge when the nearer surface is outside the occluder radius", function () {
      // A nearer object off to the side of the aperture must not gate out
      // the behind edge the user is aiming at.
      const offToTheSideSurface = surfaceHit(10.0, 0.0, 5.0);
      const behindEdge = edgeHit(0.0, 0.0, 100.0);
      expect(selectBestHit([offToTheSideSurface, behindEdge])).toBe(behindEdge);
    });

    it("falls back to the closest surface when all edges are occluded", function () {
      const nearSurface = surfaceHit(1.0, 0.0, 10.0);
      const otherSurface = surfaceHit(2.0, 2.0, 12.0);
      const occludedEdge = edgeHit(0.0, 0.0, 500.0);
      expect(selectBestHit([occludedEdge, otherSurface, nearSurface])).toBe(
        nearSurface,
      );
    });

    it("selects the closest edge when there are no surfaces", function () {
      // EDGES_ONLY display mode: no surface occluder, gate is a no-op.
      const nearEdge = edgeHit(1.0, 0.0, 400.0);
      const deepEdge = edgeHit(0.0, 2.0, 800.0);
      expect(selectBestHit([deepEdge, nearEdge])).toBe(nearEdge);
    });
  });

  describe("snapHitToWorld", function () {
    function createPerspectiveView(options) {
      options = options ?? {};
      const canvasWidth = options.canvasWidth ?? 2.0;
      const canvasHeight = options.canvasHeight ?? 2.0;
      const drawingBufferWidth = options.drawingBufferWidth ?? canvasWidth;
      const drawingBufferHeight = options.drawingBufferHeight ?? canvasHeight;
      const fovy = options.fovy ?? Math.PI * 0.5;
      const aspectRatio = options.aspectRatio ?? 1.0;
      const near = options.near ?? 1.0;
      const top = near * Math.tan(fovy * 0.5);
      const right = aspectRatio * top;
      return Object.freeze({
        windowX: options.windowX ?? 1.0,
        windowY: options.windowY ?? 1.0,
        canvasWidth,
        canvasHeight,
        drawingBufferWidth,
        drawingBufferHeight,
        viewportX: options.viewportX ?? 0.0,
        viewportY: options.viewportY ?? 0.0,
        viewportWidth: options.viewportWidth ?? drawingBufferWidth,
        viewportHeight: options.viewportHeight ?? drawingBufferHeight,
        positionX: options.positionX ?? 0.0,
        positionY: options.positionY ?? 0.0,
        positionZ: options.positionZ ?? 0.0,
        directionX: options.directionX ?? 0.0,
        directionY: options.directionY ?? 0.0,
        directionZ: options.directionZ ?? -1.0,
        rightX: options.rightX ?? 1.0,
        rightY: options.rightY ?? 0.0,
        rightZ: options.rightZ ?? 0.0,
        upX: options.upX ?? 0.0,
        upY: options.upY ?? 1.0,
        upZ: options.upZ ?? 0.0,
        perspective: true,
        fovy,
        aspectRatio,
        near,
        left: options.left ?? -right,
        right: options.right ?? right,
        top: options.top ?? top,
        bottom: options.bottom ?? -top,
        sceneMode: 3,
        mapMode2D: 1,
        wrapLongitude: false,
        maxCoordinateX: 0.0,
      });
    }

    it("unprojects eye-space depth along an axis-aligned ray", function () {
      const view = createPerspectiveView();
      const hit = edgeHit(0.0, 0.0, 100.0);
      const position = snapHitToWorld(view, hit);
      expect(position).toEqualEpsilon(new Cartesian3(0.0, 0.0, -100.0), 1e-10);
    });

    it("converts perpendicular depth to distance along an off-axis ray", function () {
      // Ray at 60 degrees from the view direction: cos = 0.5, so the
      // along-ray distance is depth / 0.5 = 2 * depth.
      const cos = 0.5;
      const sin = Math.sqrt(1.0 - cos * cos);
      const rayDirection = new Cartesian3(sin, 0.0, -cos);
      const view = createPerspectiveView({
        windowX: 2.0,
        fovy: (2.0 * Math.PI) / 3.0,
      });
      const hit = edgeHit(0.0, 0.0, 100.0);
      const position = snapHitToWorld(view, hit);
      const expected = Cartesian3.multiplyByScalar(
        rayDirection,
        200.0,
        new Cartesian3(),
      );
      expect(position).toEqualEpsilon(expected, 1e-10);
    });

    it("reconstructs a perspective hit from asymmetric off-center planes", function () {
      const view = createPerspectiveView({
        left: 0.0,
        right: 2.0,
        bottom: -1.0,
        top: 1.0,
      });
      const position = snapHitToWorld(view, edgeHit(0.0, 0.0, 100.0));

      // The center pixel lies at x=1 on the near plane, so perpendicular
      // eye depth 100 reconstructs to x=100, z=-100. A symmetric-fovy
      // reconstruction would incorrectly return x=0.
      expect(position).toEqualEpsilon(
        new Cartesian3(100.0, 0.0, -100.0),
        1e-10,
      );
    });

    it("scales drawing-buffer hit offsets before reconstructing the CSS pick ray", function () {
      const view = createPerspectiveView({
        windowX: 50.0,
        windowY: 50.0,
        canvasWidth: 100.0,
        canvasHeight: 100.0,
        drawingBufferWidth: 200.0,
        drawingBufferHeight: 200.0,
      });
      const hit = edgeHit(20.0, 0.0, 100.0);

      // Twenty drawing-buffer pixels are ten CSS pixels. With a 90-degree
      // square frustum, the resulting perpendicular-depth position is x=20,
      // z=-100. Treating the offset as CSS pixels would incorrectly yield 40.
      expect(snapHitToWorld(view, hit)).toEqualEpsilon(
        new Cartesian3(20.0, 0.0, -100.0),
        1e-10,
      );
    });

    it("reports snap screen positions in CSS pixels at non-1x resolution", function () {
      const view = createPerspectiveView({
        windowX: 50.0,
        windowY: 50.0,
        canvasWidth: 100.0,
        canvasHeight: 100.0,
        drawingBufferWidth: 200.0,
        drawingBufferHeight: 400.0,
      });
      const result = snapHitToScreenPosition(
        view,
        edgeHit(20.0, 20.0, 1.0),
        new Cartesian2(),
      );

      expect(result).toEqual(new Cartesian2(60.0, 55.0));
    });

    it("uses the rendered view even after the live camera has moved", function () {
      const renderedView = createPerspectiveView({
        positionX: 10.0,
        positionY: 20.0,
        positionZ: 30.0,
      });
      const laterView = createPerspectiveView({
        positionX: 1010.0,
        positionY: 2020.0,
        positionZ: 3030.0,
      });
      const hit = edgeHit(0.0, 0.0, 100.0);
      const renderedPosition = snapHitToWorld(renderedView, hit);
      const laterPosition = snapHitToWorld(laterView, hit);
      expect(renderedPosition).toEqualEpsilon(
        new Cartesian3(10.0, 20.0, -70.0),
        1e-10,
      );
      expect(renderedPosition).not.toEqual(laterPosition);
    });

    it("reconstructs an orthographic hit from the captured frustum", function () {
      const view = Object.freeze({
        ...createPerspectiveView({
          positionX: 10.0,
          positionY: 20.0,
          positionZ: 30.0,
        }),
        perspective: false,
        left: -10.0,
        right: 10.0,
        top: 5.0,
        bottom: -5.0,
      });
      const hit = edgeHit(1.0, 1.0, 100.0);
      const position = snapHitToWorld(view, hit);
      expect(position).toEqualEpsilon(new Cartesian3(20.0, 15.0, -70.0), 1e-10);
    });

    it("includes an orthographic frustum's asymmetric center offset", function () {
      const view = Object.freeze({
        ...createPerspectiveView(),
        perspective: false,
        left: 2.0,
        right: 6.0,
        top: 1.0,
        bottom: -3.0,
      });
      const position = snapHitToWorld(view, edgeHit(0.0, 0.0, 100.0));
      expect(position).toEqualEpsilon(new Cartesian3(4.0, -1.0, -100.0), 1e-10);
    });

    it("derives NDC from the captured drawing-buffer viewport", function () {
      const view = createPerspectiveView({
        windowX: 50.0,
        windowY: 65.0,
        canvasWidth: 100.0,
        canvasHeight: 100.0,
        drawingBufferWidth: 200.0,
        drawingBufferHeight: 200.0,
        viewportX: 50.0,
        viewportY: 20.0,
        viewportWidth: 100.0,
        viewportHeight: 100.0,
      });
      expect(snapHitToWorld(view, edgeHit(0.0, 0.0, 100.0))).toEqualEpsilon(
        new Cartesian3(0.0, 0.0, -100.0),
        1e-10,
      );
    });

    it("returns undefined when the captured canvas has no area", function () {
      const view = createPerspectiveView({ canvasWidth: 0.0 });
      const hit = edgeHit(0.0, 0.0, 100.0);
      expect(snapHitToWorld(view, hit)).toBeUndefined();
    });

    it("returns undefined when the ray points away from the view direction", function () {
      const view = createPerspectiveView({
        windowX: 2.0,
        rightX: 0.0,
        rightZ: 2.0,
      });
      const hit = edgeHit(0.0, 0.0, 100.0);
      expect(snapHitToWorld(view, hit)).toBeUndefined();
    });

    it("captures flat immutable camera, frustum, and viewport provenance", function () {
      const camera = {
        positionWC: new Cartesian3(1.0, 2.0, 3.0),
        directionWC: new Cartesian3(0.0, 0.0, -1.0),
        rightWC: new Cartesian3(1.0, 0.0, 0.0),
        upWC: new Cartesian3(0.0, 1.0, 0.0),
        frustum: {
          aspectRatio: 2.0,
          fov: 1.0,
          fovy: 0.5,
          near: 0.25,
        },
        _maxCoord: new Cartesian3(10.0, 10.0, 0.0),
      };
      const viewport = { x: 4.0, y: 5.0, width: 600.0, height: 400.0 };
      const scene = {
        camera,
        canvas: { clientWidth: 300, clientHeight: 200 },
        drawingBufferWidth: 600,
        drawingBufferHeight: 400,
        defaultView: { viewport },
        mode: 3,
        mapMode2D: 1,
      };
      const windowPosition = new Cartesian2(10.25, 20.25);
      const drawingBufferRectangle = new BoundingRectangle(
        8.5,
        347.5,
        25.0,
        25.0,
      );
      const view = captureSnapView(
        scene,
        windowPosition,
        drawingBufferRectangle,
      );

      camera.positionWC.x = 999.0;
      camera.frustum.near = 999.0;
      viewport.width = 999.0;
      windowPosition.x = 999.0;

      expect(Object.isFrozen(view)).toBe(true);
      expect(view.positionX).toBe(1.0);
      expect(view.near).toBe(0.25);
      expect(view.viewportWidth).toBe(600.0);
      expect(view.windowX).toBe(10.25);
      expect(view.sampleWindowX).toBe(10.0);
      expect(view.sampleWindowY).toBe(20.0);
      expect(view.drawingBufferWidth).toBe(600.0);
    });

    it("classifies a direct perspective-off-center frustum correctly", function () {
      const frustum = new PerspectiveOffCenterFrustum();
      frustum.left = 0.25;
      frustum.right = 1.25;
      frustum.bottom = -0.5;
      frustum.top = 0.5;
      frustum.near = 1.0;
      frustum.far = 1000.0;
      const scene = {
        camera: {
          positionWC: Cartesian3.ZERO,
          directionWC: Cartesian3.UNIT_Z,
          rightWC: Cartesian3.UNIT_X,
          upWC: Cartesian3.UNIT_Y,
          frustum,
        },
        canvas: { clientWidth: 100, clientHeight: 100 },
        drawingBufferWidth: 100,
        drawingBufferHeight: 100,
        defaultView: {
          viewport: { x: 0.0, y: 0.0, width: 100.0, height: 100.0 },
        },
        mode: 3,
        mapMode2D: 1,
      };

      const view = captureSnapView(scene, new Cartesian2(50.0, 50.0));
      expect(view.perspective).toBe(true);
      expect(view.left).toBe(0.25);
      expect(view.right).toBe(1.25);
    });
  });

  describe("snap", function () {
    it("throws without windowPosition", function () {
      const fakeScene = {
        context: { colorBufferFloat: true },
        defaultView: {},
      };
      expect(function () {
        Snapping.snap(fakeScene, undefined);
      }).toThrowDeveloperError();
    });

    it("returns undefined when float color attachments are unsupported", function () {
      const fakeScene = {
        context: { colorBufferFloat: false },
        defaultView: {},
      };
      expect(
        Snapping.snap(fakeScene, new Cartesian2(0.0, 0.0)),
      ).toBeUndefined();
      // The snap framebuffer must not be created when snapping is unsupported.
      expect(fakeScene.defaultView.snapFramebuffer).toBeUndefined();
    });

    it("returns undefined for an empty scene", function () {
      const scene = createScene();
      try {
        scene.renderForSpecs();
        const windowPosition = new Cartesian2(
          scene.drawingBufferWidth / 2,
          scene.drawingBufferHeight / 2,
        );
        expect(scene.snap(windowPosition)).toBeUndefined();
      } finally {
        scene.destroyForSpecs();
      }
    });

    it("ends the snap mini-frame when synchronous readback setup throws", function () {
      const scene = createScene();
      try {
        scene.renderForSpecs();
        const windowPosition = new Cartesian2(
          scene.drawingBufferWidth / 2,
          scene.drawingBufferHeight / 2,
        );

        // Materialize the lazy framebuffer before installing the failure.
        scene.snap(windowPosition);
        const endFrame = spyOn(scene.context, "endFrame").and.callThrough();
        spyOn(scene.defaultView.snapFramebuffer, "end").and.throwError(
          "synthetic snap readback failure",
        );

        expect(function () {
          scene.snap(windowPosition);
        }).toThrowError("synthetic snap readback failure");
        expect(endFrame).toHaveBeenCalledTimes(1);
        expect(scene.frameState.passes.snap).toBe(false);
      } finally {
        scene.destroyForSpecs();
      }
    });

    it("snaps to a model surface", async function () {
      // A canvas larger than the default snap window, so off-center window
      // coordinates produce sensible pick rays.
      const scene = createScene({ canvas: createCanvas(64, 64) });
      try {
        if (!scene.frameState.context.colorBufferFloat) {
          return;
        }
        const model = await loadAndZoomToModelAsync(
          { url: "./Data/Models/glTF-2.0/BoxTextured/glTF/BoxTextured.gltf" },
          scene,
        );
        const windowPosition = new Cartesian2(
          scene.drawingBufferWidth / 2,
          scene.drawingBufferHeight / 2,
        );
        expect(scene).toSnapAndCall(function (result) {
          expect(result).toBeDefined();
          expect(result.object.primitive).toBe(model);
          expect(result.isEdge).toBe(false);
          expect(result.screenPosition).toBeInstanceOf(Cartesian2);
          // The snapped world position must lie on the model.
          const distance = Cartesian3.distance(
            result.position,
            model.boundingSphere.center,
          );
          expect(distance).toBeLessThanOrEqual(
            model.boundingSphere.radius * 1.01,
          );
        }, windowPosition);
      } finally {
        scene.destroyForSpecs();
      }
    });

    it("snaps to a model edge when edges are displayed", async function () {
      const scene = createScene({ canvas: createCanvas(64, 64) });
      try {
        if (!scene.frameState.context.colorBufferFloat) {
          return;
        }
        const model = await loadAndZoomToModelAsync(
          {
            url: "./Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibility.glb",
          },
          scene,
        );
        model.edgeDisplayMode = EdgeDisplayMode.SURFACES_AND_EDGES;
        scene.renderForSpecs();
        const windowPosition = new Cartesian2(
          scene.drawingBufferWidth / 2,
          scene.drawingBufferHeight / 2,
        );
        expect(scene).toSnapAndCall(function (result) {
          expect(result).toBeDefined();
          expect(result.object.primitive).toBe(model);
          expect(result.isEdge).toBe(true);
        }, windowPosition);
      } finally {
        scene.destroyForSpecs();
      }
    });
    it("snaps to a model with planar fill materials", async function () {
      const scene = createScene({ canvas: createCanvas(64, 64) });
      try {
        if (!scene.frameState.context.colorBufferFloat) {
          return;
        }
        const model = await loadAndZoomToModelAsync(
          {
            url: "./Data/Models/glTF-2.0/PlanarFill/glTF/planar-fill-polygons.gltf",
          },
          scene,
        );
        // Render a color frame first so the planar fill ID pre-pass runs
        // before the snap render.
        scene.renderForSpecs();
        const windowPosition = new Cartesian2(
          scene.drawingBufferWidth / 2,
          scene.drawingBufferHeight / 2,
        );
        expect(scene).toSnapAndCall(function (result) {
          expect(result).toBeDefined();
          expect(result.object.primitive).toBe(model);
          // The asset also uses EXT_mesh_primitive_edge_visibility, so snap
          // prefers an edge.
          expect(result.isEdge).toBe(true);
          expect(result.position).toBeInstanceOf(Cartesian3);
        }, windowPosition);
      } finally {
        scene.destroyForSpecs();
      }
    });
  });
});
