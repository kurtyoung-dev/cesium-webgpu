import Cartesian2 from "../../Source/Core/Cartesian2.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Color from "../../Source/Core/Color.js";
import defined from "../../Source/Core/defined.js";
import Matrix4 from "../../Source/Core/Matrix4.js";
import EllipsoidPrimitive from "../../Source/Scene/EllipsoidPrimitive.js";
import Material from "../../Source/Scene/Material.js";
import {
  createWebGLMoonImageMaterial,
  webGLMoonImageMaterialSource,
  WebGLMoonImageMaterialType,
} from "../../Source/Scene/WebGLMoonImageMaterial.js";
import createScene from "../../../../Specs/createScene.js";

describe(
  "Scene/WebGLMoonImageMaterial",
  function () {
    let scene;
    let ellipsoid;
    let material;

    beforeAll(function () {
      scene = createScene();
    });

    afterAll(function () {
      scene.destroyForSpecs();
    });

    afterEach(function () {
      scene.primitives.removeAll();
      if (defined(ellipsoid) && !ellipsoid.isDestroyed()) {
        ellipsoid.destroy();
      }
      ellipsoid = undefined;
      if (defined(material) && !material.isDestroyed()) {
        material.destroy();
      }
      material = undefined;
    });

    it("preserves the Image material uniform and color contract", function () {
      material = createWebGLMoonImageMaterial();

      expect(material.type).toBe(WebGLMoonImageMaterialType);
      expect(material.uniforms.image).toBe(Material.DefaultImageId);
      expect(material.uniforms.repeat).toEqual(new Cartesian2(1.0, 1.0));
      expect(material.uniforms.color).toEqual(Color.WHITE);
      expect(material.isTranslucent()).toBe(false);
      expect(webGLMoonImageMaterialSource).toContain(
        "fract(repeat * materialInput.st)",
      );
      expect(webGLMoonImageMaterialSource).toContain(
        "czm_gammaCorrect(imageColor.rgb * color.rgb)",
      );
      expect(webGLMoonImageMaterialSource).toContain("imageColor.a * color.a");
    });

    it("compiles explicit-gradient color and pick variants", function () {
      const context = scene.context;
      if (
        !context.webgl2 &&
        !(context.standardDerivatives && context.supportsTextureLod)
      ) {
        pending("WebGL 1 adapter lacks the explicit-gradient extensions");
      }

      material = createWebGLMoonImageMaterial();
      ellipsoid = new EllipsoidPrimitive({
        radii: new Cartesian3(1.0, 1.0, 1.0),
        material: material,
        id: "moon-gradient",
      });
      ellipsoid.lunarAlbedoExplicitGradients = true;
      ellipsoid.lunarNormalMap = context.defaultTexture;
      ellipsoid.lunarNormalExplicitGradients = true;
      ellipsoid.lunarNormalStrength = 0.0;
      scene.camera.lookAtTransform(
        Matrix4.IDENTITY,
        new Cartesian3(1.02, 0.0, 0.0),
      );
      scene.primitives.add(ellipsoid);

      expect(scene).notToRender([0, 0, 0, 255]);
      expect(ellipsoid._sp.fragmentShaderSource.defines).toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._sp.fragmentShaderSource.defines).toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._sp.fragmentShaderSource.defines).toContain(
        "LUNAR_NORMAL_EXPLICIT_GRADIENTS",
      );

      expect(scene).toPickAndCall(function (result) {
        expect(result.id).toBe("moon-gradient");
      });
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );
    });

    it("rebuilds a pick variant after ordinary-render mip transitions", function () {
      const context = scene.context;
      if (
        !context.webgl2 &&
        !(context.standardDerivatives && context.supportsTextureLod)
      ) {
        pending("WebGL 1 adapter lacks the explicit-gradient extensions");
      }

      material = createWebGLMoonImageMaterial();
      ellipsoid = new EllipsoidPrimitive({
        radii: new Cartesian3(1.0, 1.0, 1.0),
        material: material,
        id: "moon-gradient-transition",
      });
      scene.camera.lookAtTransform(
        Matrix4.IDENTITY,
        new Cartesian3(1.02, 0.0, 0.0),
      );
      scene.primitives.add(ellipsoid);

      // Build the initial implicit-LOD pick program.
      expect(scene).toPickAndCall(function (result) {
        expect(result.id).toBe("moon-gradient-transition");
      });
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).not.toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );

      // A normal render consumes the COLOR program's transition. The next
      // pick must still observe and compile its independently tracked variant.
      ellipsoid.lunarAlbedoExplicitGradients = true;
      scene.renderForSpecs();
      expect(scene).toPickAndCall(function (result) {
        expect(result.id).toBe("moon-gradient-transition");
      });
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );

      // Reverse transitions are equally important for custom NPOT/WebGL1
      // fallbacks: a stale explicit-gradient program must not survive.
      ellipsoid.lunarAlbedoExplicitGradients = false;
      scene.renderForSpecs();
      expect(scene).toPickAndCall(function (result) {
        expect(result.id).toBe("moon-gradient-transition");
      });
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).not.toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).not.toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );
    });
  },
  "WebGL",
);

describe(
  "Scene/WebGLMoonImageMaterial with WebGL 1",
  function () {
    let scene;
    let ellipsoid;
    let material;

    beforeAll(function () {
      scene = createScene({
        contextOptions: {
          requestWebgl1: true,
        },
      });
    });

    afterAll(function () {
      scene.destroyForSpecs();
    });

    afterEach(function () {
      scene.primitives.removeAll();
      if (defined(ellipsoid) && !ellipsoid.isDestroyed()) {
        ellipsoid.destroy();
      }
      ellipsoid = undefined;
      if (defined(material) && !material.isDestroyed()) {
        material.destroy();
      }
      material = undefined;
    });

    it("compiles and renders explicit-gradient color and pick variants", function () {
      const context = scene.context;
      expect(context.webgl2).toBe(false);
      if (!(context.standardDerivatives && context.supportsTextureLod)) {
        pending("WebGL 1 adapter lacks the explicit-gradient extensions");
      }

      material = createWebGLMoonImageMaterial();
      material.uniforms.image = context.defaultTexture;
      ellipsoid = new EllipsoidPrimitive({
        radii: new Cartesian3(1.0, 1.0, 1.0),
        material: material,
        id: "moon-gradient-webgl1",
      });
      ellipsoid.lunarAlbedoExplicitGradients = true;
      scene.camera.lookAtTransform(
        Matrix4.IDENTITY,
        new Cartesian3(1.02, 0.0, 0.0),
      );
      scene.primitives.add(ellipsoid);

      expect(scene).notToRender([0, 0, 0, 255]);
      expect(ellipsoid._sp.fragmentShaderSource.defines).toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._sp.fragmentShaderSource.defines).toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._sp._fragmentShaderText).toContain("texture2DGradEXT");

      expect(scene).toPickAndCall(function (result) {
        expect(result.primitive).toBe(ellipsoid);
        expect(result.id).toBe("moon-gradient-webgl1");
      });
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._pickSP.fragmentShaderSource.defines).toContain(
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      );
      expect(ellipsoid._pickSP._fragmentShaderText).toContain(
        "texture2DGradEXT",
      );
    });
  },
  "WebGL",
);
