import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import EllipsoidGeometry from "../Core/EllipsoidGeometry.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import VertexFormat from "../Core/VertexFormat.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import AtmosphereCommon from "../Shaders/AtmosphereCommon.js";
import SkyAtmosphereCommon from "../Shaders/SkyAtmosphereCommon.js";
import SkyAtmosphereFS from "../Shaders/SkyAtmosphereFS.js";
import SkyAtmosphereVS from "../Shaders/SkyAtmosphereVS.js";
import Axis from "./Axis.js";
import BlendingState from "./BlendingState.js";
import CullFace from "./CullFace.js";
import SceneMode from "./SceneMode.js";

/**
 * An atmosphere drawn around the limb of the provided ellipsoid. Based on
 * {@link http://nishitalab.org/user/nis/cdrom/sig93_nis.pdf|Display of The Earth Taking Into Account Atmospheric Scattering}.
 * <p>
 * This is only supported in 3D. Atmosphere is faded out when morphing to 2D or Columbus view.
 * </p>
 *
 * @alias SkyAtmosphere
 *
 * @param {Ellipsoid} [ellipsoid=Ellipsoid.WGS84] The ellipsoid that the atmosphere is drawn around.
 *
 * @example
 * scene.skyAtmosphere = new Cesium.SkyAtmosphere();
 *
 * @see Scene.skyAtmosphere
 */
