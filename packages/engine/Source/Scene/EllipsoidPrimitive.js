import BoundingSphere from "../Core/BoundingSphere.js";
import BoxGeometry from "../Core/BoxGeometry.js";
import Cartesian3 from "../Core/Cartesian3.js";
import combine from "../Core/combine.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import VertexFormat from "../Core/VertexFormat.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import EllipsoidFS from "../Shaders/EllipsoidFS.js";
import EllipsoidVS from "../Shaders/EllipsoidVS.js";
import BlendingState from "./BlendingState.js";
import CullFace from "./CullFace.js";
import Material from "./Material.js";
import SceneMode from "./SceneMode.js";

const attributeLocations = {
  position: 0,
};

// Identity extinction (fully transmissive) used when no atmospheric
// extinction is set. Multiplying the surface color by exactly 1.0 keeps the
// output byte-identical, so the `u_atmosphereExtinction` uniform is inert for
// every consumer that does not opt in.
const scratchExtinctionOne = new Cartesian3(1.0, 1.0, 1.0);

// Identity in-scattering (no wash) used when no atmospheric in-scatter is
// set — the ADDITIVE identity, mirroring scratchExtinctionOne's
// multiplicative one (C12-30).
const scratchInscatterZero = new Cartesian3(0.0, 0.0, 0.0);

/**
 * A renderable ellipsoid.  It can also draw spheres when the three {@link EllipsoidPrimitive#radii} components are equal.
 * <p>
 * This is only supported in 3D.  The ellipsoid is not shown in 2D or Columbus view.
 * </p>
 *
 * @alias EllipsoidPrimitive
 *
 * @param {object} [options] Object with the following properties:
 * @param {Cartesian3} [options.center=Cartesian3.ZERO] The center of the ellipsoid in the ellipsoid's model coordinates.
 * @param {Cartesian3} [options.radii] The radius of the ellipsoid along the <code>x</code>, <code>y</code>, and <code>z</code> axes in the ellipsoid's model coordinates.
 * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] The 4x4 transformation matrix that transforms the ellipsoid from model to world coordinates.
 * @param {boolean} [options.show=true] Determines if this primitive will be shown.
 * @param {Material} [options.material=Material.ColorType] The surface appearance of the primitive.
 * @param {object} [options.id] A user-defined object to return when the instance is picked with {@link Scene#pick}
 * @param {boolean} [options.debugShowBoundingVolume=false] For debugging only. Determines if this primitive's commands' bounding spheres are shown.
 *
 * @private
 */
class EllipsoidPrimitive {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    /**
     * The center of the ellipsoid in the ellipsoid's model coordinates.
     * <p>
     * The default is {@link Cartesian3.ZERO}.
     * </p>
     *
     * @type {Cartesian3}
     * @default {@link Cartesian3.ZERO}
     *
     * @see EllipsoidPrimitive#modelMatrix
     */
    this.center = Cartesian3.clone(options.center ?? Cartesian3.ZERO);
    this._center = new Cartesian3();

    /**
     * The radius of the ellipsoid along the <code>x</code>, <code>y</code>, and <code>z</code> axes in the ellipsoid's model coordinates.
     * When these are the same, the ellipsoid is a sphere.
     * <p>
     * The default is <code>undefined</code>.  The ellipsoid is not drawn until a radii is provided.
     * </p>
     *
     * @type {Cartesian3}
     * @default undefined
     *
     *
     * @example
     * // A sphere with a radius of 2.0
     * e.radii = new Cesium.Cartesian3(2.0, 2.0, 2.0);
     *
     * @see EllipsoidPrimitive#modelMatrix
     */
    this.radii = Cartesian3.clone(options.radii);
    this._radii = new Cartesian3();

    this._oneOverEllipsoidRadiiSquared = new Cartesian3();
    this._boundingSphere = new BoundingSphere();

    /**
     * The 4x4 transformation matrix that transforms the ellipsoid from model to world coordinates.
     * When this is the identity matrix, the ellipsoid is drawn in world coordinates, i.e., Earth's WGS84 coordinates.
     * Local reference frames can be used by providing a different transformation matrix, like that returned
     * by {@link Transforms.eastNorthUpToFixedFrame}.
     *
     * @type {Matrix4}
     * @default {@link Matrix4.IDENTITY}
     *
     * @example
     * const origin = Cesium.Cartesian3.fromDegrees(-95.0, 40.0, 200000.0);
     * e.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
     */
    this.modelMatrix = Matrix4.clone(options.modelMatrix ?? Matrix4.IDENTITY);
    this._modelMatrix = new Matrix4();
    this._computedModelMatrix = new Matrix4();
    // Batch 269 — dirty flag persisted on the instance (was a local) so the
    // hoisted radii/transform block and the WebGL appearance block share it.
    this._boundingSphereDirty = false;

