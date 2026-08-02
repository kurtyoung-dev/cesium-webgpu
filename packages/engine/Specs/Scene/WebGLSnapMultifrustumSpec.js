import {
  BoundingSphere,
  BoxGeometry,
  BufferUsage,
  Cartesian2,
  Cartesian3,
  Color,
  defined,
  destroyObject,
  DrawCommand,
  GeometryPipeline,
  Matrix4,
  Pass,
  RenderState,
  ShaderProgram,
  VertexArray,
} from "../../index.js";

import createCanvas from "../../../../Specs/createCanvas.js";
import createScene from "../../../../Specs/createScene.js";

describe(
  "Scene/WebGLSnapMultifrustum",
  function () {
    let scene;

    function SnapTestPrimitive(options) {
      this.show = options.show ?? true;
      this._position = Cartesian3.clone(options.position);
      this._dimensions = Cartesian3.clone(options.dimensions);
      this._snappable = options.snappable;
      this._depthTestEnabled = options.depthTestEnabled ?? true;
      this._pickObject = options.pickObject;
      this._modelMatrix = Matrix4.fromTranslation(this._position);
      this._boundingVolume = new BoundingSphere(
        this._position,
        Cartesian3.magnitude(this._dimensions) * 0.5,
      );
      this._vertexArray = undefined;
      this._shaderProgram = undefined;
      this._renderState = undefined;
      this._pickId = undefined;
      this._command = undefined;
      this._uniformMap = {
        u_pickColor: () => this._pickId?.color ?? Color.TRANSPARENT,
      };
    }

    SnapTestPrimitive.prototype.update = function (frameState) {
      if (!this.show) {
        return;
      }

      if (!defined(this._command)) {
        const geometry = BoxGeometry.createGeometry(
          BoxGeometry.fromDimensions({ dimensions: this._dimensions }),
        );
        const attributeLocations =
          GeometryPipeline.createAttributeLocations(geometry);
        this._vertexArray = VertexArray.fromGeometry({
          context: frameState.context,
          geometry: geometry,
          attributeLocations: attributeLocations,
          bufferUsage: BufferUsage.STATIC_DRAW,
        });
        this._shaderProgram = ShaderProgram.fromCache({
          context: frameState.context,
          vertexShaderSource: `
            in vec4 position;
            out vec3 v_positionEC;
            void main()
            {
              vec4 positionEC = czm_modelView * position;
              v_positionEC = positionEC.xyz;
              gl_Position = czm_projection * positionEC;
            }
          `,
          fragmentShaderSource: `
            in vec3 v_positionEC;
            uniform vec4 u_pickColor;
            void main()
            {
              out_FragColor = vec4(1.0);
            }
          `,
          attributeLocations: attributeLocations,
        });
        this._renderState = RenderState.fromCache({
          depthTest: { enabled: this._depthTestEnabled },
          depthMask: true,
        });

        if (this._snappable) {
          this._pickId = frameState.context.createPickId(this._pickObject);
        }
        this._command = new DrawCommand({
          boundingVolume: this._boundingVolume,
          modelMatrix: this._modelMatrix,
          uniformMap: this._uniformMap,
          renderState: this._renderState,
          vertexArray: this._vertexArray,
          shaderProgram: this._shaderProgram,
          pass: Pass.OPAQUE,
          pickId: this._snappable ? "u_pickColor" : undefined,
          snapId: this._snappable
            ? "vec4(rgba8UnormToUint32(u_pickColor), 0.0, -v_positionEC.z, 0.0)"
            : undefined,
        });
      }

      frameState.commandList.push(this._command);
    };

    SnapTestPrimitive.prototype.isDestroyed = function () {
      return false;
    };

    SnapTestPrimitive.prototype.destroy = function () {
      this._pickId = this._pickId && this._pickId.destroy();
      this._vertexArray = this._vertexArray && this._vertexArray.destroy();
      this._shaderProgram =
        this._shaderProgram && this._shaderProgram.destroy();
      return destroyObject(this);
    };

    beforeEach(function () {
      scene = createScene({ canvas: createCanvas(64, 64) });
      scene.logarithmicDepthBuffer = false;
      scene.camera.position = Cartesian3.clone(Cartesian3.ZERO);
      scene.camera.direction = Cartesian3.negate(
        Cartesian3.UNIT_Z,
        new Cartesian3(),
      );
      scene.camera.up = Cartesian3.clone(Cartesian3.UNIT_Y);
      scene.camera.right = Cartesian3.clone(Cartesian3.UNIT_X);
      scene.camera.frustum.near = 1.0;
      scene.camera.frustum.far = 1000000000.0;
      scene.camera.frustum.aspectRatio = 1.0;
    });

    afterEach(function () {
      scene.destroyForSpecs();
    });

    it("erases a far snap payload behind a nearer snapless slice", function () {
      if (!scene.context.colorBufferFloat) {
        return;
      }

      const farPickObject = { id: "far-snap-target" };
      scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50000.0),
          dimensions: new Cartesian3(20000.0, 20000.0, 20000.0),
          snappable: true,
          pickObject: farPickObject,
        }),
      );
      const nearOccluder = scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50.0),
          dimensions: new Cartesian3(20.0, 20.0, 20.0),
          snappable: false,
          show: false,
        }),
      );
      const center = new Cartesian2(
        scene.drawingBufferWidth * 0.5,
        scene.drawingBufferHeight * 0.5,
      );

      const farHit = scene.snap(center, { width: 3, height: 3 });
      expect(farHit).toBeDefined();
      expect(farHit.object).toBe(farPickObject);

      nearOccluder.show = true;
      expect(scene.snap(center, { width: 3, height: 3 })).toBeUndefined();
      expect(scene.numberOfFrustums).toBeGreaterThan(1);

      nearOccluder.show = false;
      const farHitAgain = scene.snap(center, { width: 3, height: 3 });
      expect(farHitAgain).toBeDefined();
      expect(farHitAgain.object).toBe(farPickObject);
    });

    it("prepares the selected log-depth tree after log depth is enabled", function () {
      if (!scene.context.colorBufferFloat) {
        return;
      }

      const farPickObject = { id: "far-log-depth-target" };
      scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50000.0),
          dimensions: new Cartesian3(20000.0, 20000.0, 20000.0),
          snappable: true,
          pickObject: farPickObject,
        }),
      );
      const nearOccluder = scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50.0),
          dimensions: new Cartesian3(20.0, 20.0, 20.0),
          snappable: false,
          show: false,
        }),
      );
      const center = new Cartesian2(
        scene.drawingBufferWidth * 0.5,
        scene.drawingBufferHeight * 0.5,
      );

      // Materialize only the base snap tree, then create the log-depth clone
      // during an ordinary render where no snap derivative is requested.
      expect(scene.snap(center, { width: 3, height: 3 }).object).toBe(
        farPickObject,
      );
      scene.logarithmicDepthBuffer = true;
      scene.renderForSpecs();

      nearOccluder.show = true;
      expect(scene.snap(center, { width: 3, height: 3 })).toBeUndefined();
      expect(scene.numberOfFrustums).toBeGreaterThan(1);
    });

    it("keeps the depth-only fallback when a command cannot write depth", function () {
      if (!scene.context.colorBufferFloat) {
        return;
      }

      const farPickObject = { id: "far-depth-fallback-target" };
      scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50000.0),
          dimensions: new Cartesian3(20000.0, 20000.0, 20000.0),
          snappable: true,
          pickObject: farPickObject,
        }),
      );
      scene.primitives.add(
        new SnapTestPrimitive({
          position: new Cartesian3(0.0, 0.0, -50.0),
          dimensions: new Cartesian3(20.0, 20.0, 20.0),
          snappable: false,
          depthTestEnabled: false,
        }),
      );
      const center = new Cartesian2(
        scene.drawingBufferWidth * 0.5,
        scene.drawingBufferHeight * 0.5,
      );

      const hit = scene.snap(center, { width: 3, height: 3 });
      expect(hit).toBeDefined();
      expect(hit.object).toBe(farPickObject);
      expect(scene.numberOfFrustums).toBeGreaterThan(1);
    });
  },
  "WebGL",
);