class SkyAtmosphere {
  constructor(ellipsoid) {
    ellipsoid = ellipsoid ?? Ellipsoid.WGS84;

    /**
     * Determines if the atmosphere is shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = true;

    /**
     * Compute atmosphere per-fragment instead of per-vertex.
     * This produces better looking atmosphere with a slight performance penalty.
     *
     * @type {boolean}
     * @default false
     */
    this.perFragmentAtmosphere = false;

    /**
     * Adds the precomputed multiple-scattering term to the sky color
     * (Hillaire 2020 / Bruneton multiple scattering). Single scattering alone
     * leaves the horizon and shadowed limb too dark; multiple scattering lifts
     * them toward a richer atmosphere. WebGPU only — the WebGL backend has no
     * compute path to bake the multiple-scattering LUT, so this flag is a no-op
     * there. Defaults to <code>false</code>, which is byte-identical to the
     * single-scattering sky.
     *
     * @type {boolean}
     * @default false
     */
    this.multipleScattering = false;

    /**
     * Replaces the per-pixel sky scattering march with a single sample of a
     * sun-relative sky-view LUT (Hillaire 2020). Unlike the legacy inscatter
     * LUT, the sky-view LUT carries a view&ndash;sun azimuth axis, so it is
     * correct at any view azimuth relative to the sun (warm near the sun,
     * cooler anti-sun) rather than only on the sun meridian. WebGPU only &mdash;
     * the WebGL backend has no compute path to bake the LUT, so this flag is a
     * no-op there. Defaults to <code>false</code>, which keeps the inline
     * scattering march (byte-identical to the non-LUT sky).
     *
     * @type {boolean}
     * @default false
     */
    this.useScatteringLut = false;

    /**
     * Adds ozone Chappuis-band absorption to the atmosphere (Bruneton/Hillaire
     * tent-profile, peaking near ~25&nbsp;km). Ozone is a pure absorber whose
     * green/red absorption deepens twilight toward a richer blue/violet zenith
     * &mdash; Rayleigh+Mie-only skies are too cyan at dusk. WebGPU only. Defaults
     * to <code>false</code>, where the ozone coefficient is zero so the bake and
     * the inline march are byte-identical to the non-ozone sky.
     *
     * @type {boolean}
     * @default false
     */
    this.ozone = false;

    /**
     * Replaces the single-parameter Henyey-Greenstein Mie phase with the
     * Jendersie &amp; d'Eon 2023 droplet (Draine) phase &mdash; a physically
     * grounded forward peak plus a soft back-scatter lobe, giving a more
     * realistic sun aureole and glory. WebGPU only. Defaults to
     * <code>false</code>, which keeps the exact historical HG phase
     * (byte-identical).
     *
     * @type {boolean}
     * @default false
     */
    this.improvedMiePhase = false;

    /**
     * Sums a second analytic moon-light scattering march into the inline
     * (parity) ray-march path so moonglow appears on a moonlit night sky. The
     * previous dual-light path only summed the moon inside the gated inscatter-
     * LUT fast-path (disabled by default), so the night inline sky was dark.
     * WebGPU only. Defaults to <code>false</code>, where the inline march stays
     * single-light (byte-identical to the sun-only sky).
     *
     * @type {boolean}
     * @default false
     */
    this.dualLightInline = false;

    this._ellipsoid = ellipsoid;

    const outerEllipsoidScale = 1.025;
    const scaleVector = Cartesian3.multiplyByScalar(
      ellipsoid.radii,
      outerEllipsoidScale,
      new Cartesian3(),
    );
    this._scaleMatrix = Matrix4.fromScale(scaleVector);
    this._modelMatrix = new Matrix4();

    this._command = new DrawCommand({
      owner: this,
      modelMatrix: this._modelMatrix,
    });
    this._spSkyFromSpace = undefined;
    this._spSkyFromAtmosphere = undefined;

    this._flags = undefined;

    // Per-frame eclipse dimming of the sky shell, refreshed from
    // `frameState.eclipseSceneLightFactor` at the top of `update()` (which
    // runs before both the WebGL uniform closure below and the WebGPU
    // feature renderer's uniform pack, so the two backends multiply one
    // identical scalar). 1.0 — the multiplicative identity — in every
    // non-eclipse frame, so the shell is byte-identical there.
    this._eclipseLightFactor = 1.0;

    // Per-frame 360-degree horizon-twilight gain, refreshed from
    // `frameState.eclipseHorizonTwilight` alongside the dimming factor above
    // and consumed by both shaders (`u_eclipseHorizonTwilight` in
    // `SkyAtmosphereFS.glsl`, `eclipseControl.x` in `SkyAtmosphere.wgsl`).
    // 0.0 — the additive identity, and the shader's early-out — in every
    // non-totality frame.
    this._eclipseHorizonTwilight = 0.0;

    /**
     * The intensity of the light that is used for computing the sky atmosphere color.
     *
     * @type {number}
     * @default 50.0
     */
    this.atmosphereLightIntensity = 50.0;

    /**
     * The Rayleigh scattering coefficient used in the atmospheric scattering equations for the sky atmosphere.
     *
     * @type {Cartesian3}
     * @default Cartesian3(5.5e-6, 13.0e-6, 28.4e-6)
     */
    this.atmosphereRayleighCoefficient = new Cartesian3(
      5.5e-6,
      13.0e-6,
      28.4e-6,
    );

    /**
     * The Mie scattering coefficient used in the atmospheric scattering equations for the sky atmosphere.
     *
     * @type {Cartesian3}
     * @default Cartesian3(21e-6, 21e-6, 21e-6)
     */
    this.atmosphereMieCoefficient = new Cartesian3(21e-6, 21e-6, 21e-6);

    /**
     * The Rayleigh scale height used in the atmospheric scattering equations for the sky atmosphere, in meters.
     *
     * @type {number}
     * @default 10000.0
     */
    this.atmosphereRayleighScaleHeight = 10000.0;

    /**
     * The Mie scale height used in the atmospheric scattering equations for the sky atmosphere, in meters.
     *
     * @type {number}
     * @default 3200.0
     */
    this.atmosphereMieScaleHeight = 3200.0;

    /**
     * The anisotropy of the medium to consider for Mie scattering.
     * <p>
     * Valid values are between -1.0 and 1.0.
     * </p>
     * @type {number}
     * @default 0.9
     */
    this.atmosphereMieAnisotropy = 0.9;

    /**
     * The hue shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A hue shift of 1.0 indicates a complete rotation of the hues available.
     * @type {number}
     * @default 0.0
     */
    this.hueShift = 0.0;

    /**
     * The saturation shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A saturation shift of -1.0 is monochrome.
     * @type {number}
     * @default 0.0
     */
    this.saturationShift = 0.0;

    /**
     * The brightness shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A brightness shift of -1.0 is complete darkness, which will let space show through.
     * @type {number}
     * @default 0.0
     */
    this.brightnessShift = 0.0;

    this._hueSaturationBrightness = new Cartesian3();

    // outer radius, inner radius, dynamic atmosphere color flag
    const radiiAndDynamicAtmosphereColor = new Cartesian3();

    radiiAndDynamicAtmosphereColor.x =
      ellipsoid.maximumRadius * outerEllipsoidScale;
    radiiAndDynamicAtmosphereColor.y = ellipsoid.maximumRadius;

    // The `DynamicAtmosphereLightingType` enum for this frame. Value 0 (NONE)
    // does not mean "treat the sun as always directly overhead" for the sky
    // shell — only the explicit LEGACY_OVERHEAD (3) does. The enum selects the
    // shell's light DIRECTION; it no longer gates the day/night alpha ramp,
    // which dots against whichever direction was selected. LEGACY_OVERHEAD is
    // inert in that ramp because its direction is the shell point itself.
    radiiAndDynamicAtmosphereColor.z = 0;

    this._radiiAndDynamicAtmosphereColor = radiiAndDynamicAtmosphereColor;

    const that = this;

    this._command.uniformMap = {
      u_radiiAndDynamicAtmosphereColor: function () {
        return that._radiiAndDynamicAtmosphereColor;
      },
      u_hsbShift: function () {
        that._hueSaturationBrightness.x = that.hueShift;
        that._hueSaturationBrightness.y = that.saturationShift;
        that._hueSaturationBrightness.z = that.brightnessShift;
        return that._hueSaturationBrightness;
      },
      u_atmosphereLightIntensity: function () {
        // Eclipse dimming. `_eclipseLightFactor` is 1.0 outside a solar
        // eclipse and `x * 1.0` is bit-exact, so this is the historical
        // value in every other frame.
        return that.atmosphereLightIntensity * that._eclipseLightFactor;
      },
      u_eclipseHorizonTwilight: function () {
        // 360-degree horizon twilight gain. Exactly 0.0 outside
        // the last ~2% of obscuration, and the shader multiplies the whole
        // term by it, so the historical sky is untouched.
        return that._eclipseHorizonTwilight;
      },
      u_atmosphereRayleighCoefficient: function () {
        return that.atmosphereRayleighCoefficient;
      },
      u_atmosphereMieCoefficient: function () {
        return that.atmosphereMieCoefficient;
      },
      u_atmosphereRayleighScaleHeight: function () {
        return that.atmosphereRayleighScaleHeight;
      },
      u_atmosphereMieScaleHeight: function () {
        return that.atmosphereMieScaleHeight;
      },
      u_atmosphereMieAnisotropy: function () {
        return that.atmosphereMieAnisotropy;
      },
    };
  }