    /**
     * Determines if the ellipsoid primitive will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * The surface appearance of the ellipsoid.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
     * {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}.
     * <p>
     * The default material is <code>Material.ColorType</code>.
     * </p>
     *
     * @type {Material}
     * @default Material.fromType(Material.ColorType)
     *
     *
     * @example
     * // 1. Change the color of the default material to yellow
     * e.material.uniforms.color = new Cesium.Color(1.0, 1.0, 0.0, 1.0);
     *
     * // 2. Change material to horizontal stripes
     * e.material = Cesium.Material.fromType(Cesium.Material.StripeType);
     *
     * @see {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}
     */
    this.material = options.material ?? Material.fromType(Material.ColorType);
    this._material = undefined;
    this._translucent = undefined;

    /**
     * User-defined object returned when the ellipsoid is picked.
     *
     * @type {object}
     *
     * @default undefined
     *
     * @see Scene#pick
     */
    this.id = options.id;
    this._id = undefined;

    /**
     * This property is for debugging only; it is not for production use nor is it optimized.
     * <p>
     * Draws the bounding sphere for each draw command in the primitive.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;

    /**
     * @private
     */
    this.onlySunLighting = options.onlySunLighting ?? false;
    this._onlySunLighting = false;

    /**
     * Optional per-channel atmospheric extinction (transmittance) multiplier
     * applied to the final surface color. Used by {@link Moon} to attenuate
     * and redden the disc along the atmospheric slant path. `undefined`
     * (the default) leaves the shader byte-identical for every other
     * EllipsoidPrimitive consumer.
     * @type {Cartesian3|undefined}
     * @private
     */
    this.atmosphereExtinction = undefined;
    this._atmosphereExtinctionEnabled = false;

    /**
     * Optional per-channel atmospheric in-scattering (sky-wash) ADDED to
     * the final surface color after the extinction multiply — the additive
     * half of the atmospheric transfer (C12-30). Used by {@link Moon} so a
     * daytime disc reads pale and sky-washed instead of a dark cutout.
     * `undefined` (the default) leaves the shader byte-identical for every
     * other EllipsoidPrimitive consumer.
     * @type {Cartesian3|undefined}
     * @private
     */
    this.atmosphereInscatter = undefined;
    this._atmosphereInscatterEnabled = false;

    /**
     * When true, replaces the Lambert/Phong disc law with the
     * Lommel-Seeliger lunar-regolith reflectance (C12-20) so a full moon
     * renders as the famously flat bright disc rather than a limb-darkened
     * Lambert ball. Default false — byte-identical for every other
     * EllipsoidPrimitive consumer. Set per-frame by {@link Moon} from
     * `atmosphericConditions.lighting.enableLunarBRDF`.
     * @type {boolean}
     * @private
     */
    this.lunarBRDF = false;
    this._lunarBRDF = false;

    /**
     * Optional opposition-surge brightness multiplier (C12-23), computed
     * CPU-side from the true phase angle by {@link Moon}. `undefined`
     * (the default) compiles the term out entirely — byte-identical for
     * every other EllipsoidPrimitive consumer.
     * @type {number|undefined}
     * @private
     */
    this.oppositionSurge = undefined;
    this._oppositionSurgeEnabled = false;

    /**
     * Optional tangent-space normal map (C12-25) perturbing the LIGHTING
     * normal in an east/north/up frame — the LOLA-derived lunar relief that
     * makes craters read near the terminator. A raw `Texture` rather than a
     * `Material` slot: `Material.ImageType` carries exactly one image and
     * has no normal channel, and growing the shared material system for one
     * body would touch every image material in the engine. This follows the
     * same private-uniform route the four C12 terms above already use.
     * `undefined` (the default) compiles the sampler out entirely — the FS
     * is byte-identical for every other EllipsoidPrimitive consumer.
     * @type {Texture|undefined}
     * @private
     */
    this.lunarNormalMap = undefined;
    this._lunarNormalMapEnabled = false;

    /**
     * Scales the tangential (east/north) components of {@link
     * EllipsoidPrimitive#lunarNormalMap} before the perturbation. 1.0 is the
     * true derived geometry; 0.0 is the exact identity. A per-frame uniform,
     * so moving it costs no recompile.
     * @type {number}
     * @private
     */
    this.lunarNormalStrength = 1.0;