  /**
   * Gets the ellipsoid the atmosphere is drawn around.
   *
   * @type {Ellipsoid}
   * @readonly
   */
  get ellipsoid() {
    return this._ellipsoid;
  }

  /**
   * Set the dynamic lighting enum value for the shader
   * @param {DynamicAtmosphereLightingType} lightingEnum The enum that determines the dynamic atmosphere light source
   *
   * @private
   */
  setDynamicLighting(lightingEnum) {
    this._radiiAndDynamicAtmosphereColor.z = lightingEnum;
  }

  /**
   * The dynamic-lighting enum `Scene.updateEnvironment` resolved for this
   * frame — `DynamicAtmosphereLightingType.fromGlobeFlags(globe)` when a globe
   * exists, `scene.atmosphere.dynamicLighting` otherwise. WebGL reads it
   * through `u_radiiAndDynamicAtmosphereColor.z`; the WebGPU feature renderer
   * reads it here — it previously re-resolved `scene.atmosphere.dynamicLighting`
   * itself and so never saw the globe flags, which back when the ramp was gated
   * on this enum left the WGSL shell's day/night alpha term permanently
   * disabled. The ramp no longer reads the enum, so the same mismatch now
   * surfaces as the wrong light direction and the wrong LUT eligibility
   * instead.
   *
   * @type {number}
   * @readonly
   * @internal
   */
  get dynamicLighting() {
    return this._radiiAndDynamicAtmosphereColor.z;
  }

  /**
   * @private
   */
  update(frameState, globe) {
    // Refreshed unconditionally, and first: it must be current before the
    // WebGPU feature-renderer branch below packs its uniform buffer and
    // before the WebGL uniform closure is invoked at draw time.
    this._eclipseLightFactor = frameState.eclipseSceneLightFactor ?? 1.0;
    // Same contract, same position, same reason.
    this._eclipseHorizonTwilight = frameState.eclipseHorizonTwilight ?? 0.0;

    if (!this.show) {
      return undefined;
    }

    const mode = frameState.mode;
    if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
      return undefined;
    }

    // The atmosphere is only rendered during the render pass; it is not pickable, it doesn't cast shadows, etc.
    if (!frameState.passes.render) {
      return undefined;
    }

    // Backend-specific path — delegate to the feature renderer if available.
    // Environment commands are return-only: Scene publishes this command on
    // environmentState, where visibility/readiness is resolved once, and the
    // renderer injects it into the farthest ENVIRONMENT pass. Do not also bin
    // it through frameState.commandList — that second route bypasses
    // isSkyAtmosphereVisible while the globe is not ready and makes the shell
    // render on WebGPU when WebGL correctly skips it.
    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.SKY_ATMOSPHERE,
    );
    if (fr) {
      return fr.update(this, frameState);
    }

    // Align the ellipsoid geometry so it always faces the same direction as the
    // camera to reduce artifacts when rendering atmosphere per-vertex
    const rotationMatrix = Matrix4.fromRotationTranslation(
      frameState.context.uniformState.inverseViewRotation,
      Cartesian3.ZERO,
      scratchModelMatrix,
    );
    const rotationOffsetMatrix = Matrix4.multiplyTransformation(
      rotationMatrix,
      Axis.Y_UP_TO_Z_UP,
      scratchModelMatrix,
    );
    const modelMatrix = Matrix4.multiply(
      this._scaleMatrix,
      rotationOffsetMatrix,
      scratchModelMatrix,
    );
    Matrix4.clone(modelMatrix, this._modelMatrix);

    const context = frameState.context;

    const colorCorrect = hasColorCorrection(this);
    const translucent = frameState.globeTranslucencyState.translucent;
    const perFragmentAtmosphere =
      this.perFragmentAtmosphere ||
      translucent ||
      !defined(globe) ||
      !globe.show;

    const command = this._command;

    if (!defined(command.vertexArray)) {
      const geometry = EllipsoidGeometry.createGeometry(
        new EllipsoidGeometry({
          radii: new Cartesian3(1.0, 1.0, 1.0),
          slicePartitions: 256,
          stackPartitions: 256,
          vertexFormat: VertexFormat.POSITION_ONLY,
        }),
      );
      command.vertexArray = VertexArray.fromGeometry({
        context: context,
        geometry: geometry,
        attributeLocations: GeometryPipeline.createAttributeLocations(geometry),
        bufferUsage: BufferUsage.STATIC_DRAW,
      });
      command.renderState = RenderState.fromCache({
        cull: {
          enabled: true,
          face: CullFace.FRONT,
        },
        blending: BlendingState.ALPHA_BLEND,
        depthMask: false,
      });
    }

    const flags =
      colorCorrect | (perFragmentAtmosphere << 2) | (translucent << 3);

    if (flags !== this._flags) {
      this._flags = flags;

      const defines = [];

      if (colorCorrect) {
        defines.push("COLOR_CORRECT");
      }

      if (perFragmentAtmosphere) {
        defines.push("PER_FRAGMENT_ATMOSPHERE");
      }

      if (translucent) {
        defines.push("GLOBE_TRANSLUCENT");
      }

      const vs = new ShaderSource({
        defines: defines,
        sources: [AtmosphereCommon, SkyAtmosphereCommon, SkyAtmosphereVS],
      });

      const fs = new ShaderSource({
        defines: defines,
        sources: [AtmosphereCommon, SkyAtmosphereCommon, SkyAtmosphereFS],
      });

      this._spSkyAtmosphere = ShaderProgram.fromCache({
        context: context,
        vertexShaderSource: vs,
        fragmentShaderSource: fs,
      });

      command.shaderProgram = this._spSkyAtmosphere;
    }

    return command;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see SkyAtmosphere#destroy
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
   * skyAtmosphere = skyAtmosphere && skyAtmosphere.destroy();
   *
   * @see SkyAtmosphere#isDestroyed
   */
  destroy() {
    const command = this._command;
    command.vertexArray = command.vertexArray && command.vertexArray.destroy();
    this._spSkyAtmosphere =
      this._spSkyAtmosphere && this._spSkyAtmosphere.destroy();
    return destroyObject(this);
  }
}

const scratchModelMatrix = new Matrix4();

function hasColorCorrection(skyAtmosphere) {
  return !(
    CesiumMath.equalsEpsilon(
      skyAtmosphere.hueShift,
      0.0,
      CesiumMath.EPSILON7,
    ) &&
    CesiumMath.equalsEpsilon(
      skyAtmosphere.saturationShift,
      0.0,
      CesiumMath.EPSILON7,
    ) &&
    CesiumMath.equalsEpsilon(
      skyAtmosphere.brightnessShift,
      0.0,
      CesiumMath.EPSILON7,
    )
  );
}

export default SkyAtmosphere;