    /**
     * @private
     */
    this._depthTestEnabled = options.depthTestEnabled ?? true;

    this._useLogDepth = false;

    this._sp = undefined;
    this._rs = undefined;
    this._va = undefined;

    this._pickSP = undefined;
    this._pickId = undefined;

    this._colorCommand = new DrawCommand({
      owner: options._owner ?? this,
    });
    this._pickCommand = new DrawCommand({
      owner: options._owner ?? this,
      pickOnly: true,
    });

    const that = this;
    this._uniforms = {
      u_radii: function () {
        return that.radii;
      },
      u_oneOverEllipsoidRadiiSquared: function () {
        return that._oneOverEllipsoidRadiiSquared;
      },
      u_atmosphereExtinction: function () {
        return that.atmosphereExtinction ?? scratchExtinctionOne;
      },
      u_atmosphereInscatter: function () {
        return that.atmosphereInscatter ?? scratchInscatterZero;
      },
      u_oppositionSurge: function () {
        return that.oppositionSurge ?? 1.0;
      },
      // C12-25. Only ever sampled when LUNAR_NORMAL_MAP is defined, which is
      // itself driven by `defined(this.lunarNormalMap)` in the same update()
      // that recompiles — so the texture is guaranteed present whenever the
      // program declares the sampler.
      u_lunarNormalMap: function () {
        return that.lunarNormalMap;
      },
      u_lunarNormalStrength: function () {
        return that.lunarNormalStrength ?? 1.0;
      },
    };

    this._pickUniforms = {
      czm_pickColor: function () {
        return that._pickId.color;
      },
    };
  }

  /**
   * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
   * get the draw commands needed to render this primitive.
   * <p>
   * Do not call this function directly.  This is documented just to
   * list the exceptions that may be propagated when the scene is rendered:
   * </p>
   *
   * @exception {DeveloperError} this.material must be defined.
   */
  update(frameState) {
    if (
      !this.show ||
      frameState.mode !== SceneMode.SCENE3D ||
      !defined(this.center) ||
      !defined(this.radii)
    ) {
      return;
    }

    // Scene Logic Extractor pattern (CLAUDE.md) — the world transform
    // (`_computedModelMatrix = modelMatrix * translate(center)`) and the
    // derived `_oneOverEllipsoidRadiiSquared` are backend-agnostic scene
    // logic and MUST be computed BEFORE the WebGPU feature-renderer branch.
    // The WebGPU renderer reads `_computedModelMatrix` for RTE positioning;
    // pre-Batch-268 this code ran only AFTER the `fr.update()` early-return,
    // so the WebGPU path saw the zero-initialized `new Matrix4()` (a
    // non-invertible all-zeros matrix → "determinate is zero" throw) and the
    // shell was never placed (BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE).
    const radii = this.radii;
    if (!Cartesian3.equals(this._radii, radii)) {
      Cartesian3.clone(radii, this._radii);
      const r = this._oneOverEllipsoidRadiiSquared;
      r.x = 1.0 / (radii.x * radii.x);
      r.y = 1.0 / (radii.y * radii.y);
      r.z = 1.0 / (radii.z * radii.z);
      this._boundingSphereDirty = true;
    }

    if (
      !Matrix4.equals(this.modelMatrix, this._modelMatrix) ||
      !Cartesian3.equals(this.center, this._center)
    ) {
      Matrix4.clone(this.modelMatrix, this._modelMatrix);
      Cartesian3.clone(this.center, this._center);
      Matrix4.multiplyByTranslation(
        this.modelMatrix,
        this.center,
        this._computedModelMatrix,
      );
      this._boundingSphereDirty = true;
    }

    if (this._boundingSphereDirty) {
      Cartesian3.clone(Cartesian3.ZERO, this._boundingSphere.center);
      this._boundingSphere.radius = Cartesian3.maximumComponent(radii);
      BoundingSphere.transform(
        this._boundingSphere,
        this._computedModelMatrix,
        this._boundingSphere,
      );
      this._boundingSphereDirty = false;
    }

    // Route to WebGPU feature renderer if available. Runs AFTER the shared
    // transform/radii logic above so the renderer sees a valid
    // `_computedModelMatrix` + `_oneOverEllipsoidRadiiSquared`.
    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.ELLIPSOID_PRIMITIVE,
    );
    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
      return;
    }

    //>>includeStart('debug', pragmas.debug);
    if (!defined(this.material)) {
      throw new DeveloperError("this.material must be defined.");
    }
    //>>includeEnd('debug');

    const context = frameState.context;
    const translucent = this.material.isTranslucent();
    const translucencyChanged = this._translucent !== translucent;

    if (!defined(this._rs) || translucencyChanged) {
      this._translucent = translucent;

      this._rs = RenderState.fromCache({
        cull: {
          enabled: true,
          face: CullFace.FRONT,
        },
        depthTest: {
          enabled: this._depthTestEnabled,
        },
        depthMask: !translucent && context.fragmentDepth,
        blending: translucent ? BlendingState.ALPHA_BLEND : undefined,
      });
    }

    if (!defined(this._va)) {
      this._va = getVertexArray(context);
    }

    // NOTE: radii / center / modelMatrix / bounding-sphere updates were
    // hoisted above the feature-renderer branch (Scene Logic Extractor
    // pattern, Batch 269) so both backends share one computation of
    // `_computedModelMatrix` + `_oneOverEllipsoidRadiiSquared`.

    const materialChanged = this._material !== this.material;
    this._material = this.material;
    this._material.update(context);

    const lightingChanged = this.onlySunLighting !== this._onlySunLighting;
    this._onlySunLighting = this.onlySunLighting;

    // NS-MOON-ATMOSPHERE-EXTINCTION — the extinction shader path is a define,
    // so toggling it on/off forces a recompile. The extinction *value* is a
    // per-frame uniform (no recompile), so only the enabled/disabled
    // transition matters here.
    const atmosphereExtinctionEnabled = defined(this.atmosphereExtinction);
    const atmosphereExtinctionChanged =
      atmosphereExtinctionEnabled !== this._atmosphereExtinctionEnabled;
    this._atmosphereExtinctionEnabled = atmosphereExtinctionEnabled;

    // C12-30/C12-20/C12-23 — same define-toggle pattern for the sky-wash,
    // the lunar BRDF, and the opposition surge: enabled/disabled
    // transitions recompile; the values are per-frame uniforms.
    const atmosphereInscatterEnabled = defined(this.atmosphereInscatter);
    const atmosphereInscatterChanged =
      atmosphereInscatterEnabled !== this._atmosphereInscatterEnabled;
    this._atmosphereInscatterEnabled = atmosphereInscatterEnabled;

    const lunarBRDFEnabled = this.lunarBRDF === true;
    const lunarBRDFChanged = lunarBRDFEnabled !== this._lunarBRDF;
    this._lunarBRDF = lunarBRDFEnabled;

    const oppositionSurgeEnabled = defined(this.oppositionSurge);
    const oppositionSurgeChanged =
      oppositionSurgeEnabled !== this._oppositionSurgeEnabled;
    this._oppositionSurgeEnabled = oppositionSurgeEnabled;

    // C12-25 — same define-toggle pattern. Only the presence/absence of the
    // normal map recompiles; `lunarNormalStrength` is a plain per-frame
    // uniform, so a user animating it never triggers a shader rebuild.
    const lunarNormalMapEnabled = defined(this.lunarNormalMap);
    const lunarNormalMapChanged =
      lunarNormalMapEnabled !== this._lunarNormalMapEnabled;
    this._lunarNormalMapEnabled = lunarNormalMapEnabled;

    const useLogDepth = frameState.useLogDepth;
    const useLogDepthChanged = this._useLogDepth !== useLogDepth;
    this._useLogDepth = useLogDepth;

    const colorCommand = this._colorCommand;
    let vs;
    let fs;

    if (
      materialChanged ||
      lightingChanged ||
      translucencyChanged ||
      useLogDepthChanged ||
      atmosphereExtinctionChanged ||
      atmosphereInscatterChanged ||
      lunarBRDFChanged ||
      oppositionSurgeChanged ||
      lunarNormalMapChanged
    ) {
      vs = new ShaderSource({
        sources: [EllipsoidVS],
      });
      fs = new ShaderSource({
        sources: [this.material.shaderSource, EllipsoidFS],
      });
      if (this.onlySunLighting) {
        fs.defines.push("ONLY_SUN_LIGHTING");
      }
      if (atmosphereExtinctionEnabled) {
        fs.defines.push("ATMOSPHERE_EXTINCTION");
      }
      if (atmosphereInscatterEnabled) {
        fs.defines.push("ATMOSPHERE_INSCATTER");
      }
      if (lunarBRDFEnabled) {
        fs.defines.push("LUNAR_BRDF");
      }
      if (oppositionSurgeEnabled) {
        fs.defines.push("OPPOSITION_SURGE");
      }
      if (lunarNormalMapEnabled) {
        fs.defines.push("LUNAR_NORMAL_MAP");
      }
      if (!translucent && context.fragmentDepth) {
        fs.defines.push("WRITE_DEPTH");
      }
      if (this._useLogDepth) {
        vs.defines.push("LOG_DEPTH");
        fs.defines.push("LOG_DEPTH");
      }

      this._sp = ShaderProgram.replaceCache({
        context: context,
        shaderProgram: this._sp,
        vertexShaderSource: vs,
        fragmentShaderSource: fs,
        attributeLocations: attributeLocations,
      });

      colorCommand.vertexArray = this._va;
      colorCommand.renderState = this._rs;
      colorCommand.shaderProgram = this._sp;
      colorCommand.uniformMap = combine(
        this._uniforms,
        this.material._uniforms,
      );
      colorCommand.executeInClosestFrustum = translucent;
    }

    const commandList = frameState.commandList;
    const passes = frameState.passes;

    if (passes.render) {
      colorCommand.boundingVolume = this._boundingSphere;
      colorCommand.debugShowBoundingVolume = this.debugShowBoundingVolume;
      colorCommand.modelMatrix = this._computedModelMatrix;
      colorCommand.pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

      commandList.push(colorCommand);
    }

    if (passes.pick) {
      const pickCommand = this._pickCommand;

      if (!defined(this._pickId) || this._id !== this.id) {
        this._id = this.id;
        this._pickId = this._pickId && this._pickId.destroy();
        this._pickId = context.createPickId(
          {
            primitive: this,
            id: this.id,
          },
          "primitive",
        );
      }

      if (
        materialChanged ||
        lightingChanged ||
        !defined(this._pickSP) ||
        useLogDepthChanged
      ) {
        vs = new ShaderSource({
          sources: [EllipsoidVS],
        });
        fs = new ShaderSource({
          sources: [this.material.shaderSource, EllipsoidFS],
          pickColorQualifier: "uniform",
        });
        if (this.onlySunLighting) {
          fs.defines.push("ONLY_SUN_LIGHTING");
        }
        if (!translucent && context.fragmentDepth) {
          fs.defines.push("WRITE_DEPTH");
        }
        if (this._useLogDepth) {
          vs.defines.push("LOG_DEPTH");
          fs.defines.push("LOG_DEPTH");
        }

        this._pickSP = ShaderProgram.replaceCache({
          context: context,
          shaderProgram: this._pickSP,
          vertexShaderSource: vs,
          fragmentShaderSource: fs,
          attributeLocations: attributeLocations,
        });

        pickCommand.vertexArray = this._va;
        pickCommand.renderState = this._rs;
        pickCommand.shaderProgram = this._pickSP;
        pickCommand.uniformMap = combine(
          combine(this._uniforms, this._pickUniforms),
          this.material._uniforms,
        );
        pickCommand.executeInClosestFrustum = translucent;
      }

      pickCommand.boundingVolume = this._boundingSphere;
      pickCommand.modelMatrix = this._computedModelMatrix;
      pickCommand.pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;

      commandList.push(pickCommand);
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see EllipsoidPrimitive#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * e = e && e.destroy();
   *
   * @see EllipsoidPrimitive#isDestroyed
   */
  destroy() {
    this._sp = this._sp && this._sp.destroy();
    this._pickSP = this._pickSP && this._pickSP.destroy();
    this._pickId = this._pickId && this._pickId.destroy();
    if (this._featureRenderer) {
      this._featureRenderer.destroy(this);
    }
    return destroyObject(this);
  }
}

function getVertexArray(context) {
  let vertexArray = context.cache.ellipsoidPrimitive_vertexArray;

  if (defined(vertexArray)) {
    return vertexArray;
  }

  const geometry = BoxGeometry.createGeometry(
    BoxGeometry.fromDimensions({
      dimensions: new Cartesian3(2.0, 2.0, 2.0),
      vertexFormat: VertexFormat.POSITION_ONLY,
    }),
  );

  vertexArray = VertexArray.fromGeometry({
    context: context,
    geometry: geometry,
    attributeLocations: attributeLocations,
    bufferUsage: BufferUsage.STATIC_DRAW,
    interleave: true,
  });

  context.cache.ellipsoidPrimitive_vertexArray = vertexArray;
  return vertexArray;
}

export default EllipsoidPrimitive;
